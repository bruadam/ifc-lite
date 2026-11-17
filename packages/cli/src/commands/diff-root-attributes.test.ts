/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `diff --by-content` must see edits to an occurrence's Description and
 * ObjectType. The columnar parser leaves both columns empty for products, so
 * a fingerprint read only from the entity table hashed '' on both sides and
 * reported such an edit as unchanged.
 */

import { initDiff } from '@ifc-lite/diff';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildFileFingerprints } from './diff-engine.js';
import { loadIfcBytes } from '../loader.js';
import { guid, model } from './diff-test-helpers.js';

beforeAll(async () => { await initDiff(); });

const WALL_A = "#70= IFCWALL('" + guid('WALA') + "',$,'Wall A',$,$,#50,#64,'tagA',$);";

async function wallA(text: string) {
  const store = await loadIfcBytes(new TextEncoder().encode(text), 'm');
  const found = buildFileFingerprints(store).find((f) => f.key === guid('WALA'));
  if (!found) throw new Error('wall A was not fingerprinted');
  return found;
}

function withWallA(description: string, objectType: string): string {
  const base = model(guid('WALA'), guid('WALB'));
  if (!base.includes(WALL_A)) throw new Error('fixture changed: wall A record not found');
  return base.replace(WALL_A, `#70= IFCWALL('${guid('WALA')}',$,'Wall A',${description},${objectType},#50,#64,'tagA',$);`);
}

describe('root attributes the entity table leaves empty', () => {
  it('an ObjectType edit changes the data hash and the attr:core component', async () => {
    const before = await wallA(withWallA('$', '$'));
    const after = await wallA(withWallA('$', "'Load-bearing'"));
    expect(after.dataHash).not.toBe(before.dataHash);
    expect(after.components?.['attr:core']).not.toBe(before.components?.['attr:core']);
  });

  it('a Description edit changes the data hash', async () => {
    const before = await wallA(withWallA("'old'", '$'));
    const after = await wallA(withWallA("'new'", '$'));
    expect(after.dataHash).not.toBe(before.dataHash);
  });

  it('an unchanged record still hashes identically', async () => {
    const a = await wallA(withWallA("'d'", "'t'"));
    const b = await wallA(withWallA("'d'", "'t'"));
    expect(a.dataHash).toBe(b.dataHash);
  });
});
