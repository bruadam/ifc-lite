/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-git push <branch>`: publish a local branch to the forge.
 *
 * As on a hosted forge, publishing is when automation happens: the push runs
 * the `on: push` workflows for the branch, and any open pull request whose
 * head or base is that branch is re-synced (new merge preview, new checks).
 * A protected branch that requires pull requests refuses direct pushes once
 * it exists on the forge, and every push must fast-forward the published tip.
 */

import { changedFiles, isAncestor, mergeBase, revParse } from './git.mjs';
import { runEvent } from './runner.mjs';
import { protectionFor } from './workflows.mjs';

export class PushRejected extends Error {}

/** The comparison point for a branch's first push: where it left the default branch. */
function forkPoint(forge, tip, defaultBranch) {
  const main = forge.pushedTip(defaultBranch);
  return main ? mergeBase(forge.root, main, tip) : null;
}

export async function pushBranch(forge, branch, { log = console.log, internal = false, defaultBranch = 'main', force = false } = {}) {
  const tip = revParse(forge.root, `refs/heads/${branch}`);
  if (!tip) throw new Error(`no local branch "${branch}"`);
  const prev = forge.pushedTip(branch);
  if (prev === tip) {
    log(`${branch}: everything up to date (${tip.slice(0, 8)})`);
    return { branch, sha: tip, runs: [] };
  }
  const rule = protectionFor(forge.root, prev ?? tip, branch);
  if (prev && rule?.requirePullRequest && !internal) {
    throw new PushRejected(`${branch} is protected (rule "${rule.pattern}"): changes must arrive through a pull request.\n  ifc-git pr open <your-branch> --base ${branch} --title "…"`);
  }
  if (prev && !force && !isAncestor(forge.root, prev, tip)) {
    throw new PushRejected(`${branch}: non-fast-forward push rejected (the forge has ${prev.slice(0, 8)}, which ${tip.slice(0, 8)} does not contain)`);
  }
  // Decided before the tip is recorded: a new branch compares with where it
  // left the default branch, and the default branch's first push with nothing.
  const compareBase = prev ?? (branch === defaultBranch ? null : forkPoint(forge, tip, defaultBranch));
  forge.setPushedTip(branch, tip);
  log(`${branch}: ${prev ? `${prev.slice(0, 8)}..${tip.slice(0, 8)}` : `new branch at ${tip.slice(0, 8)}`}`);

  const event = {
    name: 'push', branch, sha: tip, checkSha: tip, context: 'push',
    compareBase, changed: changedFiles(forge.root, compareBase, tip),
  };
  const runs = runEvent(forge, event, { log });

  const { syncPull } = await import('./pulls.mjs');
  for (const pr of forge.pulls()) {
    if (pr.state === 'open' && (pr.head === branch || pr.base === branch)) {
      log(`↻ re-syncing pull request #${pr.number} (${pr.head === branch ? 'head' : 'base'} moved)`);
      await syncPull(forge, pr.number, { log });
    }
  }
  return { branch, sha: tip, runs };
}
