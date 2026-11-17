/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Several projects, one coordinated model.
 *
 * Each discipline (architecture, structure, MEP…) is its own repository with
 * its own branches, reviews and checks. A coordination repository names them
 * in `.ifc-git/federation.yml` and pins one commit of each in
 * `.ifc-git/federation.lock.json`, which is committed. A federated check then
 * always runs on an exact, reproducible set of deliveries, and moving a pin
 * is itself a reviewed change: `federation update` opens a pull request per
 * project whose delivery moved, the way a dependency bot bumps a lock file.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { BOT, extractBlob, fileExistsAt, git, identityEnv, readTextAt, revParse, tempWorktree } from './git.mjs';
import { Forge } from './forge.mjs';
import { CONFIG_DIR } from './workflows.mjs';

export const MANIFEST = `${CONFIG_DIR}/federation.yml`;
export const LOCK = `${CONFIG_DIR}/federation.lock.json`;

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The manifest at `rev`, or in the working tree when `rev` is null (before the first commit). */
function manifestAt(root, rev) {
  let text;
  if (rev === null) {
    const path = join(root, MANIFEST);
    if (!existsSync(path)) throw new Error(`${MANIFEST} not found in the working tree`);
    text = readFileSync(path, 'utf8');
  } else {
    if (!fileExistsAt(root, rev, MANIFEST)) throw new Error(`${MANIFEST} not found at ${rev}`);
    text = readTextAt(root, rev, MANIFEST);
  }
  const doc = parse(text);
  const projects = doc?.projects ?? {};
  if (Object.keys(projects).length === 0) throw new Error(`${MANIFEST} declares no projects`);
  return projects;
}

export function lockAt(root, rev) {
  return rev && fileExistsAt(root, rev, LOCK) ? JSON.parse(readTextAt(root, rev, LOCK)) : { projects: {} };
}

/** The commit a project currently publishes: what its forge last received, else its branch tip. */
function publishedTip(projectRoot, branch) {
  const pushed = new Forge(projectRoot).pushedTip(branch);
  const tip = pushed ?? revParse(projectRoot, `refs/heads/${branch}`);
  if (!tip) throw new Error(`project repository ${projectRoot} has no branch ${branch}`);
  return tip;
}

function pin(root, name, spec, sha) {
  const projectRoot = resolve(root, spec.repo);
  const models = (spec.models ?? []).map((path) => {
    if (!fileExistsAt(projectRoot, sha, path)) throw new Error(`${name}: ${path} does not exist at ${sha.slice(0, 8)}`);
    const blob = git(['rev-parse', `${sha}:${path}`], { cwd: projectRoot });
    return { path, blob };
  });
  return { repo: spec.repo, branch: spec.branch ?? 'main', discipline: spec.discipline ?? name, sha, models };
}

/**
 * Compute a fresh lock for every project (or one), from each project's
 * published tip. `rev` is where the manifest and current lock are read;
 * null reads the working tree, for a repository with no commits yet.
 */
export function resolveLock(root, rev = 'HEAD', only) {
  const manifest = manifestAt(root, rev);
  const current = lockAt(root, rev);
  const projects = { ...current.projects };
  for (const [name, spec] of Object.entries(manifest)) {
    if (only && name !== only) continue;
    const projectRoot = resolve(root, spec.repo);
    projects[name] = pin(root, name, spec, publishedTip(projectRoot, spec.branch ?? 'main'));
  }
  return { version: 1, projects };
}

export function writeLock(dir, lock) {
  writeFileSync(join(dir, LOCK), `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * Write the pinned models of the lock at `rev` into `workspace/federation/`,
 * verifying each blob, and return their workspace-relative paths in
 * manifest order.
 */
export function materializeFederation(root, workspace, rev) {
  const lock = lockAt(root, rev);
  const out = [];
  for (const [name, p] of Object.entries(lock.projects)) {
    const projectRoot = resolve(root, p.repo);
    const dir = join(workspace, 'federation', name);
    mkdirSync(dir, { recursive: true });
    for (const m of p.models) {
      const dest = join(dir, basename(m.path));
      extractBlob(projectRoot, p.sha, m.path, dest);
      const actual = git(['hash-object', dest], { cwd: projectRoot });
      if (actual !== m.blob) throw new Error(`${name}/${m.path}: pinned blob ${m.blob} but got ${actual}`);
      out.push(relative(workspace, dest));
    }
  }
  if (out.length === 0) throw new Error(`${LOCK} at ${rev} pins no models; run "ifc-git federation lock" and commit it`);
  return out;
}

/**
 * Open one pull request per project whose published tip moved past its pin.
 * Each bump is its own branch and its own review, so a structural delivery
 * that breaks coordination does not hold up an architectural one.
 */
export async function updateFederation(root, { base = 'main', only } = {}) {
  const { openPull, closePull } = await import('./pulls.mjs');
  const baseSha = revParse(root, `refs/heads/${base}`);
  const current = lockAt(root, baseSha);
  const fresh = resolveLock(root, baseSha, only);
  const opened = [];
  for (const [name, p] of Object.entries(fresh.projects)) {
    const before = current.projects[name];
    if (before && before.sha === p.sha) continue;
    const branch = `federation/${name}-${p.sha.slice(0, 8)}`;
    if (revParse(root, `refs/heads/${branch}`)) continue;
    const wt = tempWorktree(root, baseSha);
    try {
      const lock = lockAt(root, baseSha);
      lock.version = 1;
      lock.projects = { ...lock.projects, [name]: p };
      writeLock(wt.dir, lock);
      git(['add', LOCK], { cwd: wt.dir });
      const subject = `Bump ${name} to ${p.sha.slice(0, 8)}`;
      const body = before ? `${name}: ${before.sha.slice(0, 8)} → ${p.sha.slice(0, 8)}` : `${name}: first pin at ${p.sha.slice(0, 8)}`;
      git(['commit', '-q', '-m', subject, '-m', body], { cwd: wt.dir, env: { ...identityEnv(BOT), IFC_GIT_INTERNAL: '1' } });
      const sha = git(['rev-parse', 'HEAD'], { cwd: wt.dir });
      git(['branch', branch, sha], { cwd: root });
    } finally { wt.remove(); }
    const pr = await openPull(root, { head: branch, base, title: `Bump ${name} delivery to ${p.sha.slice(0, 8)}`, author: BOT.name });
    const forge = new Forge(root);
    for (const old of forge.pulls()) {
      if (old.state === 'open' && old.number !== pr.number && old.head.startsWith(`federation/${name}-`)) {
        closePull(forge, old.number, { by: BOT.name, reason: `superseded by #${pr.number}` });
        console.log(`Closed #${old.number}: superseded by #${pr.number}`);
      }
    }
    opened.push({ project: name, branch, pr: pr.number, from: before?.sha ?? null, to: p.sha });
  }
  return opened;
}

/**
 * The models whose pin moved between two commits of the coordination
 * repository: what a bump pull request actually proposes.
 */
export function lockChanges(root, fromRev, toRev) {
  const before = lockAt(root, fromRev).projects;
  const after = lockAt(root, toRev).projects;
  const out = [];
  for (const [name, p] of Object.entries(after)) {
    const old = before[name];
    if (old?.sha === p.sha) continue;
    for (const m of p.models) {
      const prior = old?.models.find((x) => x.path === m.path);
      if (prior?.blob === m.blob) continue;
      out.push({ project: name, path: m.path, repo: resolve(root, p.repo), fromBlob: prior?.blob ?? null, toBlob: m.blob, fromSha: old?.sha ?? null, toSha: p.sha });
    }
  }
  return out;
}

export { sha256 };
