/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import 'jszip';
declare module 'jszip' {
  interface JSZipObject {
    /** JSZip's documented streaming entry reader, omitted from its bundled declarations. */
    internalStream(type: 'uint8array'): JSZipStreamHelper<Uint8Array>;
  }
}
