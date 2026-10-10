/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type JSZip from 'jszip';

/** Enforce the declared bound during inflation, before allocating the final buffer. */
export function readBounded(entry: JSZip.JSZipObject, limit: number): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0, failed = false;
    const stream = entry.internalStream('uint8array');
    stream.on('data', (chunk: Uint8Array) => {
      if (failed) return;
      size += chunk.byteLength;
      if (size > limit) { failed = true; stream.pause(); reject(new Error('Package file exceeds its declared size limit')); return; }
      chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      if (failed) return;
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      resolve(bytes.buffer);
    });
    stream.resume();
  });
}
