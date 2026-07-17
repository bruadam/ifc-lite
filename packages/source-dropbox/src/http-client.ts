/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';

const LIST_FOLDER_URL = 'https://api.dropboxapi.com/2/files/list_folder';
const LIST_FOLDER_CONTINUE_URL = 'https://api.dropboxapi.com/2/files/list_folder/continue';
const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';
const GET_CURRENT_ACCOUNT_URL = 'https://api.dropboxapi.com/2/users/get_current_account';
const NON_ASCII_THRESHOLD = 127;

export interface DropboxMetadata {
  '.tag': 'file' | 'folder' | 'deleted';
  id: string;
  name: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
}

interface ListFolderPage {
  entries: DropboxMetadata[];
  has_more: boolean;
  cursor?: string;
}

/**
 * Serializes a Dropbox-API-Arg value, escaping any non-ASCII code unit as a
 * JSON-style unicode escape — the header this becomes must be pure ASCII.
 */
function dropboxApiArg(arg: Record<string, unknown>): string {
  const json = JSON.stringify(arg);
  let out = '';
  for (const ch of json) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= NON_ASCII_THRESHOLD ? escapeCodeUnit(code) : ch;
  }
  return out;
}

function escapeCodeUnit(code: number): string {
  const hex = code.toString(16).padStart(4, '0');
  return String.fromCharCode(92) + 'u' + hex;
}

async function authHeader(ctx: PluginContext): Promise<string> {
  if (!ctx.getAccessToken) throw new Error('Dropbox provider requires an OAuth access token');
  return `Bearer ${await ctx.getAccessToken()}`;
}

async function readListPage(res: Response): Promise<ListFolderPage> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Dropbox list_folder failed (${res.status}): ${detail}`);
  }
  const data = (await res.json()) as { entries?: DropboxMetadata[]; has_more?: boolean; cursor?: string };
  return { entries: data.entries ?? [], has_more: Boolean(data.has_more), cursor: data.cursor };
}

/** Lists every entry directly inside `path` (non-recursive), following pagination. */
export async function listFolder(ctx: PluginContext, path: string): Promise<DropboxMetadata[]> {
  const authorization = await authHeader(ctx);
  const entries: DropboxMetadata[] = [];

  let res = await ctx.fetch(LIST_FOLDER_URL, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, recursive: false, limit: 2000 }),
  });
  let page = await readListPage(res);
  entries.push(...page.entries);

  while (page.has_more && page.cursor) {
    res = await ctx.fetch(LIST_FOLDER_CONTINUE_URL, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: page.cursor }),
    });
    page = await readListPage(res);
    entries.push(...page.entries);
  }

  return entries;
}

/** Downloads a file's bytes, addressed by its Dropbox id (e.g. `id:abc123`). */
export async function downloadFile(ctx: PluginContext, fileId: string): Promise<ArrayBuffer> {
  const authorization = await authHeader(ctx);
  const res = await ctx.fetch(DOWNLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      // Dropbox's content API takes its args as an HTTP header, which must be
      // ASCII — addressing by id (always ASCII) avoids non-ASCII path issues.
      'Dropbox-API-Arg': dropboxApiArg({ path: fileId }),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Dropbox download failed (${res.status}): ${detail}`);
  }
  return res.arrayBuffer();
}

/** Verifies the access token by fetching the connected account's display name. */
export async function getCurrentAccountName(ctx: PluginContext): Promise<string> {
  const authorization = await authHeader(ctx);
  const res = await ctx.fetch(GET_CURRENT_ACCOUNT_URL, {
    method: 'POST',
    headers: { Authorization: authorization },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Dropbox get_current_account failed (${res.status}): ${detail}`);
  }
  const data = (await res.json()) as { name?: { display_name?: string } };
  return data.name?.display_name ?? 'Dropbox';
}
