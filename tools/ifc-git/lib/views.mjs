/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read-only views over the repository and the forge: the semantic log, the
 * checks on a commit, a pull request page and the branch overview.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, currentBranch, extractBlob, fileExistsAt, localBranches, log as gitLog, revParse } from './git.mjs';
import { ifcLite, parseJson } from './ifc-lite.mjs';
import { mergeStatus } from './pulls.mjs';
import { protectionFor } from './workflows.mjs';

const ICON = { success: '✔', failure: '✖', error: '⚠', skipped: '○', waived: '≈', missing: '·' };

/** Per-commit semantic summary of every IFC model the commit changed, against its first parent. */
export function semanticLog(forge, rev, limit) {
  const tmp = mkdtempSync(join(tmpdir(), 'ifc-git-log-'));
  try {
    return gitLog(forge.root, rev, limit).map((c) => {
      const parent = c.parents[0] ?? null;
      const models = changedFiles(forge.root, parent, c.sha).filter((p) => /\.ifc$/i.test(p)).map((path) => {
        if (!fileExistsAt(forge.root, c.sha, path)) return { path, status: 'deleted' };
        if (!parent || !fileExistsAt(forge.root, parent, path)) return { path, status: 'added' };
        const a = join(tmp, 'a.ifc');
        const b = join(tmp, 'b.ifc');
        extractBlob(forge.root, parent, path, a);
        extractBlob(forge.root, c.sha, path, b);
        const doc = parseJson(ifcLite(['diff', a, b, '--by-content', '--json'], { cwd: tmp }), `diff ${path}`);
        const renamed = (doc.contentMatches ?? []).filter((m) => m.kind === 'renamed').length;
        return { path, status: 'modified', counts: doc.counts, renamed };
      });
      const checks = forge.checks(c.sha, 'push');
      return { ...c, models, checks };
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export function printLog(entries, out = console.log) {
  for (const e of entries) {
    const checks = Object.entries(e.checks).map(([n, r]) => `${ICON[r.status] ?? '?'}${n}`).join(' ');
    out(`${e.sha.slice(0, 8)}  ${e.date.slice(0, 10)}  ${e.author.padEnd(14)} ${e.subject}${e.parents.length > 1 ? '  (merge)' : ''}`);
    for (const m of e.models) {
      const detail = m.status === 'modified'
        ? `+${m.counts.added} ~${m.counts.modified} -${m.counts.deleted}${m.renamed ? `  ${m.renamed} re-GUIDed` : ''}`
        : m.status;
      out(`          ${m.path}: ${detail}`);
    }
    if (checks) out(`          checks: ${checks}`);
  }
}

export function printChecks(forge, sha, out = console.log) {
  const all = forge.read(join('checks', `${sha}.json`), {});
  if (Object.keys(all).length === 0) { out(`no checks recorded for ${sha.slice(0, 8)}`); return; }
  for (const [context, checks] of Object.entries(all)) {
    out(`${context === 'push' ? 'push' : `pull request #${context.slice(3)}`} @ ${sha.slice(0, 8)}`);
    for (const [name, r] of Object.entries(checks)) out(`  ${ICON[r.status] ?? '?'} ${name}${r.runId ? `  (run ${r.runId})` : ''}${r.reason ? `  ${r.reason}` : ''}`);
  }
}

export function printPull(forge, pr, out = console.log) {
  const status = mergeStatus(forge, pr);
  out(`#${pr.number} ${pr.title}  [${pr.state}]`);
  out(`  ${pr.head} → ${pr.base}   by ${pr.author}   head ${pr.headSha?.slice(0, 8)}`);
  out('  Models changed:');
  for (const m of pr.models ?? []) {
    out(`    ${m.path}: ${m.status === 'modified' ? `+${m.counts.added} ~${m.counts.modified} -${m.counts.deleted}` : m.status}`);
    for (const c of (m.changes ?? []).slice(0, 8)) out(`      ${c.state.padEnd(8)} ${c.ifcType} ${c.key}${c.changedComponents?.length ? ` [${c.changedComponents.join(', ')}]` : ''}`);
  }
  if (pr.preview?.conflicts?.length) {
    out('  Conflicts:');
    for (const c of pr.preview.conflicts) {
      out(`    ${c.path}: ${c.verdict} — ${c.reason}`);
      for (const k of c.conflicts ?? []) out(`      ${k.kind} ${k.ifcType} ${k.key} [${k.components.join(', ')}]`);
    }
  }
  out('  Checks:');
  for (const [name, r] of Object.entries(status.checks)) out(`    ${ICON[r.status]} ${name}${status.required.some((q) => q.name === name) ? '  (required)' : ''}`);
  for (const q of status.required.filter((q) => q.status === 'missing')) out(`    · ${q.name}  (required, did not run)`);
  out(`  Approvals: ${status.approvals.map((a) => a.by).join(', ') || 'none'}${status.rule ? ` (${status.rule.requiredApprovals} required)` : ''}`);
  if (pr.state === 'open') {
    out(status.blockers.length ? `  Merge blocked:\n${status.blockers.map((b) => `    - ${b}`).join('\n')}` : '  Ready to merge.');
  }
  out('  Timeline:');
  for (const t of pr.timeline) {
    out(`    ${t.at.slice(11, 19)}  ${t.text}`);
    for (const d of (t.dropped ?? []).slice(0, 5)) out(`               dropped: ${d}`);
  }
}

export function printStatus(forge, out = console.log) {
  const branch = currentBranch(forge.root);
  out(`On branch ${branch ?? '(detached)'}`);
  const pushed = forge.pushedBranches();
  for (const b of localBranches(forge.root)) {
    const local = revParse(forge.root, `refs/heads/${b}`);
    const rule = protectionFor(forge.root, pushed[b] ?? local, b);
    const state = !pushed[b] ? 'not pushed' : pushed[b] === local ? 'up to date' : 'ahead of forge';
    const checks = forge.checks(pushed[b] ?? local, 'push');
    const summary = Object.entries(checks).map(([n, r]) => `${ICON[r.status]}${n}`).join(' ');
    out(`  ${b.padEnd(28)} ${local.slice(0, 8)}  ${state.padEnd(15)}${rule ? ` 🔒 ${rule.pattern}` : ''}${summary ? `  ${summary}` : ''}`);
  }
  const open = forge.pulls().filter((p) => p.state === 'open');
  if (open.length) {
    out('Open pull requests:');
    for (const p of open) {
      const s = mergeStatus(forge, p);
      out(`  #${p.number} ${p.title} (${p.head} → ${p.base})  ${s.blockers.length ? `blocked: ${s.blockers.length} reason(s)` : 'ready to merge'}`);
    }
  }
}
