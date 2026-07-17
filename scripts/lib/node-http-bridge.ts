/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridges a Web `Request`/`Response` handler (the shape Vercel edge functions
 * use) onto a plain Node `http` server, for local dev. Shared by
 * `dev-chat-api.ts` and `dev-cloud-oauth-api.ts`.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type WebHandler = (req: Request) => Promise<Response> | Response;

async function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}

async function writeResponse(nodeRes: ServerResponse, response: Response): Promise<void> {
  const headers = Object.fromEntries(response.headers.entries());
  nodeRes.writeHead(response.status, headers);

  if (!response.body) {
    nodeRes.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) nodeRes.write(Buffer.from(value));
    }
  } finally {
    nodeRes.end();
  }
}

/** Starts a local Node http server that dispatches to `handler` for every request. */
export function serveWebHandler(port: number, label: string, handler: WebHandler): void {
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? `localhost:${port}`;
      const url = new URL(req.url ?? '/', `http://${host}`);
      const body = await readBody(req);
      const request = new Request(url.toString(), {
        method: req.method ?? 'GET',
        headers: req.headers as HeadersInit,
        body,
        duplex: 'half',
      } as RequestInit);

      const response = await handler(request);
      await writeResponse(res, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Local API dev server error: ${message}` }));
    }
  });

  server.listen(port, () => {
    console.log(`[${label}] listening on http://localhost:${port}`);
  });
}

/** Starts a local Node http server that dispatches by exact pathname among several handlers. */
export function serveWebRouter(
  port: number,
  label: string,
  routes: Record<string, WebHandler>,
): void {
  serveWebHandler(port, label, (req) => {
    const pathname = new URL(req.url).pathname;
    const handler = routes[pathname];
    if (!handler) {
      return new Response(JSON.stringify({ error: `No route for ${pathname}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return handler(req);
  });
}
