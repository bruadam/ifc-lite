/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { diffModels } from '@ifc-lite/diff';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import type { PluginContext, SourceCommit, StoredCommitDiff } from '@ifc-lite/plugin-api';
import { artifactDigest, buildHistoryIndex, buildHistoryPackage, readHistoryPackage, stampHistory, markChangeSet, deletedElementsCsv, storeCommitDiff, historyKeyAliases, createHistoryPackageProvider } from './index.js';
const bytes = (schema = 'IFC4') => new TextEncoder().encode(`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');\nFILE_NAME('wall.ifc','2026-01-01T00:00:00',(),(),'test','test','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n#1=IFCPERSON($,$,'User',$,$,$,$,$);\n#2=IFCORGANIZATION($,'Org',$,$,$);\n#3=IFCPERSONANDORGANIZATION(#1,#2,$);\n#4=IFCAPPLICATION(#2,'1','Test','Test');\n#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);\n#10=IFCWALL('0000000000000000000001',#5,'Wall',$,$,$,$,$${schema === 'IFC2X3' ? '' : ',$'});\nENDSEC;\nEND-ISO-10303-21;`).buffer;
const commit = (id: string, parents: string[] = []): SourceCommit => ({ id, parents, projectId: 'p', modelId: 'm', status: 'published', createdAt: '2026-01-01T00:00:00Z', author: { id: 'u', displayName: 'Author' }, artifact: { digest: id, fileName: 'wall.ifc', sizeBytes: 1 } });
const ref = (id: string) => ({ projectId: 'p', modelId: 'm', commitId: id });
const diff = (base: string, head: string, entries: StoredCommitDiff['entries']): StoredCommitDiff => ({ format: 'ifc-lite/commit-diff', version: 1, base: ref(base), head: ref(head), engine: 'test', options: { scope: 'data', matchUnpairedByContent: false }, counts: { added: 1, deleted: 0, modified: 0, unchanged: 0 }, entries, appliedIdentity: [] });
const added = { key: '0000000000000000000001', ifcType: 'IfcWall', state: 'added' as const, changeKinds: [] };

