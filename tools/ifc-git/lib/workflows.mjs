/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Workflow and repository configuration, always read from a commit rather
 * than the working tree. A pull request runs the workflows of its merge
 * preview, but branch protection is read from the base branch's tip, so a
 * pull request cannot weaken the rules that gate it.
 */

import { parse } from 'yaml';
import { fileExistsAt, listFiles, readTextAt } from './git.mjs';
import { matchesFilters } from './glob.mjs';

export const CONFIG_DIR = '.ifc-git';
const EVENTS = new Set(['push', 'pull_request', 'workflow_dispatch']);

function asList(v) {
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

/** Normalize `on:` (a string, a list, or a map) to `{ event: filters }`. */
export function normalizeOn(on) {
  if (typeof on === 'string') on = [on];
  if (Array.isArray(on)) on = Object.fromEntries(on.map((e) => [e, {}]));
  if (!on || typeof on !== 'object') throw new Error('workflow has no "on:" triggers');
  const out = {};
  for (const [event, filters] of Object.entries(on)) {
    if (!EVENTS.has(event)) throw new Error(`unsupported trigger "${event}" (use push, pull_request or workflow_dispatch)`);
    const f = filters ?? {};
    out[event] = {
      branches: asList(f.branches),
      branchesIgnore: asList(f['branches-ignore']),
      paths: asList(f.paths),
      pathsIgnore: asList(f['paths-ignore']),
    };
  }
  return out;
}

function validateJobs(file, jobs) {
  if (!jobs || typeof jobs !== 'object' || Object.keys(jobs).length === 0) {
    throw new Error(`${file}: workflow declares no jobs`);
  }
  for (const [id, job] of Object.entries(jobs)) {
    if (!Array.isArray(job?.steps) || job.steps.length === 0) throw new Error(`${file}: job "${id}" has no steps`);
    for (const need of asList(job.needs) ?? []) {
      if (!jobs[need]) throw new Error(`${file}: job "${id}" needs unknown job "${need}"`);
    }
    job.steps.forEach((step, n) => {
      if (!step || (step.uses === undefined) === (step.run === undefined)) {
        throw new Error(`${file}: job "${id}" step ${n + 1} must have exactly one of "uses" or "run"`);
      }
    });
  }
}

/** Every workflow under `.ifc-git/workflows/` at `rev`, parsed and validated. */
export function loadWorkflows(cwd, rev) {
  return listFiles(cwd, rev, `${CONFIG_DIR}/workflows`)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((file) => {
      const doc = parse(readTextAt(cwd, rev, file));
      const id = file.split('/').pop().replace(/\.ya?ml$/, '');
      validateJobs(file, doc?.jobs);
      return { id, file, name: doc.name ?? id, on: normalizeOn(doc.on), env: doc.env ?? {}, jobs: doc.jobs };
    });
}

/** Does `workflow` run for `event` ({ name, branch, changed })? */
export function triggers(workflow, event) {
  const f = workflow.on[event.name];
  if (!f) return false;
  if (event.name === 'workflow_dispatch') return true;
  if (!matchesFilters(f.branches, event.branch)) return false;
  if (f.branchesIgnore && matchesFilters(f.branchesIgnore, event.branch)) return false;
  if (f.paths || f.pathsIgnore) {
    const relevant = event.changed.filter((p) => matchesFilters(f.paths, p)
      && !(f.pathsIgnore && matchesFilters(f.pathsIgnore, p)));
    if (relevant.length === 0) return false;
  }
  return true;
}

function readYaml(cwd, rev, file, fallback) {
  return rev && fileExistsAt(cwd, rev, file) ? parse(readTextAt(cwd, rev, file)) ?? fallback : fallback;
}

/** `.ifc-git/project.yml`: name, discipline and the models this repository delivers. */
export function loadProject(cwd, rev) {
  const p = readYaml(cwd, rev, `${CONFIG_DIR}/project.yml`, {});
  return { name: p.name ?? null, discipline: p.discipline ?? null, models: asList(p.models) ?? [], ...p };
}

/**
 * The protection rule for `branch`, from `.ifc-git/protection.yml` at `rev`.
 * The first pattern that matches wins, as on GitHub.
 */
export function protectionFor(cwd, rev, branch) {
  const doc = readYaml(cwd, rev, `${CONFIG_DIR}/protection.yml`, {});
  for (const [pattern, rule] of Object.entries(doc.branches ?? {})) {
    if (matchesFilters([pattern], branch)) {
      return {
        pattern,
        requirePullRequest: rule.require_pull_request ?? true,
        requiredChecks: asList(rule.required_checks) ?? [],
        requiredApprovals: Number(rule.required_approvals ?? 0),
        dismissStaleApprovals: rule.dismiss_stale_approvals ?? true,
        blockOnSemanticConflicts: rule.block_on_semantic_conflicts ?? true,
      };
    }
  }
  return null;
}
