/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createBCFProject, createBCFTopic, writeBCF } from '@ifc-lite/bcf';
import { escapeCsvCell } from '@ifc-lite/export';
import type { CommitFingerprintSet, SourceCommit, StoredCommitDiff } from '@ifc-lite/plugin-api';

export function deletedElementsCsv(diff: StoredCommitDiff, fingerprints: CommitFingerprintSet | null): string {
  const byKey = new Map(fingerprints?.entries.map(e => [e.key, e]) ?? []);
  return [['GlobalId', 'IfcType', 'Container', 'BaseCommit'], ...diff.entries.filter(e => e.state === 'deleted').map(e => [e.key, e.ifcType, byKey.get(e.key)?.container ?? '', diff.base.commitId])].map(row => row.map(value => escapeCsvCell(value)).join(',')).join('\r\n') + '\r\n';
}
export async function deletedElementsBcf(diff: StoredCommitDiff, fingerprints: CommitFingerprintSet | null, context: { readonly base: SourceCommit; readonly head: SourceCommit; readonly modelName: string }): Promise<Blob> {
  const project = createBCFProject({ name: context.modelName });
  const deleted = diff.entries.filter(e => e.state === 'deleted');
  if (deleted.length) {
    const topic = createBCFTopic({ title: `Deleted since ${context.base.id.slice(0, 15)}`, author: context.head.author?.displayName ?? 'Unknown', topicType: 'Remark', description: `Base: ${context.base.id}\nHead: ${context.head.id}` });
    const keys = new Set(deleted.map(e => e.key));
    const boxes = fingerprints?.entries.filter(e => keys.has(e.key) && e.aabb).map(e => e.aabb!) ?? [];
    const min = [0, 1, 2].map(i => boxes.length ? boxes.reduce((v, b) => Math.min(v, b.min[i]), Infinity) : 0);
    const max = [0, 1, 2].map(i => boxes.length ? boxes.reduce((v, b) => Math.max(v, b.max[i]), -Infinity) : 1);
    const size = Math.max(1, ...max.map((v, i) => v - min[i]));
    topic.viewpoints.push({ guid: crypto.randomUUID(), components: { selection: deleted.map(e => ({ ifcGuid: e.key })) }, orthogonalCamera: {
      cameraViewPoint: { x: (min[0] + max[0]) / 2 + size, y: (min[1] + max[1]) / 2 - size, z: (min[2] + max[2]) / 2 + size },
      cameraDirection: { x: -1 / Math.sqrt(3), y: 1 / Math.sqrt(3), z: -1 / Math.sqrt(3) }, cameraUpVector: { x: -1 / Math.sqrt(6), y: 1 / Math.sqrt(6), z: 2 / Math.sqrt(6) }, viewToWorldScale: size * 2,
    } });
    project.topics.set(topic.guid, topic);
  }
  return writeBCF(project);
}
