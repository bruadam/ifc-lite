/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, expect, it, vi } from 'vitest';
import { commitsCommand } from './commits.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('commit-history CLI uses its bearer token without browser sign-in and preserves paging', async () => {
  vi.stubEnv('IFC_LITE_COMMIT_URL', 'https://source.example/api');
  vi.stubEnv('IFC_LITE_COMMIT_TOKEN', 'test-cli-token');
  const requests: { url: string; headers: Headers; redirect?: RequestInit['redirect'] }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
    if (url.endsWith('/capabilities')) return Response.json({ payloadFormats: ['ifc-step'], fingerprints: false, storedDiffs: false, elementHistory: false, identityRecords: false, write: false, watch: false, modelIdsAreFileIds: false });
    if (url.startsWith('https://source.example/api/projects?')) return Response.json({ items: [{ id: 'p', name: 'Project' }], cursor: 'next-page' });
    throw new Error(`Unexpected request ${url}`);
  });
  let output = ''; vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  await commitsCommand(['projects', '--cursor', 'start', '--limit', '3']);
  expect(JSON.parse(output)).toMatchObject({ cursor: 'next-page' });
  const request = requests.at(-1)!;
  expect(new URL(request.url).searchParams.get('cursor')).toBe('start');
  expect(new URL(request.url).searchParams.get('limit')).toBe('3');
  expect(request.headers.get('authorization')).toBe('Bearer test-cli-token');
  expect(request.redirect).toBe('error');
  expect(requests).toHaveLength(2);
});

it('refuses credentials in URLs and non-loopback cleartext before any request', async () => {
  vi.stubEnv('IFC_LITE_COMMIT_TOKEN', 'test-cli-token');
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(commitsCommand(['projects', '--url', 'http://source.example'])).rejects.toThrow('HTTPS');
  await expect(commitsCommand(['projects', '--url', 'https://user:password@source.example'])).rejects.toThrow('credentials');
  expect(fetcher).not.toHaveBeenCalled();
});