describe('commit-history spec 04: history survives export and transport', () => {
  it('tracks creation, modification, deletion and reviewed re-keying', () => {
    const chain = [commit('a'), commit('b', ['a']), commit('c', ['b'])];
    const ds = [diff('', 'a', [added]), diff('a', 'b', [{ ...added, key: 'new', baseKey: added.key, state: 'modified', changeKinds: ['data'] }]), diff('b', 'c', [])];
    const index = buildHistoryIndex({ model: { projectId: 'p', modelId: 'm', name: 'Walls' }, chain, diffs: new Map(ds.map(d => [`${d.base.commitId}:${d.head.commitId}`, d])) });
    expect(index.elements.get('new')).toMatchObject({ createdCommitId: 'a', lastChangedCommitId: 'b', changeCount: 2, previousKeys: [added.key] });
    expect(index.elements.has(added.key)).toBe(false);
    expect(buildHistoryIndex({ model: index.model, chain, diffs: new Map([[':a', ds[0]]]) }).partial).toBe(true);
  });
  it('preserves both histories when reviewed identities exchange keys', () => {
    const chain = [commit('one'), commit('two', ['one']), commit('three', ['two'])];
    const a = { ...added, key: 'a' }, b = { ...added, key: 'b' };
    const swapped = { ...diff('two', 'three', [{ ...a, baseKey: 'b', state: 'modified' as const }]), appliedIdentity: [{ base: 'a', here: 'b', reason: 'reviewed' }, { base: 'b', here: 'a', reason: 'reviewed' }] };
    const ds = [diff('', 'one', [a]), diff('one', 'two', [b]), swapped];
    const index = buildHistoryIndex({ model: { projectId: 'p', modelId: 'm', name: 'Walls' }, chain, diffs: new Map(ds.map(d => [`${d.base.commitId}:${d.head.commitId}`, d])) });
    expect(index.elements.get('a')).toMatchObject({ createdCommitId: 'two', changeCount: 2, previousKeys: ['b'] });
    expect(index.elements.get('b')).toMatchObject({ createdCommitId: 'one', changeCount: 1, previousKeys: ['a'] });
  });
  it.each(['IFC2X3', 'IFC4'])('writes parseable history properties and preserves header items in %s', async schema => {
    const store = await new IfcParser().parseColumnar(bytes(schema));
    const view = new MutablePropertyView(store.properties, 'm'); view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
    const chain = [commit('a')];
    const index = buildHistoryIndex({ model: { projectId: 'p', modelId: 'm', name: 'Walls' }, chain, diffs: new Map([[':a', diff('', 'a', [added])]]) });
    expect(stampHistory(store, view, index).stamped).toBe(1);
    const output = new StepExporter(store, view).export({ schema: store.schemaVersion, additionalDescriptions: ['history marker'] });
    const parsed = await new IfcParser().parseColumnar(Uint8Array.from(output.content).buffer);
    const pset = extractPropertiesOnDemand(parsed, 10).find(p => p.name === 'IfcLite_History');
    expect(pset?.properties.find(p => p.name === 'CreatedAt')?.dataType?.toUpperCase()).toBe(schema === 'IFC4' ? 'IFCDATETIME' : 'IFCLABEL');
    expect(pset?.properties.find(p => p.name === 'ChangeCount')?.value).toBe(1);
    expect(parsed.sourceHeader?.description).toContain('ViewDefinition [CoordinationView]');
    expect(parsed.sourceHeader?.description).toContain('history marker');
    expect(() => stampHistory(store, view, index, { psetName: 'Pset_History' })).toThrow('reserved');
    expect(markChangeSet(store, view, diff('base', 'a', [added]), commit('base'), chain[0]).added).toBe(1);
  });
  it('round-trips a package and refuses altered bytes or sidecar pins', async () => {
    const data = bytes(), hash = await artifactDigest(data), head = { ...commit(hash), artifact: { digest: hash, fileName: 'wall.ifc', sizeBytes: data.byteLength } };
    const input = { model: { name: 'Walls' }, chain: [head], diffs: [diff('', hash, [added])], modelFile: { bytes: data, artifactDigest: hash, fileName: 'wall.ifc', format: 'ifc-step' as const } };
    const blob = await buildHistoryPackage(input), pack = await readHistoryPackage(await blob.arrayBuffer());
    expect(pack.artifacts?.get(hash)?.bytes).toEqual(data);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer()); zip.file('model/wall.ifc', 'tampered');
    await expect(readHistoryPackage(await zip.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow('digest');
    await expect(buildHistoryPackage({ ...input, identity: [{ base: { ...ref(hash), artifactDigest: 'wrong' }, head: { ...ref(hash), artifactDigest: hash }, entries: [] }] })).rejects.toThrow('pinned');
  });
  it('streams original deliveries and serves history offline when past payloads are omitted', async () => {
    const first = bytes(), last = new TextEncoder().encode(new TextDecoder().decode(first).replace("'Wall'", "'New wall'")).buffer;
    const chain = await Promise.all([first, last].map(async (data, i) => ({ ...commit(String(i), i ? ['0'] : []), artifact: { digest: await artifactDigest(data), fileName: 'wall.ifc', sizeBytes: data.byteLength } })));
    const payload = (data: ArrayBuffer, i: number) => ({ bytes: data, artifactDigest: chain[i].artifact.digest, fileName: 'wall.ifc', format: 'ifc-step' as const });
    const input = { model: { name: 'Walls' }, chain, diffs: [diff('', '0', [added]), diff('0', '1', [{ ...added, state: 'modified' as const, changeKinds: ['data' as const] }])], modelFile: payload(last, 1), omitAuthors: true };
    const pack = await readHistoryPackage(await (await buildHistoryPackage(input)).arrayBuffer());
    const provider = createHistoryPackageProvider(pack, 'offline');
    const ctx: PluginContext = { fetch, fetchPublic: fetch, getPreference: async () => undefined, storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] }, log: { debug() {}, info() {}, warn() {}, error() {} } };
    const page = await provider.listCommits!(ctx, ref('1'), { limit: 1 });
    expect(page.items[0]).toMatchObject({ id: '1', meta: { historyPackageArtifactIncluded: true } });
    expect(page.items[0].author).toBeUndefined();
    expect((await provider.listCommits!(ctx, ref('1'), { cursor: page.cursor })).items[0].meta?.historyPackageArtifactIncluded).toBe(false);
    await expect(provider.loadCommit!(ctx, ref('0'))).rejects.toThrow('Not included');
    const history = await provider.listElementHistory!(ctx, { projectId: 'p', modelId: 'm', key: added.key });
    expect(history.items.map(entry => entry.state)).toEqual(['modified', 'added']);
    async function* deliveries() { yield ['0', payload(first, 0)] as const; yield ['1', payload(last, 1)] as const; }
    const all = await readHistoryPackage(await (await buildHistoryPackage({ ...input, pastArtifacts: deliveries(), deletedReports: { baseCommitId: '0', csv: 'GlobalId,IfcType' } })).arrayBuffer());
    expect(all.manifest.artifacts).toBe('all');
    expect(all.artifacts?.get('0')?.bytes).toEqual(first);
    expect(all.manifest.files.some(file => file.path === 'changes/deleted-since-0.csv')).toBe(true);
  });
  it('escapes deleted element values for spreadsheet import', () => {
    const csv = deletedElementsCsv(diff('a', 'b', [{ ...added, key: '=CMD()', state: 'deleted' }]), null);
    expect(csv).toContain("'=CMD()");
  });
  it('preserves re-GUID identity when the diff retires content-matched entries', () => {
    const a = { key: 'a', ifcType: 'IfcWall', dataHash: 'wall', ref: 1 };
    const stored = storeCommitDiff(diffModels([a], [{ ...a, key: 'b' }], { scope: 'data', matchUnpairedByContent: true }), ref('one'), ref('two'), true);
    expect(stored.counts).toMatchObject({ added: 0, deleted: 0 });
    expect(stored.appliedIdentity).toContainEqual(expect.objectContaining({ base: 'a', here: 'b' }));
    const next = { ...diff('two', 'three', []), appliedIdentity: [{ base: 'b', here: 'c', reason: 'reviewed' }] };
    expect(historyKeyAliases([commit('one'), commit('two', ['one']), commit('three', ['two'])], [stored, next], 'one', 'three').get('c')).toBe('a');
  });
  it('rejects a packaged diff belonging to another model', async () => {
    const data = bytes(), hash = await artifactDigest(data), head = { ...commit('one'), artifact: { digest: hash, fileName: 'wall.ifc', sizeBytes: data.byteLength } };
    const wrong = { ...diff('', 'one', [added]), head: { ...ref('one'), modelId: 'other' } };
    await expect(buildHistoryPackage({ model: { name: 'Walls' }, chain: [head], diffs: [wrong], modelFile: { bytes: data, artifactDigest: hash, fileName: 'wall.ifc', format: 'ifc-step' } })).rejects.toThrow('another model');
  });

});
