/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Runs every local API dev server in one process (`pnpm dev:api`), each on its
 * own port, matching the `vite.config.ts` dev proxy targets. Run
 * `scripts/dev-chat-api.ts` / `scripts/dev-cloud-oauth-api.ts` directly instead
 * when you only need one.
 */

import chatHandler from '../api/chat.ts';
import dropboxAuthStart from '../api/dropbox/auth-start.ts';
import dropboxAuthCallback from '../api/dropbox/auth-callback.ts';
import dropboxToken from '../api/dropbox/token.ts';
import dropboxDisconnect from '../api/dropbox/disconnect.ts';
import { serveWebHandler, serveWebRouter } from './lib/node-http-bridge.ts';

serveWebHandler(parseInt(process.env.CHAT_API_PORT ?? '3001', 10), 'dev-chat-api', chatHandler);

serveWebRouter(parseInt(process.env.CLOUD_OAUTH_API_PORT ?? '3002', 10), 'dev-cloud-oauth-api', {
  '/api/dropbox/auth-start': dropboxAuthStart,
  '/api/dropbox/auth-callback': dropboxAuthCallback,
  '/api/dropbox/token': dropboxToken,
  '/api/dropbox/disconnect': dropboxDisconnect,
});
