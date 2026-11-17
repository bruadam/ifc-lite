/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite diff --by-content --json --changes`: one record per entity that
 * did not come out `unchanged`.
 *
 * The counts say how much changed; these records say what. A caller that has
 * to reason about individual elements (a three-way merge asking whether two
 * branches touched the same property set of the same wall, or a review UI
 * listing what a delivery changed) needs the key, the state and the changed
 * component keys, and the counts carry none of them.
 *
 * Only what the engine already computed is reported. `changedComponents` is
 * present exactly when the engine reports it (both sides carried component
 * sub-hashes), so an absent field means "not computed", never "nothing
 * changed in any component".
 */

import type { DiffEntry, ModelDiff } from '@ifc-lite/diff';

export interface ChangeRecord {
  /** The entity's key: its GlobalId, or the authored key under `--key-from`. */
  key: string;
  state: 'added' | 'modified' | 'deleted';
  /** The IFC class, from the head side when present, else the base side. */
  ifcType: string;
  /** Which signals changed (`data`, `geometry`, `container`); empty unless modified. */
  changeKinds: string[];
  /** Component keys whose sub-hash differs (`attr:core`, `pset:<Name>`, …). */
  changedComponents?: string[];
}

function record<TRef>(entry: DiffEntry<TRef>): ChangeRecord | undefined {
  if (entry.state === 'unchanged') return undefined;
  const ifcType = entry.head?.ifcType ?? entry.base?.ifcType ?? '';
  const out: ChangeRecord = {
    key: entry.key,
    state: entry.state,
    ifcType,
    changeKinds: [...entry.changeKinds],
  };
  if (entry.changedComponents !== undefined) out.changedComponents = [...entry.changedComponents];
  return out;
}

/**
 * Every non-`unchanged` entry, sorted by key so the output is stable across
 * runs and diffs cleanly when committed.
 *
 * Entries a content match retired are not here: the engine removed them from
 * `entries` in favour of the match record, which `contentMatches` already
 * reports.
 */
export function changeRecords<TRef>(diff: ModelDiff<TRef>): ChangeRecord[] {
  const records: ChangeRecord[] = [];
  for (const entry of diff.entries) {
    const r = record(entry);
    if (r) records.push(r);
  }
  return records.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
