/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { surfaceCommand } from '../surface-commands';
import { HistoryPackageDialog } from './HistoryPackageDialog';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
it('commit-history spec 04: the palette opens package export even when the history panel was closed', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('older'), fixtureModel('newer')), historyFocusModelId: 'newer', commitTags: new Map(), localLineage: new Map([['newer', { baseModelId: 'older', decidedAt: 0, evidence: {} }]]) });
  render(<HistoryPackageDialog />);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  act(() => surfaceCommand('file:history-package', 'palette').run({ surface: 'palette' }));
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  const selects = dialog.querySelectorAll('select');
  assert.equal(selects[0].value, 'newer');
  assert.equal(selects[1].value, 'package');
  assert.match(dialog.textContent ?? '', /Past|past|versions/);
});
