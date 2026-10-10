/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { headerSignalsFromStore, type MatchSubject } from '@ifc-lite/model-match';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types';
import { buildEntityFingerprints } from '@/lib/compare/buildFingerprints';
import { modelDigest } from '@/lib/compare/identitySidecar';

export async function subjectFromModel(model: FederatedModel): Promise<MatchSubject> {
  const store = model.ifcDataStore;
  return { id: model.id, label: model.name, fileName: model.sourceFile?.name ?? model.name, digest: await modelDigest(model) ?? undefined,
    header: store ? headerSignalsFromStore(store) : undefined,
    fingerprints: store && 'source' in store ? await buildEntityFingerprints({ modelId: model.id, store: store as IfcDataStore, meshes: model.geometryResult?.meshes ?? [], idOffset: model.idOffset, instancedGeometryHashes: model.geometryResult?.instancedGeometryHashes, instancedGeometryAabbs: model.geometryResult?.instancedGeometryAabbs, instancedGeometryVolumes: model.geometryResult?.instancedGeometryVolumes, geometryVolumesTrusted: false }) : null };
}
