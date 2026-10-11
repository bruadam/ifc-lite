#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Reproducible, controlled-edit evidence on the catalogued Archicad house.
// Run after pnpm build and pnpm fixtures ara3d/AC20-FZK-Haus.ifc.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyInput } from '../packages/cli/dist/commands/history-input.js';
import { extractPropertiesOnDemand } from '../packages/parser/dist/index.js';
import { readHistoryPackage, buildHistoryIndex, artifactDigest } from '../packages/history-export/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = resolve(root, 'tests/models/ara3d/AC20-FZK-Haus.ifc');
if (!existsSync(fixture)) {
  console.log('SKIP: fetch the Archicad fixture with pnpm fixtures ara3d/AC20-FZK-Haus.ifc');
  process.exit(0);
}
const directory = resolve(process.argv[2] ?? '/tmp/ifclite-history-evidence');
await mkdir(directory, { recursive: true });
const path = name => resolve(directory, name);
const original = await readFile(fixture);
const first = original.toString('utf8');
const wall = first.split(/\r?\n/).find(line => /^#15042=\s*IFCWALLSTANDARDCASE\(/.test(line));
assert.ok(wall, 'Expected the catalogued Archicad wall');
const oldKey = '2XPyKWY018sA1ygZKgQPtU', newKey = '0XPyKWY018sA1ygZKgQPtU';
assert.ok(wall.includes(oldKey) && wall.includes("'Wand-Int-ERDG-4'"));
const renamed = wall.replace("'Wand-Int-ERDG-4'", "'History verification wall'");
const second = first.replace(wall, renamed);
const third = second.replace(renamed, renamed.replace(oldKey, newKey));
await writeFile(path('Haus_R01.ifc'), original);
await writeFile(path('Haus_R02.ifc'), second);
await writeFile(path('Haus_R03.ifc'), third);
function cli(args) {
  return JSON.parse(execFileSync(process.execPath, [resolve(root, 'packages/cli/dist/index.js'), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }));
}
const build = cli(['history', 'build', ...[1, 2, 3].map(i => path(`Haus_R0${i}.ifc`)), '--geometry', '--by-content', '--include-artifacts', '--out', path('Haus.ifchistory.zip')]);
assert.equal(build.commits, 3);
const match = cli(['match', path('Haus_R03.ifc'), path('Haus_R02.ifc'), '--geometry', '--json']);
assert.equal(match.results[0].verdict, 'likely-revision');
const stamp = cli(['history', 'stamp', path('Haus.ifchistory.zip'), '--out', path('Haus-stamped.ifc')]);
const changes = cli(['history', 'changes', path('Haus.ifchistory.zip'), '--since', '1', '--out', path('Haus-changes.ifc'), '--csv', path('deleted.csv'), '--bcf', path('deleted.bcf')]);
const pack = await readHistoryPackage(Uint8Array.from(await readFile(path('Haus.ifchistory.zip'))).buffer);
const index = buildHistoryIndex({ model: { name: 'House', projectId: 'local', modelId: 'model' }, chain: pack.chain, diffs: new Map(pack.diffs.map(diff => [`${diff.base.commitId}:${diff.head.commitId}`, diff])) });
assert.equal(index.partial, false);
assert.equal(index.elements.get(newKey)?.createdCommitId, pack.chain[0].id);
assert.ok(index.elements.get(newKey)?.previousKeys.includes(oldKey));
const head = await historyInput(path('Haus_R03.ifc'), true);
const stamped = await historyInput(path('Haus-stamped.ifc'), true);
const changed = await historyInput(path('Haus-changes.ifc'), true);
function geometry(input) {
  return input.fingerprints.filter(entry => entry.geometryHash !== undefined).map(entry => [entry.key, String(entry.geometryHash)]).sort((a, b) => a[0].localeCompare(b[0]));
}
assert.deepEqual(geometry(stamped), geometry(head));
assert.deepEqual(geometry(changed), geometry(head));
const properties = (input, pset) => Object.fromEntries(extractPropertiesOnDemand(input.store, 15042).find(set => set.name === pset).properties.map(property => [property.name, property.value]));
assert.equal(properties(stamped, 'IfcLite_History').CreatedCommit, pack.chain[0].id);
assert.equal(properties(stamped, 'IfcLite_History').PreviousGlobalIds, oldKey);
assert.equal(properties(changed, 'IfcLite_Change').ChangeState, 'Modified');
assert.equal(properties(changed, 'IfcLite_Change').PreviousGlobalId, oldKey);
for (const description of head.store.sourceHeader.description) assert.ok(stamped.store.sourceHeader.description.includes(description));
const receipt = { fixture: 'ara3d/AC20-FZK-Haus.ifc', originalDigest: await artifactDigest(Uint8Array.from(original).buffer), authoringSystem: head.store.sourceHeader.originatingSystem, schema: head.store.schemaVersion, controlledEdits: ['#15042 Name', '#15042 GlobalId'], commits: pack.chain.map(commit => commit.id), verdict: match.results[0].verdict, geometryFingerprints: geometry(head).length, geometryHashesUnchanged: true, stampDigest: stamp.digest, changesDigest: changes.digest, wallHistory: properties(stamped, 'IfcLite_History'), wallChanges: properties(changed, 'IfcLite_Change') };
await writeFile(path('receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
