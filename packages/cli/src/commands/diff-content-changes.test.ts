/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `diff --by-content --json --changes`: the per-entity records a three-way
 * merge needs to tell which elements, and which components of them, each
 * side touched.
 */

import { diffModels, initDiff, type EntityFingerprint } from '@ifc-lite/diff';
import { beforeAll, describe, expect, it } from 'vitest';
import { changeRecords } from './diff-content-changes.js';

beforeAll(async () => { await initDiff(); });

function wall(key: string, data: string, components: Record<string, string>): EntityFingerprint<number> {
  return { key, ifcType: 'IfcWall', dataHash: data, components, ref: 0 };
}

describe('changeRecords', () => {
  it('reports each non-unchanged entity with its changed components, sorted by key', () => {
    const base = [
      wall('b-kept', 'k', { 'attr:core': 'a', 'pset:Pset_WallCommon': 'p' }),
      wall('a-edited', 'e1', { 'attr:core': 'a', 'pset:Pset_WallCommon': 'p1' }),
      wall('c-gone', 'g', { 'attr:core': 'g' }),
    ];
    const head = [
      wall('b-kept', 'k', { 'attr:core': 'a', 'pset:Pset_WallCommon': 'p' }),
      wall('a-edited', 'e2', { 'attr:core': 'a', 'pset:Pset_WallCommon': 'p2' }),
      wall('d-new', 'n', { 'attr:core': 'n' }),
    ];
    const records = changeRecords(diffModels(base, head));

    expect(records).toEqual([
      {
        key: 'a-edited',
        state: 'modified',
        ifcType: 'IfcWall',
        changeKinds: ['data'],
        changedComponents: ['pset:Pset_WallCommon'],
      },
      { key: 'c-gone', state: 'deleted', ifcType: 'IfcWall', changeKinds: [] },
      { key: 'd-new', state: 'added', ifcType: 'IfcWall', changeKinds: [] },
    ]);
  });

  it('omits changedComponents when the engine did not compute it, rather than reporting none', () => {
    const base: EntityFingerprint<number>[] = [{ key: 'w', ifcType: 'IfcWall', dataHash: '1', ref: 0 }];
    const head: EntityFingerprint<number>[] = [{ key: 'w', ifcType: 'IfcWall', dataHash: '2', ref: 0 }];
    const [only] = changeRecords(diffModels(base, head));
    expect(only.state).toBe('modified');
    expect('changedComponents' in only).toBe(false);
  });

  it('leaves out entities a content match retired: the match record already reports them', () => {
    const base = [wall('old-guid', 'same', { 'attr:core': 'same' })];
    const head = [wall('new-guid', 'same', { 'attr:core': 'same' })];
    const diff = diffModels(base, head, { matchUnpairedByContent: true });
    expect(diff.contentMatches?.map((m) => m.kind)).toEqual(['renamed']);
    expect(changeRecords(diff)).toEqual([]);
  });
});
