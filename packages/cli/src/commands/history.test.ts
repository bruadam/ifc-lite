/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBCF } from '@ifc-lite/bcf';
import { readHistoryPackage, createHistoryPackageProvider } from '@ifc-lite/history-export';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { historyCommand } from './history.js';
import { matchCommand } from './match.js';

const model = (key: string, name: string, extra = true) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('wall.ifc','2026-01-01T00:00:00',(),(),'Test','Test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000000',$,'Project',$,$,$,$,$,$);
#10=IFCWALL('${key}',$,'${name}',$,$,$,$,$,$);
${extra ? "#11=IFCSLAB('0000000000000000000003',$,'Slab',$,$,$,$,$,$);" : ''}
ENDSEC;
END-ISO-10303-21;`;

describe('commit-history specs 03/04: CLI delivery workflow', () => {
  let dir: string, output: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ifclite-history-test-')); output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    await writeFile(join(dir, 'wall_R01.ifc'), model('0000000000000000000001', 'Wall'));
    await writeFile(join(dir, 'wall_R02.ifc'), model('0000000000000000000002', 'Wall'));
    await writeFile(join(dir, 'wall_R03.ifc'), model('0000000000000000000002', 'Changed', false));
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
  const fileBytes = async (path: string) => Uint8Array.from(await readFile(path)).buffer;

  it('matches renamed deliveries using element evidence and rejects mistyped flags', async () => {
    await matchCommand([join(dir, 'wall_R02.ifc'), join(dir, 'wall_R01.ifc'), '--json']);
    expect(JSON.parse(output).results[0]).toMatchObject({ verdict: 'possible-revision', evidence: { guidOverlap: 0.5 } });
    await expect(matchCommand(['a', 'b', '--geometery'])).rejects.toThrow('Unknown option');
  });

  it('builds, inspects, stamps and compares a nonadjacent re-keyed delivery', async () => {
    const packPath = join(dir, 'model.ifchistory.zip');
    await historyCommand(['build', ...[1, 2, 3].map(i => join(dir, `wall_R0${i}.ifc`)), '--by-content', '--include-artifacts', '--out', packPath]);
    const pack = await readHistoryPackage(await fileBytes(packPath));
    expect(pack.chain).toHaveLength(3);
    expect(pack.identity?.[0].entries).toContainEqual(expect.objectContaining({ base: '0000000000000000000001', here: '0000000000000000000002' }));
    // An offline source exposes exactly the original bytes for every included commit.
    const provider = createHistoryPackageProvider(pack, 'test-history');
    expect(provider.manifest.capabilities.commits?.write).toBe(false);
    output = ''; await historyCommand(['inspect', packPath, '--json']);
    expect(JSON.parse(output).commits).toHaveLength(3);
    const stamped = join(dir, 'stamped.ifc');
    await historyCommand(['stamp', packPath, '--out', stamped]);
    const store = await new IfcParser().parseColumnar(await fileBytes(stamped));
    const history = extractPropertiesOnDemand(store, 10).find(p => p.name === 'IfcLite_History');
    expect(history?.properties.find(p => p.name === 'CreatedCommit')?.value).toBe(pack.chain[0].id);
    expect(history?.properties.find(p => p.name === 'PreviousGlobalIds')?.value).toBe('0000000000000000000001');
    const changed = join(dir, 'changed.ifc'), csv = join(dir, 'deleted.csv'), bcf = join(dir, 'deleted.bcf');
    await historyCommand(['changes', packPath, '--since', '1', '--out', changed, '--csv', csv, '--bcf', bcf]);
    const changedStore = await new IfcParser().parseColumnar(await fileBytes(changed));
    const change = extractPropertiesOnDemand(changedStore, 10).find(p => p.name === 'IfcLite_Change');
    expect(change?.properties.find(p => p.name === 'ChangeState')?.value).toBe('Modified');
    expect(await readFile(csv, 'utf8')).toContain('0000000000000000000003');
    expect(await readFile(csv, 'utf8')).not.toContain('0000000000000000000001');
    const project = await readBCF(await fileBytes(bcf));
    const topic = [...project.topics.values()][0];
    expect(topic.viewpoints[0].components?.selection?.map(component => component.ifcGuid)).toEqual(['0000000000000000000003']);
  });

  it('refuses duplicate bytes instead of inventing two distinct commits', async () => {
    const file = join(dir, 'wall_R01.ifc');
    await expect(historyCommand(['build', file, file, '--out', join(dir, 'bad.zip')])).rejects.toThrow('Duplicate delivery');
  });
});
