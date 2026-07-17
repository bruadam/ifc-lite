/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host-owned OAuth connection manager for `auth: 'oauth'` source providers.
 *
 * The popup-consent dance and its `localStorage`-event completion signal
 * live here — not in a plugin — because `@ifc-lite/plugin-api` is
 * deliberately DOM-free (providers never touch `window`/`localStorage`
 * directly). A provider only ever sees the resulting access token, via
 * `PluginContext.getAccessToken()` (wired in `source-host.ts`).
 *
 * The popup is opened at same-origin `/api/<providerId>/auth-start`, which
 * redirects to the provider's consent screen and back. Because the app sets
 * `Cross-Origin-Opener-Policy: same-origin`, `window.opener` is severed the
 * moment the popup navigates cross-origin, so `postMessage` back to the
 * opener isn't reliable — instead, the callback route (once the popup is
 * back on our own origin) writes the result into `localStorage` and this
 * module listens for the `storage` event, which does survive COOP.
 */

const AUTH_RESULT_KEY = 'ifc-lite:cloud:auth-result';
const CONNECTED_KEY_PREFIX = 'ifc-lite:cloud:connected:';
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const POPUP_POLL_INTERVAL_MS = 500;

interface AuthResultMessage {
  readonly provider: string;
  readonly ok: boolean;
  readonly message?: string;
  readonly ts: number;
}

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

export function isOAuthConnected(providerId: string): boolean {
  return localStorage.getItem(CONNECTED_KEY_PREFIX + providerId) === 'true';
}

function setConnected(providerId: string, connected: boolean): void {
  if (connected) {
    localStorage.setItem(CONNECTED_KEY_PREFIX + providerId, 'true');
  } else {
    localStorage.removeItem(CONNECTED_KEY_PREFIX + providerId);
  }
  tokenCache.delete(providerId);
}

export function connectOAuth(providerId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const width = 480;
    const height = 640;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    const popup = window.open(
      `/api/${providerId}/auth-start`,
      `ifc-lite-oauth-${providerId}`,
      `width=${width},height=${height},left=${left},top=${top}`,
    );

    if (!popup) {
      reject(new Error('Could not open the sign-in popup — check your browser’s popup blocker.'));
      return;
    }

    let settled = false;

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('storage', onStorage);
      clearInterval(pollHandle);
      if (!popup.closed) popup.close();
      if (err) reject(err);
      else resolve();
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key !== AUTH_RESULT_KEY || !e.newValue) return;
      let result: AuthResultMessage;
      try {
        result = JSON.parse(e.newValue) as AuthResultMessage;
      } catch {
        return;
      }
      if (result.provider !== providerId) return;

      if (result.ok) {
        setConnected(providerId, true);
        finish(null);
      } else {
        finish(new Error(result.message ?? 'Sign-in failed'));
      }
    };
    window.addEventListener('storage', onStorage);

    const pollHandle = setInterval(() => {
      if (popup.closed) {
        finish(settled ? null : new Error('Sign-in was cancelled'));
      }
    }, POPUP_POLL_INTERVAL_MS);
  });
}

export async function disconnectOAuth(providerId: string): Promise<void> {
  await fetch(`/api/${providerId}/disconnect`, { method: 'POST', credentials: 'same-origin' });
  setConnected(providerId, false);
}

export async function getOAuthAccessToken(providerId: string): Promise<string> {
  const cached = tokenCache.get(providerId);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return cached.accessToken;
  }

  const response = await fetch(`/api/${providerId}/token`, {
    method: 'POST',
    credentials: 'same-origin',
  });

  if (!response.ok) {
    if (response.status === 401) setConnected(providerId, false);
    throw new Error(`Not connected to ${providerId} (${response.status})`);
  }

  const body = (await response.json()) as { access_token: string; expires_in: number };
  const token: CachedToken = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  tokenCache.set(providerId, token);
  return token.accessToken;
}
