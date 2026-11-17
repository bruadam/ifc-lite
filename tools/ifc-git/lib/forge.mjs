/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The forge's own state: what GitHub keeps server-side and git does not.
 * Pushed branch tips, pull requests, workflow runs, check results and
 * artifacts, all as JSON under `<git-common-dir>/ifc-git/`. Nothing here is
 * committed; it is per-repository bookkeeping, like a hosted forge's database.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commonGitDir, repoRoot } from './git.mjs';

export class Forge {
  constructor(cwd = process.cwd()) {
    this.root = repoRoot(cwd);
    this.dir = join(commonGitDir(this.root), 'ifc-git');
    mkdirSync(this.dir, { recursive: true });
  }

  path(...parts) {
    const p = join(this.dir, ...parts);
    mkdirSync(join(p, '..'), { recursive: true });
    return p;
  }

  read(rel, fallback) {
    const p = join(this.dir, rel);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
  }

  write(rel, value) {
    writeFileSync(this.path(rel), `${JSON.stringify(value, null, 2)}\n`);
  }

  nextId(counter) {
    const ids = this.read('counters.json', {});
    ids[counter] = (ids[counter] ?? 0) + 1;
    this.write('counters.json', ids);
    return ids[counter];
  }

  // Branch tips as the forge last saw them (what `ifc-git push` published).
  pushedTip(branch) { return this.read('branches.json', {})[branch] ?? null; }
  setPushedTip(branch, sha) {
    const tips = this.read('branches.json', {});
    tips[branch] = sha;
    this.write('branches.json', tips);
  }
  pushedBranches() { return this.read('branches.json', {}); }

  // Runs.
  saveRun(run) { this.write(join('runs', `${run.id}.json`), run); }
  run(id) { return this.read(join('runs', `${id}.json`), null); }
  runs() {
    const dir = join(this.dir, 'runs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
      .sort((a, b) => a.id - b.id);
  }
  artifactDir(runId) {
    const dir = join(this.dir, 'artifacts', String(runId));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Check results per commit, keyed by check name. `context` separates a
   * pull request's run on its merge preview from a push run on the same head.
   */
  recordCheck(sha, context, name, result) {
    const rel = join('checks', `${sha}.json`);
    const all = this.read(rel, {});
    all[context] = all[context] ?? {};
    all[context][name] = result;
    this.write(rel, all);
  }
  checks(sha, context) { return this.read(join('checks', `${sha}.json`), {})[context] ?? {}; }

  // Pull requests.
  savePull(pr) { this.write(join('pulls', `${pr.number}.json`), pr); }
  pull(number) {
    const pr = this.read(join('pulls', `${number}.json`), null);
    if (!pr) throw new Error(`no pull request #${number}`);
    return pr;
  }
  pulls() {
    const dir = join(this.dir, 'pulls');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
      .sort((a, b) => a.number - b.number);
  }
}
