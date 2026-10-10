/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { diffModels, parseIdentityMapSidecar, identityMapSidecarMismatches, keyAliasesFromSidecar, parseLineageSidecar, lineageSidecarMismatches, keyAliasesFromLineage, type EntityFingerprint } from '@ifc-lite/diff';
import { buildHistoryPackage, readHistoryPackage, historyKeyAliases, artifactDigest, buildHistoryIndex, stampHistory, markChangeSet, deletedElementsBcf, deletedElementsCsv, storeCommitDiff, type HistoryPackage } from '@ifc-lite/history-export';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { extractPropertiesOnDemand } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import type { CommitPayload, SourceCommit, StoredCommitDiff, IdentityRecordSet } from '@ifc-lite/plugin-api';
import { parseIfcBytes } from '../loader.js';
import { historyArgs, historyInput } from './history-input.js';
import { buildFileFingerprints } from './diff-engine.js';

const ref = (commit: SourceCommit) => ({ projectId: commit.projectId, modelId: commit.modelId, commitId: commit.id });
async function writeBlob(path: string, blob: Blob) { await writeFile(path, new Uint8Array(await blob.arrayBuffer())); }

export async function historyCommand(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === 'build') { await build(rest); return; }
  if (!['inspect', 'stamp', 'changes'].includes(command)) throw new Error('Usage: ifc-lite history build|inspect|stamp|changes ...');
  const options = historyArgs(rest, ['--out', '--since', '--pset', '--bcf', '--csv'], ['--json', '--omit-authors']);
  if (options.files.length !== 1) throw new Error('Provide one .ifchistory.zip package');
  const pack = await readHistoryPackage(Uint8Array.from(await readFile(options.files[0])).buffer);
  if (command === 'inspect') {
    process.stdout.write(options.has('--json') ? JSON.stringify({ manifest: pack.manifest, commits: pack.chain }, null, 2) + '\n' : pack.chain.map((c, i) => `${i + 1}\t${c.id}\t${c.createdAt}\t${c.message ?? ''}`).join('\n') + '\n');
    return;
  }
  const output = options.value('--out');
  if (!output) throw new Error('--out is required');
  const head = pack.chain.at(-1)!;
  // Stamping always starts from the original artifact, never from a derived copy.
  const payload = pack.artifacts?.get(head.id);
  if (!payload) throw new Error('The original exported artifact is not included in this package');
  const store = await parseIfcBytes(new Uint8Array(payload.bytes), payload.fileName);
  const view = new MutablePropertyView(store.properties, head.modelId);
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  let base: SourceCommit | undefined;
  if (command === 'stamp') {
    const index = buildHistoryIndex({ model: { name: pack.model.name, modelId: head.modelId, projectId: head.projectId }, chain: pack.chain, diffs: new Map(pack.diffs.map(d => [`${d.base.commitId}:${d.head.commitId}`, d])) });
    const report = stampHistory(store, view, index, { psetName: options.value('--pset'), omitAuthors: options.has('--omit-authors') });
    if (index.partial) process.stderr.write(`History is partial; ${report.withoutHistory} elements have no history properties.\n`);
  } else {
    const since = options.value('--since');
    if (!since) throw new Error('--since <commit-id|1-based-index> is required');
    base = pack.chain.find(c => c.id === since) ?? (/^[1-9]\d*$/.test(since) ? pack.chain[Number(since) - 1] : undefined);
    if (!base || base.id === head.id) throw new Error('--since must select an earlier commit');
    const diff = await packageDiff(pack, base, head);
    markChangeSet(store, view, diff, base, head, { psetName: options.value('--pset') });
    if (options.value('--csv')) await writeFile(options.value('--csv')!, deletedElementsCsv(diff, null));
    if (options.value('--bcf')) await writeBlob(options.value('--bcf')!, await deletedElementsBcf(diff, null, { base, head, modelName: pack.model.name }));
  }
  const result = new StepExporter(store, view).export({ schema: store.schemaVersion, applyMutations: true, filename: basename(output), additionalDescriptions: [`ifc-lite-export(${command === 'stamp' ? 'history' : 'change-set'}); commit=${head.id}; base=${base?.id ?? ''}; source-digest=${head.artifact.digest}`] });
  await writeFile(output, result.content);
  process.stdout.write(JSON.stringify({ output, digest: await artifactDigest(Uint8Array.from(result.content).buffer), ...result.stats }) + '\n');
}

