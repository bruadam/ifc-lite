/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SourceCommit, StoredCommitDiff } from '@ifc-lite/plugin-api';

/** Compose reviewed one-to-one identity across a contiguous comparison range. */
export function historyKeyAliases(chain: readonly SourceCommit[], diffs: readonly StoredCommitDiff[], baseId: string, headId: string): Map<string, string> {
  const from = chain.findIndex(c => c.id === baseId), to = chain.findIndex(c => c.id === headId);
  if (from < 0 || to <= from) throw new Error('Invalid history comparison range');
  let aliases = new Map<string, string>();
  for (let i = from + 1; i <= to; i++) {
    const diff = diffs.find(d => d.base.commitId === chain[i - 1].id && d.head.commitId === chain[i].id);
    if (!diff) throw new Error('Cannot compose identity across a missing history edge');
    const next = new Map(aliases);
    for (const entry of diff.entries) if (entry.state === 'deleted' || entry.state === 'added') next.delete(entry.key);
    for (const entry of diff.appliedIdentity) next.delete(entry.base);
    for (const entry of diff.appliedIdentity) next.set(entry.here, aliases.get(entry.base) ?? entry.base);
    aliases = next;
  }
  return aliases;
}

export function isDerivedHistoryExport(descriptions: readonly string[] | undefined): boolean {
  return descriptions?.some(item => /^ifc-lite-export\((?:history|change-set)\);/.test(item)) ?? false;
}
