/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { ENTITIES_IFC2X3, ENTITIES_IFC4_EXPRESS, ENTITIES_IFC4X3, type IfcStoreBase } from '@ifc-lite/data';

const parents = new Map([...ENTITIES_IFC2X3, ...ENTITIES_IFC4_EXPRESS, ...ENTITIES_IFC4X3].map(e => [e.name.toUpperCase(), e.parent?.toUpperCase()]));
const products = new Set([...parents.keys()].filter(name => {
  const visited = new Set<string>();
  for (let type: string | undefined = name; type && !visited.has(type); type = parents.get(type)) {
    if (type === 'IFCPRODUCT') return true;
    visited.add(type);
  }
  return false;
}));
import type { EntityFingerprint } from '@ifc-lite/diff';
import type { HeaderSignals } from './types.js';

export const DEFAULT_EXCLUDED = ['IfcOpeningElement', 'IfcVirtualElement', 'IfcAnnotation', 'IfcGrid', 'IfcGridAxis', 'IfcProject', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey'];

export function headerSignalsFromStore(store: IfcStoreBase): HeaderSignals {
  const header = store.sourceHeader;
  const keys = (type: string) => (store.entityIndex.byType.get(type) ?? []).map(id => store.entities.getGlobalId(id)).filter(Boolean);
  return { schema: header?.schemaIdentifiers[0] ?? store.schemaVersion, originatingSystem: header?.originatingSystem,
    preprocessorVersion: header?.preprocessorVersion, organization: header?.organization ?? [], author: header?.author ?? [],
    projectGlobalId: keys('IFCPROJECT')[0], siteGlobalIds: keys('IFCSITE'), buildingGlobalIds: keys('IFCBUILDING') };
}

export function compared(entries: readonly EntityFingerprint[], excludeTypes = DEFAULT_EXCLUDED): EntityFingerprint[] {
  const excluded = new Set(excludeTypes.map(t => t.toUpperCase()));
  return entries.filter(e => e.key && products.has(e.ifcType.toUpperCase()) && !excluded.has(e.ifcType.toUpperCase()));
}

export function guidOverlap(a: readonly EntityFingerprint[], b: readonly EntityFingerprint[], excludeTypes?: readonly string[]) {
  const x = new Set(compared(a, excludeTypes ? [...excludeTypes] : undefined).map(e => e.key));
  const y = new Set(compared(b, excludeTypes ? [...excludeTypes] : undefined).map(e => e.key));
  const shared = [...x].filter(k => y.has(k)).length;
  return { overlap: shared / (Math.min(x.size, y.size) || 1), jaccard: shared / (x.size + y.size - shared || 1), shared };
}

export function typeHistogramSimilarity(a: readonly EntityFingerprint[], b: readonly EntityFingerprint[]): number {
  const histogram = (items: readonly EntityFingerprint[]) => {
    const map = new Map<string, number>();
    for (const e of items) { const t = e.ifcType.toUpperCase(); map.set(t, (map.get(t) ?? 0) + 1); }
    return new Map([...map].map(([t, n]) => [t, Math.log1p(n)]));
  };
  const x = histogram(a), y = histogram(b);
  let dot = 0, xx = 0, yy = 0;
  for (const [t, n] of x) { dot += n * (y.get(t) ?? 0); xx += n * n; }
  for (const n of y.values()) yy += n * n;
  return dot / (Math.sqrt(xx * yy) || 1);
}

/** Deterministic proportional sampling; preserves small type groups. */
export function sample(entries: readonly EntityFingerprint[], limit: number): EntityFingerprint[] {
  if (entries.length <= limit) return [...entries];
  const groups = new Map<string, EntityFingerprint[]>();
  for (const e of entries) { const group = groups.get(e.ifcType) ?? []; group.push(e); groups.set(e.ifcType, group); }
  const result: EntityFingerprint[] = [];
  for (const group of groups.values()) {
    const count = Math.max(1, Math.floor(limit * group.length / entries.length));
    for (let i = 0; i < count && result.length < limit; i++) result.push(group[Math.floor(i * group.length / count)]);
  }
  return result;
}
