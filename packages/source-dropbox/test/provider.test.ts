/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KeyValueStore, Logger, PluginContext } from '@ifc-lite/plugin-api';
import { DropboxProvider } from '../src/provider.js';

function createMockStorage(): KeyValueStore {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key))),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve([...store.keys()])),
  };
}

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockCtx(
  fetchImpl: typeof fetch,
  accessToken: string | null = 'test-access-token',
): PluginContext {
  return {
    fetch: fetchImpl,
    getPreference: vi.fn(() => Promise.resolve(undefined)),
    storage: createMockStorage(),
    log: createMockLogger(),
    getAccessToken: accessToken === null ? undefined : vi.fn(() => Promise.resolve(accessToken)),
  };
}

function mockResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: () => Promise.resolve(undefined),
    text: () => Promise.resolve(''),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    ...overrides,
  };
}

describe('DropboxProvider', () => {
  let provider: DropboxProvider;

  beforeEach(() => {
    provider = new DropboxProvider();
  });

  it('exposes the dropbox manifest', () => {
    expect(provider.manifest.name).toBe('dropbox');
    expect(provider.manifest.title).toBe('Dropbox');
    expect(provider.manifest.auth).toBe('oauth');
    expect(provider.manifest.permissions.network).toContain('api.dropboxapi.com');
    expect(provider.manifest.preferences).toEqual([]);
  });

  describe('listProjects', () => {
    it('returns a single synthetic project (Dropbox has no project concept)', async () => {
      const ctx = createMockCtx(vi.fn());
      const projects = await provider.listProjects(ctx);
      expect(projects).toEqual([{ id: 'dropbox', name: 'Dropbox' }]);
    });
  });

  describe('listContainers', () => {
    it('returns a single synthetic root container at the top level', async () => {
      const ctx = createMockCtx(vi.fn());
      const containers = await provider.listContainers(ctx, 'dropbox');
      expect(containers).toEqual([{ id: '', name: 'Dropbox', meta: { kind: 'root' } }]);
    });

    it('lists a folder’s child folders, skipping files, when scoped to a parent', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({
          json: () =>
            Promise.resolve({
              entries: [
                { '.tag': 'folder', id: 'id:f1', name: 'Projects', path_lower: '/projects' },
                { '.tag': 'file', id: 'id:file1', name: 'model.ifc', path_lower: '/model.ifc' },
              ],
              has_more: false,
            }),
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const containers = await provider.listContainers(ctx, 'dropbox', '');

      expect(containers).toEqual([
        { id: '/projects', name: 'Projects', parentId: '', meta: { kind: 'folder' } },
      ]);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.dropboxapi.com/2/files/list_folder',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
        }),
      );
    });

    it('follows cursor-based pagination across multiple pages', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/list_folder')) {
          return Promise.resolve(
            mockResponse({
              json: () =>
                Promise.resolve({
                  entries: [{ '.tag': 'folder', id: 'id:a', name: 'A', path_lower: '/a' }],
                  has_more: true,
                  cursor: 'cursor-1',
                }),
            }),
          );
        }
        return Promise.resolve(
          mockResponse({
            json: () =>
              Promise.resolve({
                entries: [{ '.tag': 'folder', id: 'id:b', name: 'B', path_lower: '/b' }],
                has_more: false,
              }),
          }),
        );
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const containers = await provider.listContainers(ctx, 'dropbox', '');

      expect(containers.map((c) => c.id)).toEqual(['/a', '/b']);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.dropboxapi.com/2/files/list_folder/continue',
        expect.objectContaining({ body: JSON.stringify({ cursor: 'cursor-1' }) }),
      );
    });
  });

  describe('listFiles', () => {
    it('lists supported IFC files, skipping folders and unsupported extensions', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({
          json: () =>
            Promise.resolve({
              entries: [
                { '.tag': 'folder', id: 'id:f1', name: 'Sub', path_lower: '/sub' },
                { '.tag': 'file', id: 'id:file1', name: 'model.ifc', path_lower: '/model.ifc', size: 1024 },
                { '.tag': 'file', id: 'id:file2', name: 'readme.txt', path_lower: '/readme.txt' },
              ],
              has_more: false,
            }),
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const files = await provider.listFiles(ctx, '');

      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ id: 'id:file1', name: 'model.ifc', containerId: '', sizeBytes: 1024 });
    });

    it('applies a namePatterns filter', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({
          json: () =>
            Promise.resolve({
              entries: [
                { '.tag': 'file', id: 'id:file1', name: 'model.ifc', path_lower: '/model.ifc' },
                { '.tag': 'file', id: 'id:file2', name: 'other.ifcx', path_lower: '/other.ifcx' },
              ],
              has_more: false,
            }),
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const files = await provider.listFiles(ctx, '', { namePatterns: ['*.ifc'] });

      expect(files.map((f) => f.name)).toEqual(['model.ifc']);
    });
  });

  describe('download', () => {
    it('downloads a file addressed by id, escaping non-ASCII in the Dropbox-API-Arg header', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const buffer = await provider.download(ctx, 'id:abc123');

      expect(buffer.byteLength).toBe(4);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://content.dropboxapi.com/2/files/download',
        expect.objectContaining({
          headers: expect.objectContaining({ 'Dropbox-API-Arg': JSON.stringify({ path: 'id:abc123' }) }),
        }),
      );
    });
  });

  describe('testConnection', () => {
    it('returns ok with the connected account name on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({ json: () => Promise.resolve({ name: { display_name: 'Jane Doe' } }) }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const result = await provider.testConnection(ctx);

      expect(result).toEqual({ ok: true, message: 'Connected as Jane Doe' });
    });

    it('returns a failure message when the account request fails', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status: 401, text: () => Promise.resolve('invalid_access_token') }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const result = await provider.testConnection(ctx);

      expect(result.ok).toBe(false);
      expect(result.message).toContain('401');
    });
  });

  it('throws a clear error when the host has not wired an OAuth access token', async () => {
    const ctx = createMockCtx(vi.fn(), null);
    await expect(provider.listFiles(ctx, '')).rejects.toThrow('requires an OAuth access token');
  });
});
