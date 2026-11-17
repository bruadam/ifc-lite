/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ifc-git against a real repository, a real IFC model and the real ifc-lite
// CLI: workflows on push, branch protection, the pull request gates, and the
// semantic conflict analysis. Skips when the CLI has not been built.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const CLI = process.env.IFC_LITE || join(root, 'packages/cli/dist/index.js');
const SAMPLE = join(root, 'apps/viewer/public/samples/building-architecture.ifc');
const IDS = join(here, 'demo/architecture/specs/architecture.ids');
const skip = !existsSync(CLI) ? `ifc-lite CLI not built (${CLI})` : false;

const { Forge } = await import('./lib/forge.mjs');
const { pushBranch, PushRejected } = await import('./lib/push.mjs');
const { approvePull, mergePull, openPull } = await import('./lib/pulls.mjs');
const { analyzePath } = await import('./lib/conflicts.mjs');
const { revParse } = await import('./lib/git.mjs');

const quiet = { log: () => {} };
let repo;
let env;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}
function as(name) {
  env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name, GIT_AUTHOR_EMAIL: `${name}@x`, GIT_COMMITTER_EMAIL: `${name}@x` };
}
function mutate(...args) {
  sh(process.execPath, [CLI, 'mutate', 'model.ifc', ...args, '--out', 'model.ifc']);
}
function commit(message) { sh('git', ['commit', '-qam', message]); }

const WORKFLOW = `name: Checks
on:
  push:
    paths: ['**/*.ifc']
  pull_request:
    branches: [main]
jobs:
  validate:
    steps:
      - uses: ifc-lite/validate
        with: { model: '\${{ project.models }}' }
  ids:
    needs: validate
    steps:
      - uses: ifc-lite/ids
        with: { model: model.ifc, ids: requirements.ids }
  report-failure:
    needs: ids
    if: \${{ failure() }}
    steps:
      - run: echo "ids failed on \${{ branch }}"
`;

before(() => {
  if (skip) return;
  repo = mkdtempSync(join(tmpdir(), 'ifc-git-test-'));
  as('Ana');
  sh('git', ['init', '-q', '-b', 'main']);
  copyFileSync(SAMPLE, join(repo, 'model.ifc'));
  copyFileSync(IDS, join(repo, 'requirements.ids'));
  mkdirSync(join(repo, '.ifc-git/workflows'), { recursive: true });
  writeFileSync(join(repo, '.gitattributes'), '*.ifc binary\n');
  writeFileSync(join(repo, '.ifc-git/project.yml'), 'name: t\nmodels: [model.ifc]\n');
  writeFileSync(join(repo, '.ifc-git/protection.yml'), 'branches:\n  main:\n    required_checks: [checks/validate, checks/ids]\n    required_approvals: 1\n');
  writeFileSync(join(repo, '.ifc-git/workflows/checks.yml'), WORKFLOW);
  sh('git', ['add', '-A']);
  commit('initial');
});

after(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

test('a push runs the workflows: validate passes, IDS fails, and a failure() job runs', { skip }, async () => {
  const forge = new Forge(repo);
  const { runs } = await pushBranch(forge, 'main', quiet);
  assert.equal(runs.length, 1);
  const status = Object.fromEntries(runs[0].jobs.map((j) => [j.id, j.status]));
  assert.deepEqual(status, { validate: 'success', ids: 'failure', 'report-failure': 'success' });
  const ids = runs[0].jobs.find((j) => j.id === 'ids').steps[0];
  assert.match(ids.annotations[0].message, /ObjectType/);
  assert.equal(forge.checks(revParse(repo, 'main'), 'push')['checks/ids'].status, 'failure');
});

test('a protected branch refuses direct pushes once it exists on the forge', { skip }, async () => {
  const forge = new Forge(repo);
  mutate('--type', 'IfcSlab', '--set', 'Name=Slab');
  commit('direct');
  await assert.rejects(pushBranch(forge, 'main', quiet), PushRejected);
  sh('git', ['reset', '-q', '--hard', 'HEAD~1']);
});

test('a pull request merges only when checks pass and someone else approves', { skip }, async () => {
  const forge = new Forge(repo);
  sh('git', ['switch', '-q', '-c', 'fix']);
  mutate('--type', 'IfcBuildingElementProxy', '--set', 'ObjectType=Furniture');
  commit('fix proxies');
  sh('git', ['switch', '-q', 'main']);
  const pr = await openPull(repo, { head: 'fix', base: 'main', title: 'Fix', author: 'Ana', ...quiet });
  assert.equal(pr.models[0].counts.modified, 5, 'five proxies gained an ObjectType');
  assert.ok(pr.models[0].changes.every((c) => c.changedComponents.includes('attr:core')));

  const blocked = await mergePull(forge, pr.number, { by: 'Ana', ...quiet });
  assert.equal(blocked.merged, false);
  assert.deepEqual(blocked.status.blockers, ['1 more approval(s) required']);
  assert.throws(() => approvePull(forge, pr.number, 'Ana'), /author/);

  approvePull(forge, pr.number, 'Ben');
  const preview = forge.pull(pr.number).preview.sha;
  const merged = await mergePull(forge, pr.number, { by: 'Ben', ...quiet });
  assert.equal(merged.merged, true);
  assert.equal(revParse(repo, 'main'), merged.sha);
  assert.equal(sh('git', ['rev-parse', `${merged.sha}^{tree}`]), sh('git', ['rev-parse', `${preview}^{tree}`]), 'what was checked is what landed');
  assert.equal(sh('git', ['show', '-s', '--format=%an', merged.sha]), 'Ben');
  assert.equal(forge.checks(merged.sha, 'push')['checks/ids'].status, 'success', 'main is green after the fix');
});

test('semantic conflicts: same component of the same element conflicts; different elements are compatible', { skip }, () => {
  const base = revParse(repo, 'main');
  sh('git', ['switch', '-q', '-c', 'alice', base]);
  mutate('--type', 'IfcWall', '--set', 'Pset_WallCommon.FireRating=EI60');
  commit('fire');
  sh('git', ['switch', '-q', '-c', 'bob', base]);
  mutate('--id', '353', '--set', 'Pset_WallCommon.AcousticRating=Rw45');
  commit('acoustics');
  sh('git', ['switch', '-q', '-c', 'carol', base]);
  mutate('--type', 'IfcRoof', '--set', 'Name=Roof');
  commit('roof');
  sh('git', ['switch', '-q', 'main']);

  const clash = analyzePath(repo, 'model.ifc', { ancestor: base, ours: revParse(repo, 'bob'), theirs: revParse(repo, 'alice') });
  assert.equal(clash.verdict, 'conflict');
  assert.equal(clash.conflicts.length, 1);
  assert.equal(clash.conflicts[0].ifcType, 'IfcWall');
  assert.deepEqual(clash.conflicts[0].components, ['pset:Pset_WallCommon']);

  const fine = analyzePath(repo, 'model.ifc', { ancestor: base, ours: revParse(repo, 'carol'), theirs: revParse(repo, 'alice') });
  assert.equal(fine.verdict, 'compatible');
  assert.equal(fine.oursOnly, 1);
  assert.equal(fine.theirsOnly, 4);
});
