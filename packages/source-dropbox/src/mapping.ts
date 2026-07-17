/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceContainer, SourceFile, SourceRevision } from '@ifc-lite/plugin-api';
import type { DropboxMetadata } from './http-client.js';

const SUPPORTED_EXTENSIONS = ['.ifc', '.ifcx'];

export function isSupportedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function toSourceContainer(entry: DropboxMetadata, parentId: string | undefined): SourceContainer {
  return {
    id: entry.path_lower ?? entry.path_display ?? entry.name,
    name: entry.name,
    parentId,
    meta: { kind: 'folder' },
  };
}

export function toSourceFile(entry: DropboxMetadata, containerId: string): SourceFile {
  const modifiedMs = entry.server_modified ? Date.parse(entry.server_modified) : Date.now();
  const currentRevisionId = String(modifiedMs);

  const revision: SourceRevision = {
    id: currentRevisionId,
    version: 1,
    createdAt: new Date(modifiedMs).toISOString(),
    sizeBytes: entry.size,
  };

  return {
    id: entry.id,
    name: entry.name,
    containerId,
    sizeBytes: entry.size,
    currentRevisionId,
    revisions: [revision],
    meta: { path: entry.path_lower ?? entry.path_display ?? entry.name },
  };
}

export function matchGlob(pattern: string, name: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
  return re.test(name);
}
