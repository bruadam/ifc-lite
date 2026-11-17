#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-git: git workflows for IFC deliveries, with a lightweight
 * GitHub-Actions-style runner whose steps are ifc-lite checks.
 * See README.md for the model; `ifc-git help` for the commands.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Forge } from './lib/forge.mjs';
import { changedFiles, currentBranch, revParse } from './lib/git.mjs';
import { LOCK, resolveLock, updateFederation, writeLock } from './lib/federation.mjs';
import { approvePull, closePull, mergePull, mergeStatus, openPull, resolvePull, syncPull } from './lib/pulls.mjs';
import { PushRejected, pushBranch } from './lib/push.mjs';
import { runEvent } from './lib/runner.mjs';
import { printChecks, printLog, printPull, printStatus, semanticLog } from './lib/views.mjs';

const HELP = `ifc-git — git workflows for IFC models, checked by ifc-lite

  init                                  Add .gitattributes and starter .ifc-git/ config
  push <branch> [--force]               Publish a branch to the forge; runs on:push workflows
  run [--ref <branch>]                  Run on:workflow_dispatch workflows on a branch tip
  status                                Branches, protection, checks, open pull requests
  log [<rev>] [-n N]                    History with a semantic summary of each IFC change
  checks [<rev>]                        Check results recorded for a commit
  pr open <head> [--base main] --title "…" [--author NAME]
  pr list | pr show <n> | pr sync <n>
  pr approve <n> --by NAME
  pr merge <n> --by NAME [--waive <check>="<reason>"]...
  pr resolve <n> --take head|base --by NAME
  pr close <n> --by NAME [--reason "…"]
  federation lock                       Pin every project's published tip in ${LOCK}
  federation update [--base main]       Open a pull request per project whose delivery moved

Exit codes: 0 ok, 1 error, 2 rejected (push refused, merge blocked), 3 checks failed.`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
function flags(args, name) {
  const out = [];
  let v;
  while ((v = flag(args, name)) !== undefined) out.push(v);
  return out;
}
function bool(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}
function need(v, what) {
  if (v === undefined || v === '') throw new Error(`${what} is required`);
  return v;
}

const STARTER_WORKFLOW = `name: Model checks
on:
  push:
    paths: ['**/*.ifc', '.ifc-git/**']
  pull_request:
    branches: [main]
jobs:
  validate:
    strategy:
      matrix:
        model: \${{ project.models }}
    steps:
      - uses: ifc-lite/validate
        with:
          model: \${{ matrix.model }}
  changes:
    if: \${{ event == 'pull_request' }}
    steps:
      - uses: ifc-lite/diff
        with:
          model: \${{ project.models }}
`;

