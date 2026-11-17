/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Semantic three-way conflict analysis for IFC files changed on both sides.
 *
 * git sees two edited STEP files and reports a textual conflict, which says
 * nothing useful: renumbered `#ids` alone make every line differ. Here each
 * side is compared with the merge base through the ifc-lite diff engine, and
 * a conflict is reported only where both sides changed the SAME element's
 * SAME component (`pset:Pset_WallCommon`, `attr:core`, …) to different
 * results, or one side deleted an element the other changed.
 *
 * What this does not do is write a merged IFC file. Combining two disjoint
 * sets of edits into one STEP file is a component-level merge, and that is
 * the Layer PRs merge engine's job once deliveries become layers (ifc-git
 * §8 row 8). Until then the analysis tells reviewers whether the two
 * deliveries are compatible, and the resolution takes one side's file.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractBlob, fileExistsAt } from './git.mjs';
import { ifcLite, parseJson } from './ifc-lite.mjs';

function changesBetween(dir, a, b, what) {
  const doc = parseJson(ifcLite(['diff', a, b, '--by-content', '--json', '--changes'], { cwd: dir }), what);
  return new Map((doc.changes ?? []).map((c) => [c.key, c]));
}

function overlap(a, b) {
  if (a.state === 'deleted' || b.state === 'deleted') {
    return a.state === b.state ? null : { kind: 'modify/delete', components: [] };
  }
  if (a.state === 'added' && b.state === 'added') return { kind: 'add/add', components: [] };
  const kinds = a.changeKinds.filter((k) => k !== 'data' && b.changeKinds.includes(k));
  if (!a.changedComponents || !b.changedComponents) {
    return { kind: 'modify/modify', components: ['(components not reported)'] };
  }
  const shared = a.changedComponents.filter((c) => b.changedComponents.includes(c));
  if (shared.length === 0 && kinds.length === 0) return null;
  return { kind: 'modify/modify', components: [...shared, ...kinds.map((k) => `(${k})`)] };
}

/**
 * Analyze one path. `ours` is the pull request's head, `theirs` the base
 * branch tip, `ancestor` their merge base.
 */
export function analyzePath(root, path, { ancestor, ours, theirs }) {
  const inAncestor = fileExistsAt(root, ancestor, path);
  const inOurs = fileExistsAt(root, ours, path);
  const inTheirs = fileExistsAt(root, theirs, path);
  if (!inAncestor) return { path, verdict: 'conflict', reason: 'added on both sides', conflicts: [] };
  if (!inOurs || !inTheirs) return { path, verdict: 'conflict', reason: `deleted on ${inOurs ? 'the base branch' : 'this branch'} and changed on the other`, conflicts: [] };

  const dir = mkdtempSync(join(tmpdir(), 'ifc-git-merge-'));
  try {
    const file = (rev, name) => { const p = join(dir, name); extractBlob(root, rev, path, p); return p; };
    const a = file(ancestor, 'ancestor.ifc');
    const o = file(ours, 'ours.ifc');
    const t = file(theirs, 'theirs.ifc');
    const oursChanges = changesBetween(dir, a, o, `diff ${path} (this branch)`);
    const theirsChanges = changesBetween(dir, a, t, `diff ${path} (base branch)`);
    const between = changesBetween(dir, o, t, `diff ${path} (head vs base)`);
    const conflicts = [];
    for (const [key, mine] of oursChanges) {
      const other = theirsChanges.get(key);
      if (!other) continue;
      // Both sides made the same change: the element is identical in both files.
      if (!between.has(key)) continue;
      const hit = overlap(mine, other);
      if (hit) conflicts.push({ key, ifcType: mine.ifcType || other.ifcType, ...hit, ours: mine, theirs: other });
    }
    const oursOnly = [...oursChanges.keys()].filter((k) => !theirsChanges.has(k)).length;
    const theirsOnly = [...theirsChanges.keys()].filter((k) => !oursChanges.has(k)).length;
    return {
      path,
      verdict: conflicts.length ? 'conflict' : 'compatible',
      reason: conflicts.length
        ? `${conflicts.length} element(s) changed on both sides`
        : 'the two sides changed different elements or components',
      conflicts, oursOnly, theirsOnly,
      oursChanges: [...oursChanges.values()], theirsChanges: [...theirsChanges.values()],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
