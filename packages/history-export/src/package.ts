/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import JSZip from 'jszip';
import { HistoryZipWriter } from './zip-write.js';
import { createIdentityMapSidecar, parseIdentityMapSidecar, parseLineageSidecar } from '@ifc-lite/diff';
import type { CommitPayload, IdentityRecordSet, SourceCommit, StoredCommitDiff } from '@ifc-lite/plugin-api';
import type { HistoryPackage, HistoryPackageInput, HistoryPackageManifest } from './types.js';
import { parseCommits, parseManifest, validateDiff } from './validation.js';
import { readBounded } from './zip-read.js';
import { validateChain } from './history-index.js';

export async function artifactDigest(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('');
}
const safeName = (name: string) => name.split(/[/\\]/).pop()!.replace(/[^\p{L}\p{N}._-]/gu, '_') || 'model.ifc';
const pinName = (id: string) => encodeURIComponent(id).replaceAll('_', '%5F');
const edge = (base: string, head: string) => `${pinName(base)}__${pinName(head)}`;
const ref = (c: SourceCommit) => ({ projectId: c.projectId, modelId: c.modelId, commitId: c.id });

function pinIdentity(records: readonly IdentityRecordSet[], chain: readonly SourceCommit[]): void {
  const byId = new Map(chain.map(c => [c.id, c]));
  for (const record of records) for (const pin of [record.base, record.head]) {
    const commit = byId.get(pin.commitId);
    if (!commit || commit.artifact.digest !== pin.artifactDigest || commit.modelId !== pin.modelId || commit.projectId !== pin.projectId) throw new Error('Identity sidecar is pinned to another artifact');
  }
}

export async function buildHistoryPackage(input: HistoryPackageInput): Promise<Blob> {
  validateChain(input.chain);
  for (const diff of input.diffs) validateDiff(diff, input.chain);
  pinIdentity(input.identity ?? [], input.chain);
  const head = input.chain[input.chain.length - 1];
  const zip = new HistoryZipWriter();
  const files: { path: string; digest: string; sizeBytes: number }[] = [];
  let totalBytes = 0;
  const add = async (path: string, data: ArrayBuffer | string) => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data).buffer : data;
    totalBytes += bytes.byteLength;
    if (totalBytes > 2_000_000_000) throw new Error('Package exceeds the 2 GB uncompressed limit');
    if (files.some(file => file.path === path)) throw new Error('Duplicate package path');
    zip.add(path, bytes); files.push({ path, digest: await artifactDigest(bytes), sizeBytes: bytes.byteLength });
  };
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const modelPath = `model/${safeName(input.modelFile.fileName)}`;
  const digest = await artifactDigest(input.modelFile.bytes);
  if (!input.stamped && digest !== head.artifact.digest) throw new Error('Model bytes do not match the exported commit');
  await add(modelPath, input.modelFile.bytes);
  const chain = input.omitAuthors ? input.chain.map(c => ({ ...c, author: undefined })) : input.chain;
  await add('commits.json', json(chain));
  await add('README.txt', 'IFClite model history. The IFC in model/ opens in an IFC viewer. Commits and diffs describe the mainline. Past artifacts are optional. This package includes commit messages and, unless omitted, author names.\n');
  for (const diff of input.diffs) await add(`diffs/${edge(diff.base.commitId, diff.head.commitId)}.json`, json(diff));
  for (const record of input.identity ?? []) {
    const sidecar = createIdentityMapSidecar({ base: { hash: record.base.artifactDigest }, head: { hash: record.head.artifactDigest }, entries: record.entries, keyProperty: record.keyProperty });
    await add(`identity/${edge(record.base.commitId, record.head.commitId)}.json`, json(sidecar));
  }
  for (const [i, sidecar] of (input.lineage ?? []).entries()) {
    const parsed = parseLineageSidecar(json(sidecar));
    if (!chain.some(c => c.artifact.digest === parsed.base.hash) || !chain.some(c => c.artifact.digest === parsed.head.hash)) throw new Error('Lineage sidecar is pinned to another artifact');
    await add(`lineage/${i}.json`, json(parsed));
  }
  const included = new Set<string>();
  async function* artifacts() { yield* input.artifacts ?? []; if (input.pastArtifacts) yield* input.pastArtifacts; }
  for await (const [id, payload] of artifacts()) {
    if (included.has(id)) throw new Error('Duplicate past artifact');
    included.add(id);
    const commit = input.chain.find(c => c.id === id);
    if (!commit || await artifactDigest(payload.bytes) !== commit.artifact.digest) throw new Error('Past artifact digest mismatch');
    await add(`artifacts/${encodeURIComponent(id)}/${safeName(payload.fileName)}`, payload.bytes);
  }
  const manifest: HistoryPackageManifest = { format: 'ifc-lite/history-package', version: 1, createdAt: new Date().toISOString(), createdWith: '@ifc-lite/history-export@0.1.0', model: input.model, exportedCommitId: head.id, modelFile: { path: modelPath, digest, stamped: !!input.stamped }, commitCount: chain.length, artifacts: included.size === chain.length ? 'all' : input.stamped ? 'none' : 'exported', files, partial: !!input.partial };
  zip.add('manifest.json', new TextEncoder().encode(json(manifest)).buffer);
  return zip.finish();
}