function init(root) {
  const attrs = join(root, '.gitattributes');
  if (!existsSync(attrs)) writeFileSync(attrs, '# IFC models are versioned whole: never merged line by line.\n*.ifc binary\n*.ifczip binary\n*.ifcxml binary\n');
  mkdirSync(join(root, '.ifc-git', 'workflows'), { recursive: true });
  const files = {
    'project.yml': 'name: my-project\ndiscipline: architecture\nmodels:\n  - model.ifc\n',
    'protection.yml': 'branches:\n  main:\n    require_pull_request: true\n    required_checks: [model-checks/validate]\n    required_approvals: 1\n',
    'workflows/model-checks.yml': STARTER_WORKFLOW,
  };
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, '.ifc-git', rel);
    if (!existsSync(p)) { writeFileSync(p, text); console.log(`created .ifc-git/${rel}`); }
  }
  console.log('Commit .gitattributes and .ifc-git/, then: ifc-git push main');
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return 0; }
  const forge = new Forge();
  switch (cmd) {
    case 'init': init(forge.root); return 0;
    case 'push': {
      const force = bool(args, '--force');
      const branch = args[0] ?? currentBranch(forge.root);
      const r = await pushBranch(forge, need(branch, 'branch'), { force });
      return r.runs.some((run) => run.conclusion === 'failure' || run.conclusion === 'error') ? 3 : 0;
    }
    case 'run': {
      const branch = flag(args, '--ref') ?? currentBranch(forge.root);
      const sha = need(revParse(forge.root, `refs/heads/${branch}`), `branch ${branch}`);
      const runs = runEvent(forge, { name: 'workflow_dispatch', branch, sha, checkSha: sha, context: 'push', compareBase: null, changed: changedFiles(forge.root, null, sha) });
      return runs.some((run) => run.conclusion === 'failure' || run.conclusion === 'error') ? 3 : 0;
    }
    case 'status': printStatus(forge); return 0;
    case 'log': {
      const n = Number(flag(args, '-n') ?? 20);
      printLog(semanticLog(forge, args[0] ?? 'HEAD', n));
      return 0;
    }
    case 'checks': printChecks(forge, need(revParse(forge.root, args[0] ?? 'HEAD'), 'revision')); return 0;
    case 'pr': return pr(forge, args);
    case 'federation': {
      const sub = args.shift();
      if (sub === 'lock') {
        writeLock(forge.root, resolveLock(forge.root, null));
        console.log(`wrote ${LOCK}; commit it to pin these deliveries`);
        return 0;
      }
      if (sub === 'update') {
        const opened = await updateFederation(forge.root, { base: flag(args, '--base') ?? 'main' });
        if (opened.length === 0) console.log('every project is pinned at its published tip');
        return 0;
      }
      throw new Error('usage: ifc-git federation lock|update');
    }
    default: throw new Error(`unknown command "${cmd}" (try: ifc-git help)`);
  }
}

async function pr(forge, args) {
  const sub = args.shift();
  const number = () => Number(need(args[0], 'pull request number'));
  switch (sub) {
    case 'open': {
      const base = flag(args, '--base') ?? 'main';
      const title = flag(args, '--title');
      const author = flag(args, '--author');
      await openPull(forge.root, { head: need(args[0], 'head branch'), base, title, author });
      return 0;
    }
    case 'list':
      for (const p of forge.pulls()) console.log(`#${p.number} [${p.state}] ${p.title} (${p.head} → ${p.base})`);
      return 0;
    case 'show': printPull(forge, forge.pull(number())); return 0;
    case 'sync': await syncPull(forge, number(), { force: true }); return 0;
    case 'approve': {
      const by = need(flag(args, '--by'), '--by');
      approvePull(forge, number(), by);
      console.log(`#${args[0]} approved by ${by}`);
      return 0;
    }
    case 'merge': {
      const by = need(flag(args, '--by'), '--by');
      const waivers = flags(args, '--waive').map((w) => {
        const eq = w.indexOf('=');
        if (eq < 1) throw new Error('--waive expects <check>="<reason>"');
        return { check: w.slice(0, eq), reason: w.slice(eq + 1) };
      });
      const r = await mergePull(forge, number(), { by, waivers });
      if (!r.merged) {
        console.log(`Merge of #${args[0]} blocked by branch protection${r.status.rule ? ` ("${r.status.rule.pattern}")` : ''}:`);
        for (const b of r.status.blockers) console.log(`  - ${b}`);
        return 2;
      }
      return 0;
    }
    case 'close': {
      const pr = closePull(forge, number(), { by: need(flag(args, '--by'), '--by'), reason: flag(args, '--reason') });
      console.log(`#${pr.number} closed`);
      return 0;
    }
    case 'resolve': {
      await resolvePull(forge, number(), { take: need(flag(args, '--take'), '--take'), by: need(flag(args, '--by'), '--by') });
      return 0;
    }
    case 'status': {
      const s = mergeStatus(forge, forge.pull(number()));
      console.log(s.blockers.length ? s.blockers.join('\n') : 'ready to merge');
      return s.blockers.length ? 2 : 0;
    }
    default: throw new Error('usage: ifc-git pr open|list|show|sync|approve|merge|resolve|close|status');
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  console.error(e instanceof PushRejected ? `! [rejected] ${e.message}` : `ifc-git: ${e.message}`);
  if (process.env.IFC_GIT_DEBUG) console.error(e.stack);
  process.exitCode = e instanceof PushRejected ? 2 : 1;
});
