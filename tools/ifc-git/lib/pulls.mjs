/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pull requests: a proposal to move one branch's deliveries into another,
 * gated by checks, approvals and semantic conflict analysis.
 *
 * Sync builds a merge preview (`refs/ifc-git/pull/<n>/merge`, like a hosted
 * forge's test merge), summarises what each changed IFC model gains and
 * loses through the ifc-lite diff engine, and runs the `on: pull_request`
 * workflows against the preview. Merging fast-forwards the base branch to
 * that exact preview, so what was checked is what lands.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOT, advanceBranch, changedFiles, extractBlob, fileExistsAt, git, identityEnv, mergeBase, revParse, tempWorktree } from './git.mjs';
import { analyzePath } from './conflicts.mjs';
import { LOCK, lockChanges } from './federation.mjs';
import { ifcLite, parseJson } from './ifc-lite.mjs';
import { pushBranch } from './push.mjs';
import { runEvent, worst } from './runner.mjs';
import { protectionFor } from './workflows.mjs';

const isIfc = (p) => /\.ifc$/i.test(p);
const now = () => new Date().toISOString();

function note(pr, type, text, extra = {}) {
  pr.timeline.push({ at: now(), type, text, ...extra });
}

function tipOf(forge, branch) {
  return forge.pushedTip(branch) ?? revParse(forge.root, `refs/heads/${branch}`);
}

