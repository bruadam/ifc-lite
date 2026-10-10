/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { NamingConfig, NormalizedName } from './types.js';

function calendarDate(text: string): boolean {
  const digits = text.replace(/[-_. ]/g, '');
  const possibilities = digits.length === 8
    ? [[+digits.slice(0, 4), +digits.slice(4, 6), +digits.slice(6)], [+digits.slice(4), +digits.slice(2, 4), +digits.slice(0, 2)]]
    : digits.length === 6 ? [[2000 + +digits.slice(0, 2), +digits.slice(2, 4), +digits.slice(4)]] : [];
  return possibilities.some(([y, m, d]) => {
    const date = new Date(Date.UTC(y, m - 1, d));
    return y >= 1900 && y <= 2199 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  });
}

export function normalizeModelName(fileName: string, naming: NamingConfig = {}): NormalizedName {
  let name = fileName.split(/[/\\]/).pop()!.normalize('NFKC').toLowerCase().trim();
  const removed: NormalizedName['removed'][number][] = [];
  const extension = name.match(/\.(?:ifc\.zip|ifczip|ifcxml|ifcx|ifc)$/)?.[0];
  if (extension) { removed.push({ kind: 'extension', text: extension }); name = name.slice(0, -extension.length); }
  const iso = naming.iso19650 === false ? null : name.match(/^([a-z0-9]{2,})-([a-z0-9]{2,})-([a-z0-9]{2})-([a-z0-9]{2})-([a-z0-9]{2})-([a-z])-([0-9]{4,})(?:-([a-z][0-9]))?(?:-([pc][0-9]{2}(?:\.[0-9]+)?))?$/i);
  if (iso) {
    const [, project, originator, volume, level, type, role, number, status, revision] = iso;
    if (status) removed.push({ kind: 'status', text: status });
    if (revision) removed.push({ kind: 'revision', text: revision });
    const tokens = [project, originator, volume, level, type, role, number];
    return { stem: tokens.join('-'), tokens, removed, iso19650: { project, originator, volume, level, type, role, number, status, revision } };
  }
  const copies = new Set(['copy', 'kopi', 'kopia', ...(naming.copyMarkers ?? []).map(x => x.toLowerCase())]);
  const patterns = (naming.revisionPatterns ?? []).map(p => new RegExp(`^(?:${p})$`, 'i'));
  while (name) {
    const copyNumber = name.match(/[ _.-]*\(\d+\)$/);
    const revision = name.match(/(?:^|[ _-])((?:rev(?:ision)?[ _-]+[a-z0-9]{1,3})|(?:r\d{1,3})|(?:v\d{1,3}(?:\.\d+)*)|(?:(?:version|udgave)[ _-]+\d+)|(?:[pc]\d{2}(?:\.\d+)?))$/i);
    const date = name.match(/(?:^|[ _.-])(\d{4}[-_. ]\d{2}[-_. ]\d{2}|\d{2}[-_. ]\d{2}[-_. ]\d{4}|\d{8}|\d{6})(?:[ _-](\d{4}|\d{6}))?$/);
    const token = name.match(/(?:^|[ _.-])([^ _.-]+)$/);
    let suffix: string | undefined;
    let kind: NormalizedName['removed'][number]['kind'] = 'revision';
    if (copyNumber) { suffix = copyNumber[0]; kind = 'copy'; }
    else if (date && calendarDate(date[1]) && (!date[2] || (+date[2].slice(0, 2) < 24 && +date[2].slice(2, 4) < 60 && +(date[2].slice(4) || '0') < 60))) { suffix = date[0]; kind = 'date'; }
    else if (revision) suffix = revision[0];
    else if (token && copies.has(token[1])) { suffix = token[0]; kind = 'copy'; }
    else if (token && patterns.some(p => p.test(token[1]))) suffix = token[0];
    if (!suffix) break;
    removed.push({ kind, text: suffix.replace(/^[ _.-]+/, '') });
    name = name.slice(0, -suffix.length).trim();
  }
  const tokens = name.split(/[\s_.\-()[\]]+/).filter(Boolean);
  return { stem: tokens.join('-'), tokens, removed };
}

export function nameSimilarity(a: NormalizedName, b: NormalizedName): number {
  if (!a.stem || !b.stem) return 0;
  if (a.iso19650 && b.iso19650) return a.stem === b.stem ? 1 : 0;
  if (a.stem === b.stem) return 1;
  const sa = new Set(a.tokens), sb = new Set(b.tokens);
  const shared = [...sa].filter(t => sb.has(t)).length;
  const jaccard = shared / new Set([...sa, ...sb]).size;
  // Bound quadratic edit-distance work for file-supplied names.
  const x = a.stem.slice(0, 512), y = b.stem.slice(0, 512);
  let row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = next;
  }
  return Math.max(jaccard, 1 - row[y.length] / Math.max(x.length, y.length));
}