async function build(args: string[]) {
  const options = historyArgs(args, ['--out', '--identity-in', '--lineage-in'], ['--by-content', '--geometry', '--include-artifacts', '--omit-authors']);
  if (!options.files.length) throw new Error('Usage: ifc-lite history build <v1.ifc> <v2.ifc> ... --out package.ifchistory.zip');
  const chain: SourceCommit[] = [], diffs: StoredCommitDiff[] = [], identity: IdentityRecordSet[] = [];
  const identitySidecars = await Promise.all((options.flags.get('--identity-in') ?? []).map(async p => parseIdentityMapSidecar(await readFile(p, 'utf8'))));
  const lineageSidecars = await Promise.all((options.flags.get('--lineage-in') ?? []).map(async p => parseLineageSidecar(await readFile(p, 'utf8'))));
  const used = new Set<unknown>();
  let previous: EntityFingerprint[] = [], payload: CommitPayload | undefined;
  for (const path of options.files) {
    const input = await historyInput(path, options.has('--geometry'));
    const digest = input.subject.digest!;
    if (chain.some(c => c.id === digest)) throw new Error(`Duplicate delivery bytes: ${path}`);
    const parent = chain.at(-1);
    const commit: SourceCommit = { id: digest, projectId: 'local', modelId: 'model', parents: parent ? [parent.id] : [], createdAt: (await stat(path)).mtime.toISOString(), message: basename(path), status: 'published', artifact: { digest, fileName: basename(path), sizeBytes: input.bytes.byteLength, schema: input.store.schemaVersion } };
    const pins = { base: { hash: parent?.artifact.digest ?? '' }, head: { hash: digest } };
    const aliases = new Map<string, string>();
    for (const sidecar of identitySidecars) if (identityMapSidecarMismatches(sidecar, pins).length === 0) { used.add(sidecar); for (const [here, base] of keyAliasesFromSidecar(sidecar)) aliases.set(here, base); }
    for (const sidecar of lineageSidecars) if (lineageSidecarMismatches(sidecar, pins).length === 0) { used.add(sidecar); for (const [here, base] of keyAliasesFromLineage(sidecar.entries)) aliases.set(here, base); }
    const diff = storeCommitDiff(diffModels(previous, input.fingerprints, { scope: options.has('--geometry') ? 'both' : 'data', matchUnpairedByContent: options.has('--by-content'), keyAliases: aliases }), parent ? ref(parent) : { ...ref(commit), commitId: '' }, ref(commit), options.has('--by-content'));
    if (parent && diff.appliedIdentity.length) identity.push({ base: { ...ref(parent), artifactDigest: parent.artifact.digest }, head: { ...ref(commit), artifactDigest: digest }, entries: diff.appliedIdentity });
    diffs.push(diff); chain.push({ ...commit, stats: diff.counts });
    payload = { bytes: input.bytes, fileName: basename(path), artifactDigest: digest, format: /\.(ifczip|zip)$/i.test(path) ? 'ifc-zip' : 'ifc-step' };

    previous = input.fingerprints;
  }
  if (used.size !== identitySidecars.length + lineageSidecars.length) throw new Error('A supplied sidecar does not pin to an adjacent pair of deliveries');
  async function* pastArtifacts() {
    for (let i = 0; i < options.files.length; i++) yield [chain[i].id, { bytes: Uint8Array.from(await readFile(options.files[i])).buffer, fileName: chain[i].artifact.fileName, artifactDigest: chain[i].artifact.digest, format: /\.(ifczip|zip)$/i.test(options.files[i]) ? 'ifc-zip' as const : 'ifc-step' as const }] as const;
  }
  const out = options.value('--out') ?? 'history.ifchistory.zip';
  await writeBlob(out, await buildHistoryPackage({ model: { name: basename(options.files.at(-1)!), projectId: 'local', modelId: 'model' }, chain, diffs, modelFile: payload!, pastArtifacts: options.has('--include-artifacts') ? pastArtifacts() : undefined, identity, lineage: lineageSidecars, omitAuthors: options.has('--omit-authors') }));
  process.stdout.write(JSON.stringify({ output: out, commits: chain.length }) + '\n');
}

async function packageDiff(pack: HistoryPackage, base: SourceCommit, head: SourceCommit): Promise<StoredCommitDiff> {
  const stored = pack.diffs.find(d => d.base.commitId === base.id && d.head.commitId === head.id);
  if (stored) return stored;
  const a = pack.artifacts?.get(base.id), b = pack.artifacts?.get(head.id);
  if (!a || !b) throw new Error('This comparison requires past artifacts; rebuild with --include-artifacts');
  return storeCommitDiff(diffModels(buildFileFingerprints(await parseIfcBytes(new Uint8Array(a.bytes))), buildFileFingerprints(await parseIfcBytes(new Uint8Array(b.bytes))), { scope: 'data', keyAliases: historyKeyAliases(pack.chain, pack.diffs, base.id, head.id) }), ref(base), ref(head));
}