/** What each changed IFC model gains and loses on this pull request. */
function semanticChanges(root, ancestor, head, paths) {
  const dir = mkdtempSync(join(tmpdir(), 'ifc-git-pr-'));
  try {
    return paths.filter(isIfc).map((path) => {
      if (!fileExistsAt(root, head, path)) return { path, status: 'deleted' };
      if (!fileExistsAt(root, ancestor, path)) return { path, status: 'added' };
      const a = join(dir, 'a.ifc');
      const b = join(dir, 'b.ifc');
      extractBlob(root, ancestor, path, a);
      extractBlob(root, head, path, b);
      const doc = parseJson(ifcLite(['diff', a, b, '--by-content', '--json', '--changes'], { cwd: dir }), `diff ${path}`);
      return { path, status: 'modified', counts: doc.counts, contentMatches: doc.contentMatches ?? [], changes: doc.changes ?? [] };
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * For a coordination repository: what each moved pin changes in the pinned
 * model, compared inside the project's own repository. This is the bump's
 * "release notes", element by element.
 */
function pinnedChanges(root, ancestor, head) {
  if (!changedFiles(root, ancestor, head).includes(LOCK)) return [];
  const dir = mkdtempSync(join(tmpdir(), 'ifc-git-pin-'));
  try {
    return lockChanges(root, ancestor, head).map((c) => {
      const path = `${c.project}:${c.path}`;
      if (!c.fromBlob) return { path, status: 'added', pin: { from: null, to: c.toSha } };
      const a = join(dir, 'a.ifc');
      const b = join(dir, 'b.ifc');
      writeFileSync(a, git(['cat-file', 'blob', c.fromBlob], { cwd: c.repo, binary: true }));
      writeFileSync(b, git(['cat-file', 'blob', c.toBlob], { cwd: c.repo, binary: true }));
      const doc = parseJson(ifcLite(['diff', a, b, '--by-content', '--json', '--changes'], { cwd: dir }), `diff ${path}`);
      return { path, status: 'modified', pin: { from: c.fromSha, to: c.toSha }, counts: doc.counts, contentMatches: doc.contentMatches ?? [], changes: doc.changes ?? [] };
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** IFC files both sides changed to different bytes: git must not merge these textually. */
function bothChanged(root, ancestor, head, base) {
  const ours = new Set(changedFiles(root, ancestor, head).filter(isIfc));
  return changedFiles(root, ancestor, base).filter((p) => ours.has(p)).filter((p) => {
    const blob = (rev) => git(['rev-parse', `${rev}:${p}`], { cwd: root, allowFail: true }).stdout?.trim();
    return blob(head) !== blob(base);
  });
}

function buildPreview(forge, pr, headSha, baseSha, ancestor) {
  const contested = bothChanged(forge.root, ancestor, headSha, baseSha);
  if (contested.length) {
    return { sha: null, mergeable: false, conflicts: contested.map((path) => analyzePath(forge.root, path, { ancestor, ours: headSha, theirs: baseSha })) };
  }
  const wt = tempWorktree(forge.root, baseSha);
  try {
    const msg = `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`;
    const r = git(['merge', '--no-ff', '-q', '-m', msg, headSha], { cwd: wt.dir, allowFail: true, env: { ...identityEnv(BOT), IFC_GIT_INTERNAL: '1' } });
    if (!r.ok) {
      const files = git(['diff', '--name-only', '--diff-filter=U'], { cwd: wt.dir }).split('\n').filter(Boolean);
      git(['merge', '--abort'], { cwd: wt.dir, allowFail: true });
      return { sha: null, mergeable: false, conflicts: files.map((path) => ({ path, verdict: 'conflict', reason: 'textual conflict (not an IFC model)', conflicts: [] })) };
    }
    const sha = git(['rev-parse', 'HEAD'], { cwd: wt.dir });
    git(['update-ref', `refs/ifc-git/pull/${pr.number}/merge`, sha], { cwd: forge.root });
    return { sha, mergeable: true, conflicts: [] };
  } finally { wt.remove(); }
}

export async function openPull(root, { head, base = 'main', title, author, log = console.log }) {
  const { Forge } = await import('./forge.mjs');
  const forge = new Forge(root);
  if (!revParse(root, `refs/heads/${head}`)) throw new Error(`no branch "${head}"`);
  if (!tipOf(forge, base)) throw new Error(`no branch "${base}"`);
  const existing = forge.pulls().find((p) => p.state === 'open' && p.head === head && p.base === base);
  if (existing) throw new Error(`pull request #${existing.number} already proposes ${head} → ${base}`);
  if (forge.pushedTip(head) !== revParse(root, `refs/heads/${head}`)) await pushBranch(forge, head, { log, internal: true });
  const pr = {
    number: forge.nextId('pull'), title: title ?? `Merge ${head} into ${base}`, head, base,
    author: author ?? (git(['config', 'user.name'], { cwd: root, allowFail: true }).stdout?.trim() || 'unknown'),
    state: 'open', createdAt: now(), approvals: [], timeline: [],
  };
  note(pr, 'opened', `${pr.author} opened #${pr.number}: ${head} → ${base}`);
  forge.savePull(pr);
  log(`Opened pull request #${pr.number}: ${pr.title}  (${head} → ${base})`);
  await syncPull(forge, pr.number, { log, force: true });
  return forge.pull(pr.number);
}

export async function syncPull(forge, number, { log = console.log, force = false } = {}) {
  const pr = forge.pull(number);
  if (pr.state !== 'open') return pr;
  const headSha = tipOf(forge, pr.head);
  const baseSha = tipOf(forge, pr.base);
  if (!force && pr.headSha === headSha && pr.baseSha === baseSha) return pr;
  const ancestor = mergeBase(forge.root, headSha, baseSha);
  if (!ancestor) throw new Error(`#${number}: ${pr.head} and ${pr.base} share no history`);

  const rule = protectionFor(forge.root, baseSha, pr.base);
  if (pr.headSha && pr.headSha !== headSha && rule?.dismissStaleApprovals && pr.approvals.some((a) => a.sha !== headSha)) {
    note(pr, 'approvals-dismissed', 'new commits pushed: earlier approvals were dismissed');
  }
  Object.assign(pr, { headSha, baseSha, mergeBase: ancestor });
  const changed = changedFiles(forge.root, ancestor, headSha);
  pr.files = changed;
  pr.models = [...semanticChanges(forge.root, ancestor, headSha, changed), ...pinnedChanges(forge.root, ancestor, headSha)];
  pr.preview = buildPreview(forge, pr, headSha, baseSha, ancestor);
  note(pr, 'synced', pr.preview.mergeable
    ? `merge preview ${pr.preview.sha.slice(0, 8)} built for ${headSha.slice(0, 8)}`
    : `cannot be merged automatically: ${pr.preview.conflicts.map((c) => c.path).join(', ')}`);
  forge.savePull(pr);

  log(`#${number} ${pr.title}`);
  for (const m of pr.models) {
    log(`  ${m.path}: ${m.status === 'modified' ? `+${m.counts.added} ~${m.counts.modified} -${m.counts.deleted}` : m.status}`);
  }
  for (const c of pr.preview.conflicts) {
    log(`  ⚡ ${c.path}: ${c.verdict} — ${c.reason}`);
    for (const k of c.conflicts.slice(0, 8)) log(`      ${k.kind} ${k.ifcType} ${k.key} [${k.components.join(', ')}]`);
  }
  const event = {
    name: 'pull_request', branch: pr.base, sha: pr.preview.sha ?? headSha, checkSha: headSha,
    context: `pr-${number}`, compareBase: ancestor, changed,
    pr: { number, title: pr.title, head: pr.head, base: pr.base, headSha },
  };
  if (!pr.preview.mergeable) log('  (checks run on the head commit: there is no merge preview until conflicts are resolved)');
  const runs = runEvent(forge, event, { log });
  const fresh = forge.pull(number);
  note(fresh, 'checks', `${runs.length} workflow run(s) on ${headSha.slice(0, 8)}`, { runs: runs.map((r) => r.id) });
  forge.savePull(fresh);
  return fresh;
}

/** Everything that stands between this pull request and a merge. */
export function mergeStatus(forge, pr, waivers = []) {
  const rule = protectionFor(forge.root, pr.baseSha, pr.base);
  const checks = forge.checks(pr.headSha, `pr-${pr.number}`);
  const blockers = [];
  if (!pr.preview?.mergeable) blockers.push(`conflicts in ${pr.preview?.conflicts.map((c) => c.path).join(', ')}`);
  const required = (rule?.requiredChecks ?? []).map((name) => {
    const waived = waivers.find((w) => w.check === name);
    const status = waived ? 'waived' : checks[name]?.status ?? 'missing';
    if (status !== 'success' && status !== 'skipped' && status !== 'waived') blockers.push(`required check ${name} is ${status === 'missing' ? 'expected but did not run' : status}`);
    return { name, status, reason: waived?.reason };
  });
  const approvals = pr.approvals.filter((a) => !rule?.dismissStaleApprovals || a.sha === pr.headSha);
  if (rule && approvals.length < rule.requiredApprovals) blockers.push(`${rule.requiredApprovals - approvals.length} more approval(s) required`);
  return { rule, required, checks, approvals, blockers, overall: worst(Object.values(checks).map((c) => c.status)) };
}

export function closePull(forge, number, { by, reason }) {
  const pr = forge.pull(number);
  if (pr.state !== 'open') return pr;
  pr.state = 'closed';
  note(pr, 'closed', `${by} closed #${number}${reason ? `: ${reason}` : ''}`);
  forge.savePull(pr);
  return pr;
}

export function approvePull(forge, number, by) {
  const pr = forge.pull(number);
  if (by === pr.author) throw new Error('the author of a pull request cannot approve it');
  pr.approvals.push({ by, sha: pr.headSha, at: now() });
  note(pr, 'approved', `${by} approved ${pr.headSha.slice(0, 8)}`);
  forge.savePull(pr);
  return pr;
}

export async function mergePull(forge, number, { by, waivers = [], log = console.log }) {
  let pr = forge.pull(number);
  if (pr.state !== 'open') throw new Error(`#${number} is ${pr.state}`);
  if (tipOf(forge, pr.base) !== pr.baseSha || tipOf(forge, pr.head) !== pr.headSha) pr = await syncPull(forge, number, { log });
  const status = mergeStatus(forge, pr, waivers);
  if (status.blockers.length) return { merged: false, status };
  // Re-sign the checked preview as the person merging: same tree and parents,
  // so what the checks saw is exactly what lands, but history records who
  // accepted it, as on a hosted forge.
  const tree = git(['rev-parse', `${pr.preview.sha}^{tree}`], { cwd: forge.root });
  const message = git(['show', '-s', '--format=%B', pr.preview.sha], { cwd: forge.root });
  const person = { name: by, email: `${by.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@localhost` };
  const mergeSha = git(['commit-tree', tree, '-p', pr.baseSha, '-p', pr.headSha, '-F', '-'], { cwd: forge.root, input: message, env: identityEnv(person) });
  advanceBranch(forge.root, pr.base, mergeSha, pr.baseSha);
  for (const w of waivers) note(pr, 'waived', `${by} waived ${w.check}: ${w.reason}`);
  pr.state = 'merged';
  pr.mergedBy = by;
  pr.mergeSha = mergeSha;
  note(pr, 'merged', `${by} merged ${pr.head} into ${pr.base} as ${pr.mergeSha.slice(0, 8)}`);
  forge.savePull(pr);
  log(`Merged #${number} into ${pr.base} (${pr.mergeSha.slice(0, 8)})`);
  await pushBranch(forge, pr.base, { log, internal: true });
  return { merged: true, status, sha: pr.mergeSha };
}

/**
 * Resolve the conflicts of a pull request by merging the base branch into its
 * head and taking one side's version of every contested IFC model. What the
 * other side changed in those models is recorded on the timeline, because
 * taking a whole file discards it.
 */
export async function resolvePull(forge, number, { take, by, log = console.log }) {
  if (take !== 'head' && take !== 'base') throw new Error('--take must be "head" or "base"');
  const pr = forge.pull(number);
  const contested = (pr.preview?.conflicts ?? []).map((c) => c.path);
  if (contested.length === 0) throw new Error(`#${number} has no conflicts to resolve`);
  const wt = tempWorktree(forge.root, pr.headSha);
  let sha;
  try {
    git(['merge', '--no-commit', '--no-ff', pr.baseSha], { cwd: wt.dir, allowFail: true, env: { IFC_GIT_INTERNAL: '1' } });
    for (const path of contested) {
      const from = take === 'head' ? pr.headSha : pr.baseSha;
      if (fileExistsAt(forge.root, from, path)) git(['checkout', from, '--', path], { cwd: wt.dir });
      else git(['rm', '-q', '--force', '--', path], { cwd: wt.dir });
    }
    const left = git(['diff', '--name-only', '--diff-filter=U'], { cwd: wt.dir }).split('\n').filter(Boolean);
    if (left.length) throw new Error(`non-model conflicts need a manual merge: ${left.join(', ')}`);
    const person = { name: by, email: `${by.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@localhost` };
    git(['commit', '-q', '-m', `Merge ${pr.base} into ${pr.head}; resolve ${contested.join(', ')} by taking ${take}`], { cwd: wt.dir, env: { ...identityEnv(person), IFC_GIT_INTERNAL: '1' } });
    sha = git(['rev-parse', 'HEAD'], { cwd: wt.dir });
  } finally { wt.remove(); }
  advanceBranch(forge.root, pr.head, sha, pr.headSha);
  for (const c of pr.preview.conflicts) {
    const dropped = take === 'head' ? c.theirsChanges : c.oursChanges;
    note(pr, 'resolved', `${by} resolved ${c.path} by taking ${take}; ${dropped?.length ?? 0} change(s) from ${take === 'head' ? pr.base : pr.head} to that model were not carried over`,
      { dropped: (dropped ?? []).map((d) => `${d.state} ${d.ifcType} ${d.key}`) });
  }
  forge.savePull(pr);
  log(`Resolved #${number}: took ${take} for ${contested.join(', ')} (${sha.slice(0, 8)})`);
  await pushBranch(forge, pr.head, { log, internal: true });
  return forge.pull(number);
}
