/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SourceCommit, StoredCommitDiff } from '@ifc-lite/plugin-api';
import type { ElementHistorySummary, HistoryIndex } from './types.js';

export function validateChain(chain: readonly SourceCommit[]): void {
  if (!chain.length) throw new Error('History needs at least one commit');
  const ids = new Set<string>();
  for (const [i, commit] of chain.entries()) {
    if (!commit.id || ids.has(commit.id)) throw new Error('Duplicate or empty commit id');
    if (commit.projectId !== chain[0].projectId || commit.modelId !== chain[0].modelId) throw new Error('Commits must belong to one model');
    if (i > 0 && commit.parents[0] !== chain[i - 1].id) throw new Error('History is not an ordered mainline');
    if (!Number.isFinite(Date.parse(commit.createdAt))) throw new Error('Invalid commit date');
    ids.add(commit.id);
  }
}

export function buildHistoryIndex(input: { readonly model: HistoryIndex['model']; readonly chain: readonly SourceCommit[]; readonly diffs: ReadonlyMap<string, StoredCommitDiff> }): HistoryIndex {
  validateChain(input.chain);
  const elements = new Map<string, ElementHistorySummary>();
  let partial = input.chain[0].parents.length > 0;
  for (const [i, commit] of input.chain.entries()) {
    // The initial diff is from an empty base, represented by the empty id.
    const baseId = i === 0 ? '' : input.chain[i - 1].id;
    const diff = input.diffs.get(`${baseId}:${commit.id}`);
    if (!diff) { partial = true; elements.clear(); continue; }
    if (diff.head.commitId !== commit.id || diff.base.commitId !== baseId) throw new Error('Diff does not match its history edge');
    const priorIdentity = new Map(diff.appliedIdentity.map(identity => [identity.base, elements.get(identity.base)]));
    for (const identity of diff.appliedIdentity) if (identity.base !== identity.here) elements.delete(identity.base);
    for (const identity of diff.appliedIdentity) {
      const previous = priorIdentity.get(identity.base);
      if (previous && identity.base !== identity.here) {
        elements.set(identity.here, { ...previous, key: identity.here, previousKeys: [...previous.previousKeys, identity.base] });
      }
    }
    for (const entry of diff.entries) {
      const key = entry.key;
      if (entry.state === 'deleted') { elements.delete(key); continue; }
      const oldKey = entry.baseKey ?? key;
      const previous = elements.get(oldKey) ?? elements.get(key);
      if (oldKey !== key) elements.delete(oldKey);
      if (entry.state !== 'added' && !previous) { partial = true; continue; }
      elements.set(key, {
        key, createdCommitId: previous?.createdCommitId ?? commit.id, createdAt: previous?.createdAt ?? commit.createdAt,
        lastChangedCommitId: commit.id, lastChangedAt: commit.createdAt, lastChangedBy: commit.author?.displayName,
        lastChangeKinds: entry.changeKinds, changeCount: (previous?.changeCount ?? 0) + 1,
        previousKeys: oldKey !== key && previous && !previous.previousKeys.includes(oldKey) ? [...previous.previousKeys, oldKey] : previous?.previousKeys ?? [],
      });
    }
  }
  return { model: input.model, chain: input.chain, exportedCommit: input.chain[input.chain.length - 1], elements, partial };
}
