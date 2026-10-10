/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SourceCommit, StoredCommitDiff } from '@ifc-lite/plugin-api';
import type { HistoryPackageManifest } from './types.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid history object');
  return value as Record<string, unknown>;
}
function string(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid history string');
}
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('Invalid history string list');
}
function integer(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid history count');
}
export function parseCommits(value: unknown): SourceCommit[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Invalid history chain');
  for (const item of value) {
    const c = object(item), artifact = object(c.artifact);
    for (const key of ['id', 'modelId', 'projectId', 'createdAt']) string(c[key]);
    strings(c.parents); string(artifact.digest); string(artifact.fileName); integer(artifact.sizeBytes);
    if (!['published', 'pending', 'rejected'].includes(String(c.status))) throw new Error('Invalid commit status');
    if (c.author !== undefined) { const a = object(c.author); string(a.id); string(a.displayName); }
    if (c.message !== undefined && typeof c.message !== 'string') throw new Error('Invalid commit message');
  }
  return value as SourceCommit[];
}
export function parseManifest(value: unknown): HistoryPackageManifest {
  const m = object(value), model = object(m.model), file = object(m.modelFile);
  if (m.format !== 'ifc-lite/history-package' || m.version !== 1 || !Array.isArray(m.files) || m.files.length > 50_000) throw new Error('Unsupported history package');
  string(model.name); string(file.path); string(file.digest); string(m.exportedCommitId); integer(m.commitCount);
  if (typeof file.stamped !== 'boolean' || typeof m.partial !== 'boolean' || !['none', 'exported', 'all'].includes(String(m.artifacts))) throw new Error('Invalid history manifest');
  for (const item of m.files) { const f = object(item); string(f.path); string(f.digest); integer(f.sizeBytes); }
  return value as HistoryPackageManifest;
}
export function validateDiff(value: unknown, chain: readonly SourceCommit[]): asserts value is StoredCommitDiff {
  const d = object(value), a = object(d.base), b = object(d.head), options = object(d.options), counts = object(d.counts);
  const base = chain.find(c => c.id === a.commitId), head = chain.find(c => c.id === b.commitId);
  if (d.format !== 'ifc-lite/commit-diff' || d.version !== 1 || !head || (!base && a.commitId !== '') || (base && chain.indexOf(base) >= chain.indexOf(head))) throw new Error('Invalid packaged diff edge');
  for (const pin of [a, b]) if (pin.projectId !== head.projectId || pin.modelId !== head.modelId) throw new Error('Diff is pinned to another model');
  if (!['data', 'geometry', 'both'].includes(String(options.scope)) || typeof options.matchUnpairedByContent !== 'boolean') throw new Error('Invalid diff options');
  for (const key of ['added', 'modified', 'deleted', 'unchanged']) integer(counts[key]);
  if (!Array.isArray(d.entries) || !Array.isArray(d.appliedIdentity)) throw new Error('Invalid diff entries');
  const keys = new Set<string>();
  for (const item of d.entries) {
    const e = object(item); string(e.key); string(e.ifcType); strings(e.changeKinds);
    if (keys.has(e.key) || !['added', 'modified', 'deleted'].includes(String(e.state)) || e.changeKinds.some(k => !['data', 'geometry', 'container'].includes(k))) throw new Error('Invalid diff entry');
    if (e.baseKey !== undefined) string(e.baseKey);
    if (e.changedComponents !== undefined) strings(e.changedComponents);
    keys.add(e.key);
  }
  const bases = new Set<string>(), heads = new Set<string>();
  for (const item of d.appliedIdentity) {
    const e = object(item); string(e.base); string(e.here); string(e.reason);
    if (bases.has(e.base) || heads.has(e.here)) throw new Error('Ambiguous applied identity');
    bases.add(e.base); heads.add(e.here);
  }
}
