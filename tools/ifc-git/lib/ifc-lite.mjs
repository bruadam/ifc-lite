/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Locating and invoking the `ifc-lite` CLI. Every check this tool runs is an
 * ifc-lite command; nothing here re-implements IFC parsing, validation or
 * clash detection.
 *
 * Resolution order: `$IFC_LITE` (a path to a CLI `.js` entry or an
 * executable), then this checkout's built CLI, then `ifc-lite` on PATH.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const IN_REPO_CLI = resolve(here, '../../../packages/cli/dist/index.js');

export function ifcLiteCommand() {
  const explicit = process.env.IFC_LITE;
  const target = explicit || (existsSync(IN_REPO_CLI) ? IN_REPO_CLI : 'ifc-lite');
  return target.endsWith('.js') ? [process.execPath, target] : [target];
}

/** A shell-safe command line that invokes ifc-lite, for `run:` steps. */
export function ifcLiteShell() {
  return ifcLiteCommand().map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
}

/**
 * Run `ifc-lite <args>` in `cwd`. Returns the exit code and both streams;
 * the caller decides what each exit code means for its check, because the
 * commands do not share one convention (`check` uses 2 for "could not
 * evaluate", `ids` uses 1 for "failed").
 */
export function ifcLite(args, { cwd, timeoutMs = 10 * 60 * 1000 } = {}) {
  const [cmd, ...pre] = ifcLiteCommand();
  const r = spawnSync(cmd, [...pre, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Parse the one JSON document a `--json` invocation prints, or explain why not. */
export function parseJson(result, what) {
  const text = result.stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const tail = (result.stderr || text).trim().split('\n').slice(-3).join(' | ');
    throw new Error(`${what}: expected JSON from ifc-lite (exit ${result.code}): ${tail}`);
  }
}
