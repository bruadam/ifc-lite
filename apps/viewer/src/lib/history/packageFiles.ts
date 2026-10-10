/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readHistoryPackage, type HistoryPackage } from '@ifc-lite/history-export';
export const openedHistoryPackages = new WeakMap<File, HistoryPackage>();
/** Unwrap before the ordinary file router; the model still uses loadFile. */
export async function resolveHistoryPackages(files: readonly File[]): Promise<File[]> {
  const result: File[] = [];
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.ifchistory.zip')) { result.push(file); continue; }
    const pack = await readHistoryPackage(await file.arrayBuffer());
    const model = new File([pack.modelFile.bytes], pack.modelFile.fileName);
    openedHistoryPackages.set(model, pack);
    result.push(model);
  }
  return result;
}
