/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { matchModels, normalizeModelName, nameSimilarity, typeHistogramSimilarity } from './index.js';
import type { MatchSubject, MatchCandidate } from './types.js';
const fingerprints = (prefix: string, type = 'IfcWall', count = 20) => Array.from({ length: count }, (_, i) => ({ key: prefix + i, ifcType: type, dataHash: 'd' + i, ref: i, components: { 'attr:core': 'd' + i } }));
const subject = (overrides: Partial<MatchSubject> = {}): MatchSubject => ({ id: 'head', label: 'Structure', fileName: 'Structure_R03.ifc', fingerprints: fingerprints('a'), ...overrides });
const candidate = (overrides: Partial<MatchCandidate> = {}): MatchCandidate => ({ ...subject(), id: 'base', fileName: 'Structure_R02.ifc', origin: 'loaded', ...overrides });

describe('commit-history spec 03: evidence, not filename, decides identity', () => {
  it.each([
    ['STR_Model_R03.ifc', 'STR_Model_R02.ifc'], ['ARK-Hovedmodel 2026-09-12.ifc', 'ARK-Hovedmodel 2026-08-30.ifc'],
    ['Building A v2.1.ifc', 'Building A.ifc'], ['MEP model (1).ifc', 'MEP model.ifc'],
    ['PRJ-ORG-ZZ-02-M3-S-0001-S2-P03.ifc', 'PRJ-ORG-ZZ-02-M3-S-0001-S1-P02.ifc'],
  ])('normalizes delivery suffixes in %s', (a, b) => expect(normalizeModelName(a).stem).toBe(normalizeModelName(b).stem));
  it('retains internal levels, invalid dates and distinct ISO container numbers', () => {
    expect(normalizeModelName('level-02-slabs.ifc').stem).toBe('level-02-slabs');
    expect(normalizeModelName('model-20260230.ifc').stem).toBe('model-20260230');
    expect(nameSimilarity(normalizeModelName('PRJ-ORG-ZZ-02-M3-S-0001.ifc'), normalizeModelName('PRJ-ORG-ZZ-02-M3-S-0002.ifc'))).toBe(0);
  });
  it('does not identify unrelated elements from equal filenames', async () => {
    const result = await matchModels(subject(), [candidate({ fingerprints: fingerprints('b', 'IfcDuctSegment').map(e => ({ ...e, dataHash: 'other' + e.key })) })]);
    expect(result.results[0].verdict).toBe('unrelated');
  });
  it('recognizes unchanged content with reassigned GlobalIds', async () => {
    const result = await matchModels(subject(), [candidate({ fingerprints: fingerprints('b') })]);
    expect(result.results[0].verdict).toBe('likely-revision');
    expect(result.results[0].reasons).toContain('reguid-suspected');
  });
  it('recognizes a revision and a half-model without treating overlap as Jaccard', async () => {
    const result = await matchModels(subject(), [candidate({ fingerprints: fingerprints('a', 'IfcWall', 10) })]);
    expect(result.results[0].verdict).toBe('likely-revision');
    expect(result.results[0].evidence.guidOverlap).toBe(1);
    expect(result.results[0].evidence.guidJaccard).toBe(.5);
  });
  it('abstains from likely when cancelled or sampled', async () => {
    for (const options of [{ signal: AbortSignal.abort() }, { timeBudgetMs: 0 }]) {
      const result = await matchModels(subject(), [candidate()], options);
      expect(result.results[0].evidence.partial).toBe(true);
      expect(result.results[0].verdict).not.toBe('likely-revision');
    }
  });
  it('digest equality survives missing element evidence', async () => {
    const result = await matchModels(subject({ digest: 'sha256:abc', fingerprints: null }), [candidate({ digest: 'sha256:abc', fingerprints: null })]);
    expect(result.results[0].verdict).toBe('identical');
  });
  it('distinguishes disciplines by their type histogram', () => expect(typeHistogramSimilarity(fingerprints('a'), fingerprints('b', 'IfcDuctSegment'))).toBe(0));
});
