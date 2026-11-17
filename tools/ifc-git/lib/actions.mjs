/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The built-in `uses: ifc-lite/<name>` actions. Each maps one workflow step
 * onto one ifc-lite command and turns its exit code and JSON into a step
 * result: { status, summary, outputs, annotations, artifacts }.
 *
 * Status is one of `success`, `failure` (the check ran and found something)
 * or `error` (the check could not run). The two are never folded together:
 * a model that cannot be read is not a passing model, and a clash rule that
 * matched no elements checked nothing.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { extractBlob, fileExistsAt } from './git.mjs';
import { ifcLite, parseJson } from './ifc-lite.mjs';
import { materializeFederation } from './federation.mjs';

const MAX_ANNOTATIONS = 25;

function list(v) {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap(list);
  return String(v).split(/\s+/).filter(Boolean);
}

function required(input, key, action) {
  const v = input[key];
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
    throw new Error(`ifc-lite/${action}: "with.${key}" is required`);
  }
  return v;
}

function worst(statuses) {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('failure')) return 'failure';
  return 'success';
}

function result(status, summary, extra = {}) {
  return { status, summary, outputs: {}, annotations: [], artifacts: [], ...extra };
}

function keepArtifact(ctx, path) {
  if (!existsSync(path)) return null;
  const dest = join(ctx.artifactDir, basename(path));
  copyFileSync(path, dest);
  return dest;
}

