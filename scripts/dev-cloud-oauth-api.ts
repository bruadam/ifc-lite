/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import dropboxAuthStart from '../api/dropbox/auth-start.ts';
import dropboxAuthCallback from '../api/dropbox/auth-callback.ts';
import dropboxToken from '../api/dropbox/token.ts';
import dropboxDisconnect from '../api/dropbox/disconnect.ts';
import { serveWebRouter } from './lib/node-http-bridge.ts';

const port = parseInt(process.env.PORT ?? '3002', 10);

serveWebRouter(port, 'dev-cloud-oauth-api', {
  '/api/dropbox/auth-start': dropboxAuthStart,
  '/api/dropbox/auth-callback': dropboxAuthCallback,
  '/api/dropbox/token': dropboxToken,
  '/api/dropbox/disconnect': dropboxDisconnect,
});
