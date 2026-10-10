/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { matchModels, type MatchResult } from '@ifc-lite/model-match';
import { cleanup, click, render } from '@/test/render.js';
import { RevisionResolverDialog, type RevisionChoice } from './RevisionResolverDialog';

afterEach(cleanup);
async function result(sampled = false): Promise<MatchResult> {
  const fingerprints = [{ key: 'wall', ifcType: 'IfcWall', dataHash: 'wall', ref: 1 }];
  return matchModels({ id: 'new', label: 'Wall R2', fileName: 'Wall_R2.ifc', fingerprints, sampled }, [{ id: 'old', label: 'Wall R1', fileName: 'Wall_R1.ifc', fingerprints, origin: 'loaded' }]);
}
const labels = new Map([['new', 'Wall R2'], ['old', 'Wall R1']]);
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.includes(text));
  assert.ok(found, `button ${text}`); return found;
}
it('commit-history spec 03: a likely suggestion changes nothing until confirmed', async () => {
  let choices: RevisionChoice[] | undefined;
  render(<RevisionResolverDialog results={[await result()]} labels={labels} onConfirm={value => { choices = value; }} onLater={() => {}} />);
  assert.equal(document.querySelector('select')?.value, 'old');
  assert.equal(choices, undefined);
  click(button('Confirm'));
  assert.deepEqual(choices, [{ modelId: 'new', baseId: 'old', hide: true, compare: true }]);
});
it('commit-history spec 03: possible matches require a choice and Later is separate from accepting', async () => {
  let confirmed = false, later = false;
  render(<RevisionResolverDialog results={[await result(true)]} labels={labels} onConfirm={() => { confirmed = true; }} onLater={() => { later = true; }} />);
  assert.equal(document.querySelector('select')?.value, '');
  assert.equal(button('Confirm').disabled, true);
  click(button('later')); assert.equal(later, true); assert.equal(confirmed, false);
});
it('commit-history spec 03: a batch cannot assign two deliveries to the same model', async () => {
  const a = await result(), b = { ...a, subjectId: 'second' };
  render(<RevisionResolverDialog results={[a, b]} labels={labels} onConfirm={() => { throw new Error('must be disabled'); }} onLater={() => {}} />);
  assert.equal(button('Confirm').disabled, true);
  assert.ok(document.querySelector('[role="alert"]'));
  const select = document.querySelectorAll('select')[1];
  act(() => { select.value = 'new'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(button('Confirm').disabled, false);
});
