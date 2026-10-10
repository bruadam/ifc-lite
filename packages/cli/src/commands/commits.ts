/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createCommitHttpProvider, fetchCommitCapabilities } from '@ifc-lite/source-commit-http';
import { artifactDigest, isDerivedHistoryExport } from '@ifc-lite/history-export';
import type { PluginContext } from '@ifc-lite/plugin-api';
import { historyArgs } from './history-input.js';
import { parseIfcBytes } from '../loader.js';

/** Non-interactive source access. Credentials remain in the environment, never argv or disk. */
export async function commitsCommand(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const p = historyArgs(rest, ['--url', '--project', '--model', '--commit', '--base', '--key', '--out', '--parent', '--message', '--idempotency-key', '--name', '--cursor', '--limit'], ['--json']);
  if (!['projects', 'models', 'list', 'show', 'download', 'diff', 'element', 'create-model', 'upload'].includes(command)) throw new Error('Usage: ifc-lite commits projects|models|list|show|download|diff|element|create-model|upload --url URL');
  const baseUrl = p.value('--url') ?? process.env.IFC_LITE_COMMIT_URL;
  const token = process.env.IFC_LITE_COMMIT_TOKEN;
  if (!baseUrl || !token) throw new Error('Set IFC_LITE_COMMIT_URL (or --url) and IFC_LITE_COMMIT_TOKEN');
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('Provide a plain HTTP(S) service URL without credentials, query or fragment');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS for a remote commit service');
  const doFetch: typeof fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== url.origin) throw new Error('Commit request left the configured origin');
    const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers, redirect: 'error', credentials: 'omit', signal: init?.signal ?? AbortSignal.timeout(120_000) });
  };
  const provider = createCommitHttpProvider({ network: [url.hostname], commits: await fetchCommitCapabilities(baseUrl, doFetch), getAccessToken: async () => token });
  const store = new Map<string, string>();
  const ctx: PluginContext = { fetch: doFetch, fetchPublic: async () => { throw new Error('Public downloads are not used by this source'); }, getPreference: async name => name === 'baseUrl' ? baseUrl : undefined,
    storage: { get: async k => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async k => { store.delete(k); }, keys: async () => [...store.keys()] }, log: { debug: () => {}, info: () => {}, warn: message => { process.stderr.write(message + '\n'); }, error: message => { process.stderr.write(message + '\n'); } } };
  const required = (key: string) => { const v = p.value(key); if (!v) throw new Error(`${key} is required`); return v; };
  const projectId = command === 'projects' ? '' : required('--project');
  const modelId = ['projects', 'models', 'create-model'].includes(command) ? '' : required('--model');
  const ref = { projectId, modelId };
  const limit = p.value('--limit') === undefined ? undefined : Number(p.value('--limit'));
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer');
  const paging = { cursor: p.value('--cursor'), limit };
  let result: unknown;
  switch (command) {
    case 'projects': result = await provider.listProjects(ctx, paging); break;
    case 'models': result = await provider.listModels!(ctx, projectId, paging); break;
    case 'list': result = await provider.listCommits!(ctx, ref, paging); break;
    case 'show': result = await provider.getCommit!(ctx, { ...ref, commitId: required('--commit') }); break;
    case 'download': {
      const commitRef = { ...ref, commitId: required('--commit') }, out = required('--out');
      const commit = await provider.getCommit!(ctx, commitRef), payload = await provider.loadCommit!(ctx, commitRef);
      if (payload.artifactDigest !== commit.artifact.digest || await artifactDigest(payload.bytes) !== commit.artifact.digest) throw new Error('Commit payload digest mismatch');
      await writeFile(out, new Uint8Array(payload.bytes)); result = { output: out, commitId: commit.id }; break;
    }
    case 'diff': {
      if (!provider.getCommitDiff) throw new Error('Source does not support stored diffs');
      result = await provider.getCommitDiff(ctx, { ...ref, commitId: required('--base') }, { ...ref, commitId: required('--commit') }); break;
    }
    case 'element': {
      if (!provider.listElementHistory) throw new Error('Source does not support element history');
      result = await provider.listElementHistory(ctx, { ...ref, key: required('--key'), atCommitId: p.value('--commit') }, paging); break;
    }
    case 'create-model': {
      if (!provider.createModel) throw new Error('Source is read-only');
      result = await provider.createModel(ctx, { projectId, name: required('--name') }); break;
    }
    case 'upload': {
      if (!provider.createCommit) throw new Error('Source is read-only');
      if (p.files.length !== 1) throw new Error('Provide one IFC file to upload');
      const parent = required('--parent');
      const bytes = Uint8Array.from(await readFile(p.files[0])).buffer;
      if (parent !== 'none' && isDerivedHistoryExport((await parseIfcBytes(new Uint8Array(bytes), p.files[0])).sourceHeader?.description)) throw new Error('A derived history export cannot be uploaded as a new revision; use the original delivery');
      result = await provider.createCommit(ctx, { ...ref, expectedParentId: parent === 'none' ? null : parent, bytes, fileName: basename(p.files[0]), message: p.value('--message'), idempotencyKey: required('--idempotency-key') }); break;
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
