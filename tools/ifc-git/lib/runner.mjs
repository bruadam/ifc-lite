/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Runs workflows for one event, the way a CI service does:
 *
 * - each job runs in its own throwaway worktree of the event's commit, so
 *   jobs cannot see each other's files and the user's checkout is untouched;
 * - jobs run in `needs` order; a job whose dependency did not succeed is
 *   skipped unless its `if:` asks for `always()` or `failure()`;
 * - `strategy.matrix` expands a job into one variant per combination, and an
 *   empty matrix (no changed models, say) skips the job rather than passing it;
 * - every job records a check result against the commit, under the name
 *   `<workflow-file>/<job-id>`, which is what branch protection requires.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAction } from './actions.mjs';
import { condition, interpolate } from './expr.mjs';
import { tempWorktree } from './git.mjs';
import { ifcLiteShell } from './ifc-lite.mjs';
import { loadProject, loadWorkflows, triggers } from './workflows.mjs';

const ICON = { success: '✔', failure: '✖', error: '⚠', skipped: '○' };

function worst(statuses) {
  for (const s of ['error', 'failure', 'success']) if (statuses.includes(s)) return s;
  return 'skipped';
}

function topoOrder(jobs) {
  const order = [];
  const seen = new Set();
  const visit = (id, stack = []) => {
    if (seen.has(id)) return;
    if (stack.includes(id)) throw new Error(`job dependency cycle: ${[...stack, id].join(' → ')}`);
    for (const n of [].concat(jobs[id].needs ?? [])) visit(n, [...stack, id]);
    seen.add(id);
    order.push(id);
  };
  Object.keys(jobs).forEach((id) => visit(id));
  return order;
}

function expandMatrix(matrix, ctx) {
  if (!matrix) return [null];
  let combos = [{}];
  for (const [key, raw] of Object.entries(matrix)) {
    const values = interpolate(raw, ctx);
    const list = Array.isArray(values) ? values : [values];
    combos = combos.flatMap((c) => list.map((v) => ({ ...c, [key]: v })));
  }
  return combos;
}

function shimDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ifc-git-bin-'));
  const shim = join(dir, 'ifc-lite');
  writeFileSync(shim, `#!/bin/sh\nexec ${ifcLiteShell()} "$@"\n`);
  chmodSync(shim, 0o755);
  return dir;
}

