/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CommitRef, ElementHistoryEntry, FileSourceProvider, ListOptions, SourceCommit } from '@ifc-lite/plugin-api';
import type { HistoryPackage } from './types.js';

/** Session-local read-only source; unavailable artifacts are explicitly reported. */
export function createHistoryPackageProvider(pack: HistoryPackage, name: string): FileSourceProvider {
  const head = pack.chain.at(-1)!;
  const model = { id: head.modelId, projectId: head.projectId, name: pack.model.name, headCommitId: head.id, commitCount: pack.chain.length };
  const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
  const checkModel = (ref: { projectId: string; modelId: string }) => {
    if (ref.projectId !== model.projectId || ref.modelId !== model.id) fail('not-found', 'Model is not in this package');
  };
  const available = (commit: SourceCommit): SourceCommit => ({ ...commit, meta: { ...commit.meta, historyPackageArtifactIncluded: !!pack.artifacts?.has(commit.id) } });
  const get = (ref: CommitRef): SourceCommit => {
    checkModel(ref);
    const commit = pack.chain.find(c => c.id === ref.commitId) ?? fail('not-found', 'Commit is not in this package');
    return available(commit);
  };
  const page = <T>(items: T[], options?: ListOptions) => {
    const start = options?.cursor ? Number(options.cursor) : 0;
    if (!Number.isSafeInteger(start) || start < 0) fail('invalid', 'Invalid cursor');
    const limit = Math.min(500, Math.max(1, options?.limit ?? 100));
    return { items: items.slice(start, start + limit), cursor: start + limit < items.length ? String(start + limit) : undefined };
  };
  return {
    manifest: { name, title: pack.model.name, api: '^2.1.0', auth: 'preferences', permissions: { network: [] }, preferences: [], contributes: { fileSources: [] }, capabilities: { containerListing: 'direct-children', listFilesIsRecursive: false, revisionHistory: false, downloadHistoricalRevisions: false, changeDetection: false, search: false, commits: { payloadFormats: ['ifc-step', 'ifc-zip', 'ifcx'], fingerprints: false, storedDiffs: true, elementHistory: true, identityRecords: true, write: false, watch: false, modelIdsAreFileIds: false } } },
    listProjects: async () => ({ items: [{ id: model.projectId, name: pack.model.name }] }),
    listContainers: async () => ({ items: [] }), listFiles: async () => ({ items: [] }),
    download: async () => fail('unsupported-format', 'Use loadCommit for a history package'),
    listModels: async (_ctx, projectId) => ({ items: projectId === model.projectId ? [model] : [] }),
    getModel: async (_ctx, ref) => { checkModel(ref); return model; },
    listCommits: async (_ctx, ref, options) => { checkModel(ref); return page([...pack.chain].reverse().map(available).filter(c => (!options?.before || c.createdAt < options.before) && (!options?.after || c.createdAt > options.after)), options); },
    getCommit: async (_ctx, ref) => get(ref),
    loadCommit: async (_ctx, ref, options) => {
      get(ref);
      const payload = pack.artifacts?.get(ref.commitId);
      if (!payload) return fail('not-found', 'Not included in this package');
      if (options?.accept && !options.accept.includes(payload.format)) return fail('unsupported-format', 'Requested format is not included');
      return payload;
    },
    getCommitDiff: async (_ctx, base, target) => {
      if (base.commitId) get(base); else checkModel(base);
      get(target);
      return pack.diffs.find(d => d.base.commitId === base.commitId && d.head.commitId === target.commitId) ?? fail('unavailable', 'This comparison is not included in the package; load both artifacts to compare locally');
    },
    listIdentityRecords: async (_ctx, base, target) => {
      const a = get(base), b = get(target);
      return pack.identity?.find(r => r.base.commitId === a.id && r.head.commitId === b.id) ?? { base: { ...base, artifactDigest: a.artifact.digest }, head: { ...target, artifactDigest: b.artifact.digest }, entries: [] };
    },
    listElementHistory: async (_ctx, query, options) => {
      checkModel(query);
      const at = get({ ...query, commitId: query.atCommitId ?? head.id });
      let key = query.key;
      const entries: ElementHistoryEntry[] = [];
      for (let i = pack.chain.findIndex(c => c.id === at.id); i >= 0; i--) {
        const commit = pack.chain[i];
        const diff = pack.diffs.find(d => d.head.commitId === commit.id && d.base.commitId === (pack.chain[i - 1]?.id ?? ''));
        if (!diff) break;
        const entry = diff.entries.find(e => e.key === key);
        const previous = entry?.baseKey ?? diff.appliedIdentity.find(e => e.here === key)?.base;
        if (entry || previous) entries.push({ commitId: commit.id, createdAt: commit.createdAt, key, state: previous && previous !== key ? 'renamed' : entry!.state, changeKinds: entry?.changeKinds ?? [], changedComponents: entry?.changedComponents, relatedKeys: previous ? [previous] : undefined });
        if (entry?.state === 'added') break;
        key = previous ?? key;
      }
      return page(entries, options);
    },
  };
}