const actions = {
  validate(ctx, input) {
    const models = list(required(input, 'model', 'validate'));
    const statuses = [];
    const annotations = [];
    let errors = 0;
    let warnings = 0;
    for (const model of models) {
      const r = ifcLite(['validate', model, '--json'], { cwd: ctx.workspace });
      let report;
      try { report = parseJson(r, `validate ${model}`); } catch (e) {
        statuses.push('error');
        annotations.push({ level: 'error', file: model, message: e.message });
        continue;
      }
      errors += report.errors;
      warnings += report.warnings;
      statuses.push(report.errors > 0 ? 'failure' : 'success');
      for (const issue of report.issues ?? []) {
        if (issue.severity === 'info') continue;
        annotations.push({ level: issue.severity === 'error' ? 'error' : 'warning', file: model, message: issue.message });
      }
    }
    return result(worst(statuses), `${models.length} model(s): ${errors} error(s), ${warnings} warning(s)`, {
      outputs: { errors, warnings }, annotations: annotations.slice(0, MAX_ANNOTATIONS),
    });
  },

  ids(ctx, input) {
    const models = list(required(input, 'model', 'ids'));
    const specs = list(required(input, 'ids', 'ids'));
    const statuses = [];
    const annotations = [];
    let failedSpecs = 0;
    let failedEntities = 0;
    for (const model of models) {
      for (const spec of specs) {
        const r = ifcLite(['ids', model, spec, '--json'], { cwd: ctx.workspace });
        let doc;
        try { doc = parseJson(r, `ids ${model}`); } catch (e) {
          statuses.push('error');
          annotations.push({ level: 'error', file: model, message: e.message });
          continue;
        }
        const s = doc.summary;
        failedSpecs += s.failedSpecifications;
        failedEntities += s.failedEntities;
        statuses.push(r.code === 0 ? 'success' : r.code === 1 ? 'failure' : 'error');
        for (const spec of doc.report?.specificationResults ?? []) {
          for (const e of spec.entityResults ?? []) {
            if (e.passed) continue;
            const why = (e.requirementResults ?? []).find((q) => q.status === 'fail');
            annotations.push({
              level: 'error', file: model, entity: e.globalId,
              message: `${spec.specification.name}: ${e.entityType} "${e.entityName ?? ''}" (${e.globalId}) — ${why?.checkedDescription ?? 'requirement not met'}`,
            });
          }
        }
      }
    }
    return result(worst(statuses), `${failedSpecs} failed specification(s), ${failedEntities} failing element(s)`, {
      outputs: { failedSpecifications: failedSpecs, failedEntities }, annotations: annotations.slice(0, MAX_ANNOTATIONS),
    });
  },

  clash(ctx, input) {
    const model = String(required(input, 'model', 'clash'));
    const args = ['clash', model, '--json'];
    if (input.matrix) args.push('--matrix');
    for (const [key, flag] of [['a', '--a'], ['b', '--b'], ['mode', '--mode'], ['tolerance', '--tolerance'], ['clearance', '--clearance']]) {
      if (input[key] !== undefined) args.push(flag, String(input[key]));
    }
    const artifacts = [];
    const bcf = input.bcf ? resolve(ctx.workspace, String(input.bcf)) : null;
    if (bcf) args.push('--bcf', bcf);
    const r = ifcLite(args, { cwd: ctx.workspace });
    let doc;
    try { doc = parseJson(r, 'clash'); } catch (e) { return result('error', e.message); }
    if (bcf) { const kept = keepArtifact(ctx, bcf); if (kept) artifacts.push(kept); }
    const total = doc.summary?.total ?? 0;
    const allowed = Number(input['max-clashes'] ?? 0);
    const annotations = (doc.clashes ?? []).slice(0, MAX_ANNOTATIONS).map((c) => ({
      level: 'error', file: model, entity: c.a.key,
      message: `${c.a.tag} "${c.a.name ?? ''}" × ${c.b.tag} "${c.b.name ?? ''}" (${c.a.key} / ${c.b.key})`,
    }));
    if (doc.ruleCoverageOutcome !== 'clean' && !input['allow-empty-rules']) {
      return result('error', `clash rules matched no elements (${doc.ruleCoverageOutcome}): nothing was checked`, { artifacts });
    }
    const status = total > allowed ? 'failure' : 'success';
    return result(status, `${total} clash(es)${allowed ? `, ${allowed} allowed` : ''}`, {
      outputs: { clashes: total }, annotations, artifacts,
    });
  },

  check(ctx, input) {
    const models = list(required(input, 'model', 'check'));
    const rules = String(required(input, 'rules', 'check'));
    const args = ['check', ...models, '--rules', rules, '--format', 'json'];
    if (input['fail-on']) args.push('--fail-on', String(input['fail-on']));
    const r = ifcLite(args, { cwd: ctx.workspace });
    let doc;
    try { doc = parseJson(r, 'check'); } catch (e) { return result('error', e.message); }
    const s = doc.summary ?? {};
    const annotations = [];
    for (const spec of doc.specificationResults ?? []) {
      for (const e of spec.entityResults ?? []) {
        if (!e.passed) annotations.push({ level: 'error', entity: e.globalId, message: `${spec.specification?.name ?? 'rule'}: ${e.entityType ?? ''} "${e.entityName ?? ''}" (${e.globalId ?? e.expressId})` });
      }
    }
    const status = r.code === 0 ? 'success' : r.code === 1 ? 'failure' : 'error';
    return result(status, `${s.passedSpecifications ?? 0}/${s.totalSpecifications ?? 0} rule(s) passed`, {
      outputs: { failedRules: s.failedSpecifications ?? 0 }, annotations: annotations.slice(0, MAX_ANNOTATIONS),
    });
  },

  delivery(ctx, input) {
    const recipe = String(required(input, 'recipe', 'delivery'));
    const html = join(ctx.artifactDir, 'delivery-report.html');
    const r = ifcLite(['delivery', recipe, '--json', '--html', html], { cwd: ctx.workspace });
    let doc;
    try { doc = parseJson(r, 'delivery'); } catch (e) { return result('error', e.message); }
    const annotations = (doc.checks ?? []).filter((c) => c.status !== 'pass').map((c) => ({
      level: c.status === 'fail' ? 'error' : 'warning', file: c.model,
      message: `${c.type}${c.source ? ` (${c.source})` : ''}: ${c.status}`,
    }));
    return result(doc.verdict === 'pass' ? 'success' : 'failure', `verdict: ${doc.verdict}`, {
      annotations: annotations.slice(0, MAX_ANNOTATIONS), artifacts: existsSync(html) ? [html] : [],
    });
  },

  diff(ctx, input) {
    const models = list(required(input, 'model', 'diff'));
    const against = input.against ?? ctx.event.compareBase;
    if (!against) return result('success', 'no earlier revision to compare against', { outputs: { added: 0, modified: 0, deleted: 0 } });
    const tmp = mkdtempSync(join(tmpdir(), 'ifc-git-diff-'));
    const totals = { added: 0, modified: 0, deleted: 0, renamed: 0 };
    const annotations = [];
    const lines = [];
    try {
      for (const model of models) {
        if (!fileExistsAt(ctx.repo, against, model)) { lines.push(`${model}: new model`); continue; }
        const old = join(tmp, `base-${basename(model)}`);
        extractBlob(ctx.repo, against, model, old);
        const args = ['diff', old, model, '--by-content', '--json', '--changes'];
        if (input.geometry) args.push('--geometry');
        const r = ifcLite(args, { cwd: ctx.workspace });
        const doc = parseJson(r, `diff ${model}`);
        const renamed = (doc.contentMatches ?? []).filter((m) => m.kind === 'renamed').length;
        totals.added += doc.counts.added; totals.modified += doc.counts.modified;
        totals.deleted += doc.counts.deleted; totals.renamed += renamed;
        lines.push(`${model}: +${doc.counts.added} ~${doc.counts.modified} -${doc.counts.deleted}${renamed ? ` (${renamed} re-GUIDed, matched by content)` : ''}`);
        for (const c of doc.changes ?? []) {
          annotations.push({ level: c.state === 'deleted' ? 'warning' : 'notice', file: model, entity: c.key,
            message: `${c.state} ${c.ifcType} ${c.key}${c.changedComponents?.length ? ` [${c.changedComponents.join(', ')}]` : ''}` });
        }
      }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    let status = 'success';
    if (input['fail-on-deleted'] && totals.deleted > 0) status = 'failure';
    return result(status, lines.join('; ') || 'no models compared', { outputs: totals, annotations: annotations.slice(0, MAX_ANNOTATIONS) });
  },

  federate(ctx, input) {
    const out = String(input.out ?? 'federated.ifc');
    const models = list(input.model);
    if (input['from-lock']) models.push(...materializeFederation(ctx.repo, ctx.workspace, ctx.event.sha));
    if (models.length < 2) throw new Error('ifc-lite/federate: needs at least two models (with.model and/or with.from-lock)');
    const args = ['merge', ...models, '--out', out, '--json'];
    if (input['unit-reconciliation']) args.push('--unit-reconciliation', String(input['unit-reconciliation']));
    const r = ifcLite(args, { cwd: ctx.workspace });
    if (r.code !== 0) return result('error', `merge failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
    const kept = keepArtifact(ctx, resolve(ctx.workspace, out));
    return result('success', `federated ${models.length} model(s) into ${out}`, {
      outputs: { path: out, models: models.join(' ') }, artifacts: kept ? [kept] : [],
    });
  },
};

export const ACTION_NAMES = Object.keys(actions);

/** Run `uses: ifc-lite/<name>`; an unknown action is a workflow error, not a skipped step. */
export function runAction(uses, ctx, input) {
  const m = /^ifc-lite\/([a-z-]+)(?:@.+)?$/.exec(String(uses));
  if (!m || !actions[m[1]]) {
    throw new Error(`unknown action "${uses}" (available: ${ACTION_NAMES.map((n) => `ifc-lite/${n}`).join(', ')})`);
  }
  return actions[m[1]](ctx, input ?? {});
}
