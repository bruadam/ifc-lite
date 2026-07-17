/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  ConnectionTestResult,
  FileFilter,
  FileSourceProvider,
  PluginContext,
  SourceContainer,
  SourceFile,
  SourceProject,
} from '@ifc-lite/plugin-api';

import { DROPBOX_MANIFEST } from './manifest.js';
import { downloadFile, getCurrentAccountName, listFolder } from './http-client.js';
import { isSupportedFile, matchGlob, toSourceContainer, toSourceFile } from './mapping.js';

/** Dropbox is a single-account drive — there's no server-side "project" concept. */
const ROOT_PROJECT_ID = 'dropbox';
/** Dropbox's own root-folder path. */
const ROOT_PATH = '';

export class DropboxProvider implements FileSourceProvider {
  readonly manifest = DROPBOX_MANIFEST;

  async listProjects(_ctx: PluginContext): Promise<SourceProject[]> {
    return [{ id: ROOT_PROJECT_ID, name: 'Dropbox' }];
  }

  async listContainers(
    ctx: PluginContext,
    _projectId: string,
    parentId?: string,
  ): Promise<SourceContainer[]> {
    if (parentId === undefined) {
      // Top level: one synthetic container standing in for the whole drive
      // (Dropbox has no "file area" concept, just a single root folder).
      return [{ id: ROOT_PATH, name: 'Dropbox', meta: { kind: 'root' } }];
    }

    const entries = await listFolder(ctx, parentId);
    return entries
      .filter((entry) => entry['.tag'] === 'folder')
      .map((entry) => toSourceContainer(entry, parentId));
  }

  async listFiles(
    ctx: PluginContext,
    containerId: string,
    filter?: FileFilter,
  ): Promise<SourceFile[]> {
    const entries = await listFolder(ctx, containerId);
    let files = entries
      .filter((entry) => entry['.tag'] === 'file' && isSupportedFile(entry.name))
      .map((entry) => toSourceFile(entry, containerId));

    if (filter?.namePatterns?.length) {
      files = files.filter((file) =>
        filter.namePatterns!.some((pattern) => matchGlob(pattern, file.name)),
      );
    }

    return files;
  }

  async download(ctx: PluginContext, fileId: string): Promise<ArrayBuffer> {
    return downloadFile(ctx, fileId);
  }

  async testConnection(ctx: PluginContext): Promise<ConnectionTestResult> {
    try {
      const name = await getCurrentAccountName(ctx);
      return { ok: true, message: `Connected as ${name}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
