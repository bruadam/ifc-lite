/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginManifest } from '@ifc-lite/plugin-api';

export const DROPBOX_MANIFEST: PluginManifest = {
  name: 'dropbox',
  title: 'Dropbox',
  iconUrl: 'https://cdn.brandfetch.io/idZAyF9rlg/w/400/h/400/theme/dark/icon.png?c=1dxbfHSJFAPEGdCLU4o5B',
  api: '^2.0.0',
  auth: 'oauth',
  permissions: {
    network: ['api.dropboxapi.com', 'content.dropboxapi.com'],
  },
  preferences: [],
  contributes: {
    fileSources: ['./src/provider.ts'],
  },
};
