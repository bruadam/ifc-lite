/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureContext, createFixtureSourceProvider } from '@ifc-lite/source-fixture';
import { cleanup, render, click, advance } from '@/test/render.js';
import { SOURCE_DOWNLOAD_EVENT, type SourceDownloadItem } from '@/services/sources/source-host';
import { CommitModelsStep } from './CommitModelsStep';

afterEach(cleanup);
const makeProvider = () => createFixtureSourceProvider({ world: { projects: [{ id: 'p', name: 'Project', containers: [], files: [], models: [{ id: 'm', name: 'Architecture', commits: [{ id: 'c', parents: [], fileName: 'Architecture.ifc', content: 'original delivery' }] }] }] } });
for (const tampered of [false, true]) it(`commit-history: browsing a source ${tampered ? 'rejects altered bytes with unchanged metadata' : 'opens the head through the canonical bridge'}`, async () => {
  const provider = makeProvider(), ctx = createFixtureContext();
  if (tampered) {
    const original = provider.loadCommit!;
    provider.loadCommit = async (...args) => ({ ...await original(...args), bytes: new TextEncoder().encode('wrong delivery').buffer });
  }
  let error: string | null = null;
  const items: SourceDownloadItem[] = [];
  const capture = (event: Event) => { if (event instanceof CustomEvent) items.push(...event.detail.items as SourceDownloadItem[]); };
  window.addEventListener(SOURCE_DOWNLOAD_EVENT, capture);
  try {
    const ui = render(<CommitModelsStep provider={provider} ctx={ctx} projectId="p" onError={value => { error = value; }} />);
    await advance(20);
    const model = [...ui.querySelectorAll('button')].find(button => button.textContent?.includes('Architecture'));
    assert.ok(model); click(model); await advance(50);
    if (tampered) { assert.equal(items.length, 0); assert.match(error ?? '', /do not match/); }
    else {
      assert.equal(error, null); assert.equal(items.length, 1);
      assert.equal(new TextDecoder().decode(items[0].buffer), 'original delivery');
      assert.equal(items[0].commit?.commitId, 'c');
      assert.equal(items[0].commit?.historical, false);
      assert.equal(items[0].displayName, 'Architecture');
    }
  } finally { window.removeEventListener(SOURCE_DOWNLOAD_EVENT, capture); }
});