/** Verify every byte before exposing package content or creating an offline provider. */
export async function readHistoryPackage(bytes: ArrayBuffer): Promise<HistoryPackage> {
  const zip = await JSZip.loadAsync(bytes);
  const manifestEntry = zip.file('manifest.json');
  if (!manifestEntry) throw new Error('Missing history manifest');
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(await readBounded(manifestEntry, 16_000_000))));
  if (manifest.format !== 'ifc-lite/history-package' || manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported history package');
  const listed = new Map<string, ArrayBuffer>();
  let total = 0;
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path === 'manifest.json' || /(^|\/)\.\.(\/|$)|\\|^\//.test(file.path) || listed.has(file.path)) throw new Error('Invalid or duplicate package path');
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || (total += file.sizeBytes) > 2_000_000_000) throw new Error('Package exceeds the 2 GB uncompressed limit');
    const entry = zip.file(file.path);
    if (!entry) throw new Error(`Missing package file: ${file.path}`);
    const data = await readBounded(entry, file.sizeBytes);
    if (data.byteLength !== file.sizeBytes || await artifactDigest(data) !== file.digest) throw new Error(`Package digest mismatch: ${file.path}`);
    listed.set(file.path, data);
  }
  for (const entry of Object.values(zip.files)) if (!entry.dir && entry.name !== 'manifest.json' && !listed.has(entry.name)) throw new Error('Unlisted package file');
  const text = (path: string) => { const data = listed.get(path); if (!data) throw new Error(`Missing ${path}`); return new TextDecoder().decode(data); };
  const chain = parseCommits(JSON.parse(text('commits.json')));
  validateChain(chain);
  if (chain.length !== manifest.commitCount || chain[chain.length - 1].id !== manifest.exportedCommitId) throw new Error('Manifest commit mismatch');
  const head = chain[chain.length - 1];
  const modelBytes = listed.get(manifest.modelFile.path);
  if (!modelBytes || await artifactDigest(modelBytes) !== manifest.modelFile.digest || (!manifest.modelFile.stamped && manifest.modelFile.digest !== head.artifact.digest)) throw new Error('Exported model digest mismatch');
  const diffs: StoredCommitDiff[] = [], identity: IdentityRecordSet[] = [], lineage: NonNullable<HistoryPackageInput['lineage']>[number][] = [];
  const artifacts = new Map<string, CommitPayload>();
  const payload = (data: ArrayBuffer, name: string, digest: string): CommitPayload => ({ bytes: data, fileName: name, artifactDigest: digest, format: /\.ifcx$/i.test(name) ? 'ifcx' : /\.(?:zip|ifczip)$/i.test(name) ? 'ifc-zip' : 'ifc-step' });
  if (!manifest.modelFile.stamped) artifacts.set(head.id, payload(modelBytes, head.artifact.fileName, head.artifact.digest));
  for (const [path, data] of listed) {
    if (path.startsWith('diffs/')) {
      const diff: unknown = JSON.parse(text(path));
      validateDiff(diff, chain);
      if (diffs.some(d => d.base.commitId === diff.base.commitId && d.head.commitId === diff.head.commitId)) throw new Error('Duplicate packaged diff');
      diffs.push(diff);
    } else if (path.startsWith('identity/')) {
      const record = parseIdentityMapSidecar(text(path));
      const pins = path.slice('identity/'.length, -'.json'.length).split('__').map(decodeURIComponent);
      const base = chain.find(c => c.id === pins[0] && c.artifact.digest === record.base.hash), target = chain.find(c => c.id === pins[1] && c.artifact.digest === record.head.hash);
      if (!base || !target) throw new Error('Identity sidecar is pinned to another artifact');
      identity.push({ base: { ...ref(base), artifactDigest: base.artifact.digest }, head: { ...ref(target), artifactDigest: target.artifact.digest }, entries: record.entries, keyProperty: record.keyProperty });
    } else if (path.startsWith('lineage/')) {
      const record = parseLineageSidecar(text(path));
      if (!chain.some(c => c.artifact.digest === record.base.hash) || !chain.some(c => c.artifact.digest === record.head.hash)) throw new Error('Lineage sidecar is pinned to another artifact');
      lineage.push(record);
    } else if (path.startsWith('artifacts/')) {
      const id = decodeURIComponent(path.split('/')[1]);
      const commit = chain.find(c => c.id === id);
      if (!commit || artifacts.has(id) && id !== head.id || await artifactDigest(data) !== commit.artifact.digest) throw new Error('Past artifact digest mismatch');
      artifacts.set(id, payload(data, commit.artifact.fileName, commit.artifact.digest));
    }
  }
  return { manifest, model: manifest.model, chain, diffs, identity, lineage, modelFile: payload(modelBytes, safeName(manifest.modelFile.path), manifest.modelFile.digest), stamped: manifest.modelFile.stamped, artifacts, partial: manifest.partial };
}
