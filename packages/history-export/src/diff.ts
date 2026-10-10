/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { diffModels, identityMapFromContentMatches, type ModelDiff } from '@ifc-lite/diff';
import type { CommitRef, StoredCommitDiff } from '@ifc-lite/plugin-api';

export function storeCommitDiff(diff: ModelDiff, base: CommitRef, head: CommitRef, byContent = false): StoredCommitDiff {
  const identities = [...identityMapFromContentMatches(diff.contentMatches), ...[...(diff.appliedKeyAliases ?? [])].map(([here, base]) => ({ base, here, reason: 'reviewed' }))];
  const baseEntries = new Map(diff.entries.flatMap(e => e.base ? [[e.base.key, e.base] as const] : []));
  const headEntries = new Map(diff.entries.flatMap(e => e.head ? [[e.head.key, e.head] as const] : []));
  for (const match of diff.contentMatches ?? []) {
    for (const item of match.base) baseEntries.set(item.key, item);
    for (const item of match.head) headEntries.set(item.key, item);
  }
  // Persist only resolved identity; ambiguous groups stay added/deleted.
  const resolved = diffModels([...baseEntries.values()], [...headEntries.values()], { scope: diff.scope, keyAliases: new Map(identities.map(e => [e.here, e.base])) });
  return { format: 'ifc-lite/commit-diff', version: 1, base, head, engine: '@ifc-lite/diff@0', options: { scope: diff.scope, matchUnpairedByContent: byContent }, counts: resolved.counts,
    entries: resolved.entries.filter(e => e.state !== 'unchanged').map(e => ({ key: e.head?.key ?? e.key, baseKey: e.base && e.head && e.base.key !== e.head.key ? e.base.key : undefined, ifcType: (e.head ?? e.base)!.ifcType, state: e.state as 'added' | 'modified' | 'deleted', changeKinds: e.changeKinds, changedComponents: e.changedComponents })),
    appliedIdentity: identities,
  };
}