function runShell(script, cwd, env, binDir) {
  const outputFile = join(binDir, `outputs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(outputFile, '');
  const r = spawnSync('/bin/sh', ['-ec', script], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000,
    env: { ...process.env, ...env, PATH: `${binDir}:${process.env.PATH}`, IFC_GIT_OUTPUT: outputFile, NO_COLOR: '1' },
  });
  const outputs = {};
  for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
  const lastLine = text.split('\n').filter(Boolean).pop() ?? '';
  return {
    status: r.status === 0 ? 'success' : 'failure',
    summary: r.status === 0 ? lastLine : `exit ${r.status ?? 'timeout'}: ${lastLine}`,
    outputs, annotations: [], artifacts: [], log: text.slice(-4000),
  };
}

function baseContext(forge, event, workflow) {
  const project = loadProject(forge.root, event.sha);
  const ifc = event.changed.filter((p) => /\.ifc$/i.test(p));
  return {
    event: event.name, ref: event.branch, branch: event.branch, sha: event.sha,
    changed: { files: event.changed, ifc },
    project, pr: event.pr ?? null,
    env: { ...workflow.env }, needs: {}, steps: {}, matrix: {},
  };
}

function runVariant(forge, event, workflow, jobId, job, ctx, artifactDir, binDir) {
  const steps = [];
  const wt = tempWorktree(forge.root, event.sha);
  try {
    for (const [n, step] of job.steps.entries()) {
      const name = step.name ?? step.id ?? (step.uses ? String(step.uses) : `run ${n + 1}`);
      // A step sees "failure" once any earlier step failed or errored.
      const failedBefore = steps.some((s) => s.status === 'failure' || s.status === 'error');
      const sctx = { ...ctx, __status: failedBefore ? 'failure' : 'success' };
      let res;
      try {
        if (!condition(step.if, sctx)) {
          res = { status: 'skipped', summary: 'condition not met', outputs: {}, annotations: [], artifacts: [] };
        } else if (step.uses) {
          const input = interpolate(step.with ?? {}, sctx);
          res = runAction(step.uses, { workspace: wt.dir, repo: forge.root, event, artifactDir }, input);
        } else {
          const env = Object.fromEntries(Object.entries(interpolate({ ...ctx.env, ...job.env, ...step.env }, sctx)).map(([k, v]) => [k, String(v)]));
          res = runShell(interpolate(String(step.run), sctx), wt.dir, {
            ...env, IFC_GIT_EVENT: event.name, IFC_GIT_BRANCH: event.branch, IFC_GIT_SHA: event.sha,
            IFC_GIT_BASE: event.compareBase ?? '', IFC_GIT_REPO: forge.root, IFC_GIT_ARTIFACTS: artifactDir,
          }, binDir);
        }
      } catch (e) {
        res = { status: 'error', summary: e.message, outputs: {}, annotations: [], artifacts: [] };
      }
      if (res.status !== 'success' && res.status !== 'skipped' && step['continue-on-error']) {
        res = { ...res, summary: `${res.summary} (continue-on-error)`, status: 'success', continued: res.status };
      }
      steps.push({ name, uses: step.uses, run: step.run ? String(step.run) : undefined, ...res });
      if (step.id) ctx.steps[step.id] = { outputs: res.outputs, outcome: res.status };
    }
  } finally { wt.remove(); }
  const ran = steps.filter((s) => s.status !== 'skipped').map((s) => s.status);
  return { status: ran.length ? worst(ran) : 'skipped', steps };
}

function printJob(log, job) {
  const label = job.matrix ? `${job.id} (${Object.values(job.matrix).join(', ')})` : job.id;
  const last = job.steps.filter((s) => s.status !== 'skipped').pop();
  log(`  ${ICON[job.status]} ${label}${job.reason ? `  — ${job.reason}` : last ? `  — ${last.summary}` : ''}`);
  for (const s of job.steps) {
    if (s.status === 'failure' || s.status === 'error' || (s.continued && s.continued !== 'success')) {
      log(`      ${ICON[s.continued ?? s.status]} ${s.name}: ${s.summary}`);
      for (const a of s.annotations.slice(0, 6)) log(`          · ${a.message}`);
      if (s.annotations.length > 6) log(`          · … ${s.annotations.length - 6} more`);
    }
  }
}

/** Run one workflow for `event`; returns the stored run record. */
export function runWorkflow(forge, event, workflow, { log = console.log } = {}) {
  const id = forge.nextId('run');
  const run = {
    id, workflow: workflow.id, name: workflow.name, event: event.name, branch: event.branch,
    sha: event.sha, checkSha: event.checkSha, context: event.context, pr: event.pr?.number ?? null,
    startedAt: new Date().toISOString(), jobs: [],
  };
  log(`▶ ${workflow.name}  [${workflow.file}]  ${event.name}${event.pr ? ` #${event.pr.number}` : ''} on ${event.branch} @ ${event.sha.slice(0, 8)}`);
  const ctx = baseContext(forge, event, workflow);
  const binDir = shimDir();
  const results = {};
  try {
    for (const jobId of topoOrder(workflow.jobs)) {
      const job = workflow.jobs[jobId];
      const needs = [].concat(job.needs ?? []);
      ctx.needs = Object.fromEntries(needs.map((n) => [n, results[n]]));
      const needStatus = worst(needs.map((n) => results[n].result));
      const jctx = { ...ctx, __status: needs.length === 0 || needStatus === 'success' || needStatus === 'skipped' ? 'success' : 'failure' };
      const checkName = `${workflow.id}/${jobId}`;
      const record = (entry) => { run.jobs.push(entry); printJob(log, entry); };
      let variants;
      try {
        if (!condition(job.if, jctx)) {
          record({ id: jobId, checkName, status: 'skipped', reason: needs.length && jctx.__status !== 'success' ? 'a needed job did not succeed' : 'condition not met', steps: [] });
          results[jobId] = { result: 'skipped', outputs: {} };
          continue;
        }
        variants = expandMatrix(job.strategy?.matrix, jctx);
      } catch (e) {
        record({ id: jobId, checkName, status: 'error', reason: e.message, steps: [] });
        results[jobId] = { result: 'error', outputs: {} };
        continue;
      }
      if (variants.length === 0) {
        record({ id: jobId, checkName, status: 'skipped', reason: 'matrix is empty (nothing to check)', steps: [] });
        results[jobId] = { result: 'skipped', outputs: {} };
        continue;
      }
      const statuses = [];
      for (const matrix of variants) {
        const vctx = { ...jctx, matrix: matrix ?? {}, steps: {} };
        const artifactDir = forge.artifactDir(`${id}/${jobId}${matrix ? `-${statuses.length + 1}` : ''}`);
        const out = runVariant(forge, event, workflow, jobId, job, vctx, artifactDir, binDir);
        statuses.push(out.status);
        record({ id: jobId, checkName, matrix, status: out.status, steps: out.steps });
      }
      results[jobId] = { result: worst(statuses), outputs: {} };
    }
  } finally { rmSync(binDir, { recursive: true, force: true }); }
  run.finishedAt = new Date().toISOString();
  run.conclusion = worst(run.jobs.map((j) => j.status));
  forge.saveRun(run);
  const byCheck = {};
  for (const j of run.jobs) (byCheck[j.checkName] ??= []).push(j.status);
  for (const [name, statuses] of Object.entries(byCheck)) {
    forge.recordCheck(event.checkSha, event.context, name, { status: worst(statuses), runId: id, at: run.finishedAt });
  }
  return run;
}

/** Run every workflow that `event` triggers. Workflows come from the event's commit. */
export function runEvent(forge, event, opts = {}) {
  const log = opts.log ?? console.log;
  let workflows;
  try { workflows = loadWorkflows(forge.root, event.sha); } catch (e) {
    log(`  ⚠ workflows could not be loaded: ${e.message}`);
    forge.recordCheck(event.checkSha, event.context, 'workflows', { status: 'error', reason: e.message });
    return [];
  }
  const matching = workflows.filter((w) => triggers(w, event));
  if (matching.length === 0) log(`  (no workflow triggered by ${event.name} on ${event.branch})`);
  return matching.map((w) => runWorkflow(forge, event, w, { log }));
}

export { worst };
export const _test = { expandMatrix, topoOrder };
