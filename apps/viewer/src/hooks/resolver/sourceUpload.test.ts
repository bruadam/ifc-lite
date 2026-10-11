/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureContext, createFixtureSourceProvider } from '@ifc-lite/source-fixture';
import { matchModels, type MatchSubject } from '@ifc-lite/model-match';
import { uploadRevision } from './sourceUpload';

const fingerprint = { key: 'wall', ifcType: 'IfcWall', dataHash: 'wall', ref: 1 };
const subject: MatchSubject = { id: 'delivery', label: 'Wall', fileName: 'Wall_R03.ifc', fingerprints: [fingerprint] };
async function setup(changed: boolean) {
  const provider = createFixtureSourceProvider({ world: { projects: [{ id: 'p', name: 'Project', containers: [], files: [], models: [{ id: 'm', name: 'Wall', commits: [
    { id: 'a', parents: [], createdAt: '2026-01-01T00:00:00Z', fileName: 'Wall_R01.ifc', content: 'old', fingerprints: [fingerprint] },
    { id: 'b', parents: ['a'], createdAt: '2026-01-02T00:00:00Z', fileName: 'Wall_R02.ifc', content: 'new head', fingerprints: changed ? [{ key: 'pipe', ifcType: 'IfcPipeSegment', dataHash: 'pipe' }] : [fingerprint] },
  ] }] }] } });
  const ctx = createFixtureContext();
  const match = await matchModels(subject, [{ id: 'm', label: 'Wall', fileName: 'Wall_R01.ifc', fingerprints: [fingerprint], origin: 'source' }]);
  const model = { ...await provider.getModel!(ctx, { projectId: 'p', modelId: 'm' }), headCommitId: 'a' };
  return { provider, ctx, projectId: 'p', model, subject, match, bytes: new TextEncoder().encode('delivery').buffer, message: 'Delivery', idempotencyKey: 'delivery-1', signal: new AbortController().signal };
}
it('commit-history spec 03: stale heads retry once against the evaluated replacement', async () => {
  const input = await setup(false);
  const uploaded = await uploadRevision(input);
  assert.deepEqual(uploaded.parents, ['b']);
  const model = await input.provider.getModel!(input.ctx, { projectId: 'p', modelId: 'm' });
  assert.equal(model.commitCount, 3);
  assert.equal(model.headCommitId, uploaded.id);
});
it('commit-history spec 03: a changed verdict requires review and writes no commit', async () => {
  const input = await setup(true);
  await assert.rejects(uploadRevision(input), /review the updated match/);
  assert.equal((await input.provider.getModel!(input.ctx, { projectId: 'p', modelId: 'm' })).commitCount, 2);
});
it('commit-history spec 03: an aborted upload leaves the source unchanged', async () => {
  const input = await setup(false), abort = new AbortController(); abort.abort();
  await assert.rejects(uploadRevision({ ...input, signal: abort.signal }), { name: 'AbortError' });
  assert.equal((await input.provider.getModel!(input.ctx, { projectId: 'p', modelId: 'm' })).commitCount, 2);
});
