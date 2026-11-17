/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* oxlint-disable no-template-curly-in-string -- `${{ }}` is workflow expression syntax under test, not a JS template. */

// Pure parts of ifc-git: glob filters, expressions, triggers, matrices.
// No git, no CLI: these run anywhere.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { condition, evaluate, interpolate } from './lib/expr.mjs';
import { globToRegExp, matchesFilters } from './lib/glob.mjs';
import { _test } from './lib/runner.mjs';
import { normalizeOn, triggers } from './lib/workflows.mjs';

test('globs follow the Actions dialect: * stays in a segment, ** crosses them', () => {
  assert.ok(globToRegExp('release/*').test('release/permit'));
  assert.ok(!globToRegExp('release/*').test('release/2026/permit'));
  assert.ok(globToRegExp('release/**').test('release/2026/permit'));
  assert.ok(globToRegExp('**/*.ifc').test('house.ifc'));
  assert.ok(globToRegExp('**/*.ifc').test('models/a/house.ifc'));
  assert.ok(!globToRegExp('**/*.ifc').test('models/house.ifcx'));
  assert.ok(globToRegExp('model.?fc').test('model.ifc'));
  assert.ok(!globToRegExp('a.b').test('axb'), 'a dot is literal');
});

test('filter lists: empty passes, later negations override earlier matches', () => {
  assert.ok(matchesFilters(undefined, 'anything'));
  assert.ok(matchesFilters(['models/**', '!models/archive/**'], 'models/house.ifc'));
  assert.ok(!matchesFilters(['models/**', '!models/archive/**'], 'models/archive/old.ifc'));
  assert.ok(!matchesFilters(['main'], 'feature/x'));
});

test('expressions: paths, comparisons, boolean operators and functions', () => {
  const ctx = { event: 'pull_request', changed: { ifc: ['a.ifc', 'b.ifc'] }, steps: { ids: { outputs: { failed: 2 } } } };
  assert.equal(evaluate("event == 'pull_request'", ctx), true);
  assert.equal(evaluate("event == 'PULL_REQUEST'", ctx), true, 'string equality is case-insensitive, as in Actions');
  assert.equal(evaluate('steps.ids.outputs.failed > 1', ctx), true);
  assert.equal(evaluate("contains(changed.ifc, 'b.ifc') && !contains(changed.ifc, 'c.ifc')", ctx), true);
  assert.equal(evaluate("length(changed.ifc)", ctx), 2);
  assert.equal(evaluate("missing.path || 'fallback'", ctx), 'fallback');
  assert.equal(evaluate("'it''s'", ctx), "it's");
  assert.throws(() => evaluate('process.exit(1)', ctx), /unknown function/);
  assert.throws(() => evaluate("event = 'x'", ctx), /parse|unexpected/);
});

test('interpolation keeps a whole expression typed and stringifies embedded ones', () => {
  const ctx = { project: { models: ['a.ifc', 'b.ifc'] }, matrix: { model: 'a.ifc' } };
  assert.deepEqual(interpolate('${{ project.models }}', ctx), ['a.ifc', 'b.ifc']);
  assert.equal(interpolate('check ${{ matrix.model }} now', ctx), 'check a.ifc now');
  assert.equal(interpolate('all: ${{ project.models }}', ctx), 'all: a.ifc b.ifc');
  assert.deepEqual(interpolate({ with: { model: '${{ matrix.model }}', n: 3 } }, ctx), { with: { model: 'a.ifc', n: 3 } });
  assert.deepEqual(interpolate(['${{ project.models }}', 'c.ifc'], ctx), ['a.ifc', 'b.ifc', 'c.ifc']);
});

test('if: conditions imply success() unless they name a status function', () => {
  assert.equal(condition(undefined, { __status: 'success' }), true);
  assert.equal(condition(undefined, { __status: 'failure' }), false);
  assert.equal(condition("event == 'push'", { event: 'push', __status: 'failure' }), false);
  assert.equal(condition('${{ always() }}', { __status: 'failure' }), true);
  assert.equal(condition('failure()', { __status: 'failure' }), true);
});

test('triggers: events, branch filters and path filters', () => {
  const wf = { on: normalizeOn({ push: { branches: ['main', 'release/**'], paths: ['**/*.ifc'] }, pull_request: { branches: ['main'] } }) };
  assert.ok(triggers(wf, { name: 'push', branch: 'main', changed: ['models/house.ifc'] }));
  assert.ok(!triggers(wf, { name: 'push', branch: 'main', changed: ['README.md'] }), 'no relevant path');
  assert.ok(!triggers(wf, { name: 'push', branch: 'feature/x', changed: ['a.ifc'] }), 'branch filtered');
  assert.ok(triggers(wf, { name: 'pull_request', branch: 'main', changed: [] }));
  assert.ok(!triggers(wf, { name: 'workflow_dispatch', branch: 'main', changed: [] }));
  assert.deepEqual(Object.keys(normalizeOn('push')), ['push']);
  assert.throws(() => normalizeOn({ schedule: {} }), /unsupported trigger/);
});

test('matrices expand to every combination; an empty list expands to nothing', () => {
  const combos = _test.expandMatrix({ model: '${{ models }}', mode: ['hard', 'clearance'] }, { models: ['a', 'b'] });
  assert.equal(combos.length, 4);
  assert.deepEqual(combos[0], { model: 'a', mode: 'hard' });
  assert.deepEqual(_test.expandMatrix({ model: '${{ models }}' }, { models: [] }), []);
  assert.deepEqual(_test.expandMatrix(undefined, {}), [null]);
});

test('jobs run in needs order and a cycle is refused', () => {
  assert.deepEqual(_test.topoOrder({ c: { needs: ['b'] }, b: { needs: 'a' }, a: {} }), ['a', 'b', 'c']);
  assert.throws(() => _test.topoOrder({ a: { needs: ['b'] }, b: { needs: ['a'] } }), /cycle/);
});
