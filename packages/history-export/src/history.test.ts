/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { diffModels } from '@ifc-lite/diff';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import type { SourceCommit, StoredCommitDiff } from '@ifc-lite/plugin-api';
import { artifactDigest, buildHistoryIndex, buildHistoryPackage, readHistoryPackage, stampHistory, markChangeSet, deletedElementsCsv, storeCommitDiff, historyKeyAliases } from './index.js';
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
