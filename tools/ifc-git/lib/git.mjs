/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Thin, synchronous git helpers. Every call goes through `git()`, which
 * throws with the command and stderr on a non-zero exit unless `allowFail`
 * is set, so a failing git step can never be mistaken for an empty answer.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Identity used for commits the tool itself writes (merges, resolutions, bot bumps). */
export const BOT = { name: 'ifc-git[bot]', email: 'ifc-git-bot@localhost' };

export function git(args, { cwd, env, allowFail = false, input, binary = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: binary ? undefined : 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    const stderr = binary ? result.stderr.toString('utf8') : result.stderr;
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${stderr.trim()}`);
  }
  if (allowFail) return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  return binary ? result.stdout : result.stdout.trimEnd();
}

/** Author/committer env for a commit, falling back to the bot when git has no identity. */
export function identityEnv(person = BOT) {
  return {
    GIT_AUTHOR_NAME: person.name,
    GIT_AUTHOR_EMAIL: person.email,
    GIT_COMMITTER_NAME: person.name,
    GIT_COMMITTER_EMAIL: person.email,
  };
}

export function repoRoot(cwd = process.cwd()) {
  return git(['rev-parse', '--show-toplevel'], { cwd });
}

export function commonGitDir(cwd) {
  return resolve(cwd, git(['rev-parse', '--git-common-dir'], { cwd }));
}

export function currentBranch(cwd) {
  const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, allowFail: true });
  return r.ok ? r.stdout.trim() : null;
}

export function revParse(cwd, rev) {
  const r = git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd, allowFail: true });
  return r.ok ? r.stdout.trim() : null;
}

export function branchExists(cwd, branch) {
  return revParse(cwd, `refs/heads/${branch}`) !== null;
}

export function mergeBase(cwd, a, b) {
  const r = git(['merge-base', a, b], { cwd, allowFail: true });
  return r.ok ? r.stdout.trim() : null;
}

export function isAncestor(cwd, a, b) {
  return git(['merge-base', '--is-ancestor', a, b], { cwd, allowFail: true }).ok;
}

/** Paths that differ between two commits; `from === null` means "everything in `to`". */
export function changedFiles(cwd, from, to) {
  const out = from
    ? git(['diff', '--name-only', '--no-renames', from, to], { cwd })
    : git(['ls-tree', '-r', '--name-only', to], { cwd });
  return out ? out.split('\n').filter(Boolean) : [];
}

export function listFiles(cwd, rev, dir = '') {
  const args = ['ls-tree', '-r', '--name-only', rev];
  if (dir) args.push('--', dir);
  const out = git(args, { cwd });
  return out ? out.split('\n').filter(Boolean) : [];
}

export function fileExistsAt(cwd, rev, path) {
  return git(['cat-file', '-e', `${rev}:${path}`], { cwd, allowFail: true }).ok;
}

export function readTextAt(cwd, rev, path) {
  return git(['show', `${rev}:${path}`], { cwd });
}

/** Write one blob, byte for byte, to `dest`. */
export function extractBlob(cwd, rev, path, dest) {
  writeFileSync(dest, git(['show', `${rev}:${path}`], { cwd, binary: true }));
}

export function commitInfo(cwd, rev) {
  const out = git(['show', '-s', '--format=%H%x00%P%x00%an%x00%aI%x00%s', rev], { cwd });
  const [sha, parents, author, date, subject] = out.split('\0');
  return { sha, parents: parents ? parents.split(' ') : [], author, date, subject };
}

export function log(cwd, rev, limit = 50) {
  const out = git(['log', '--first-parent', `-n${limit}`, '--format=%H', rev], { cwd });
  return out ? out.split('\n').filter(Boolean).map((sha) => commitInfo(cwd, sha)) : [];
}

export function localBranches(cwd) {
  const out = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd });
  return out ? out.split('\n').filter(Boolean) : [];
}

/** A detached, throwaway worktree at `rev`. Call the returned `remove()` in `finally`. */
export function tempWorktree(cwd, rev) {
  const dir = mkdtempSync(join(tmpdir(), 'ifc-git-wt-'));
  git(['worktree', 'add', '--quiet', '--detach', dir, rev], { cwd });
  return {
    dir,
    remove() {
      git(['worktree', 'remove', '--force', dir], { cwd, allowFail: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Move `branch` from `oldSha` to `newSha` with compare-and-swap. If the branch
 * is checked out in the primary worktree, fast-forward it there instead so the
 * working tree follows; a dirty tree is refused rather than overwritten.
 */
export function advanceBranch(cwd, branch, newSha, oldSha) {
  if (currentBranch(cwd) === branch) {
    const dirty = git(['status', '--porcelain', '--untracked-files=no'], { cwd });
    if (dirty) throw new Error(`refusing to move checked-out branch ${branch}: working tree has changes`);
    git(['merge', '--ff-only', '--quiet', newSha], { cwd, env: { IFC_GIT_INTERNAL: '1' } });
    return;
  }
  git(['update-ref', `refs/heads/${branch}`, newSha, oldSha], { cwd });
}
