/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Zip, ZipDeflate } from 'fflate';

/** Retain compressed output only; an added delivery can be released immediately. */
export class HistoryZipWriter {
  private readonly chunks: ArrayBuffer[] = [];
  private error: Error | null = null;
  private readonly zip = new Zip((error, data) => {
    if (error) this.error = error;
    else this.chunks.push(Uint8Array.from(data).buffer);
  });
  add(path: string, bytes: ArrayBuffer): void {
    const file = new ZipDeflate(path, { level: 6 });
    this.zip.add(file);
    const data = new Uint8Array(bytes);
    for (let start = 0; start < data.length; start += 65_536) file.push(data.subarray(start, start + 65_536));
    file.push(new Uint8Array(), true);
    if (this.error) throw this.error;
  }
  finish(): Blob {
    this.zip.end();
    if (this.error) throw this.error;
    return new Blob(this.chunks, { type: 'application/zip' });
  }
}
