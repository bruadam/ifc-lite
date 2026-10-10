/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { artifactDigest } from '@ifc-lite/history-export';
import { headerSignalsFromStore, type MatchSubject } from '@ifc-lite/model-match';
import { unwrapIfcZipView } from '@ifc-lite/parser';
import { routeConsoleDiagnosticsToStderr } from '../output.js';
import { parseIfcBytes } from '../loader.js';
import { buildFileFingerprints } from './diff-engine.js';
import { attachGeometryFingerprints, loadWasmRuntime, runGeometryPass } from './diff-geometry.js';

export async function historyInput(path: string, geometry: boolean) {
  const raw = await readFile(path);
  const bytes = Uint8Array.from(raw).buffer;
  const store = await parseIfcBytes(raw, path);
  const fingerprints = buildFileFingerprints(store);
  if (geometry) {
    routeConsoleDiagnosticsToStderr();
    const loaded = await loadWasmRuntime();
    if (!loaded.ok) throw new Error(loaded.message);
    try { attachGeometryFingerprints(fingerprints, runGeometryPass(loaded.runtime.api, new Uint8Array(await unwrapIfcZipView(raw)))); }
    finally { loaded.runtime.api.free(); }
  }
  const subject: MatchSubject = { id: path, label: basename(path), fileName: basename(path), digest: await artifactDigest(bytes), header: headerSignalsFromStore(store), fingerprints };
  return { bytes, store, fingerprints, subject };
}

/** Strict option parser; a misspelled flag must never turn into an input file. */
export function historyArgs(args: string[], values: readonly string[], switches: readonly string[]) {
  const files: string[] = [], flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { files.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('-')) { files.push(arg); continue; }
    if (switches.includes(arg)) { flags.set(arg, ['true']); continue; }
    if (!values.includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    flags.set(arg, [...(flags.get(arg) ?? []), value]);
  }
  return { files, flags, value: (key: string) => flags.get(key)?.at(-1), has: (key: string) => flags.has(key) };
}
