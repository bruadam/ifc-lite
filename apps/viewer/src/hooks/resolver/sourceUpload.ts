/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { matchModels, type MatchCandidate, type MatchResult, type MatchSubject } from '@ifc-lite/model-match';
import type { FileSourceProvider, PluginContext, SourceModel, SourceCommit } from '@ifc-lite/plugin-api';

export async function sourceCandidates(provider: FileSourceProvider, ctx: PluginContext, projectId: string, signal: AbortSignal): Promise<{ models: SourceModel[]; candidates: MatchCandidate[] }> {
  if (!provider.listModels) throw new Error('This source has no model history');
  const models: SourceModel[] = [], candidates: MatchCandidate[] = [];
  let cursor: string | undefined; const seen = new Set<string>();
  do {
    signal.throwIfAborted();
    const page = await provider.listModels(ctx, projectId, { cursor, limit: 100, signal });
    models.push(...page.items); cursor = page.cursor;
    if (cursor && seen.has(cursor) || models.length > 10_000) throw new Error('Invalid or oversized source model listing');
    if (cursor) seen.add(cursor);
  } while (cursor);
  for (const model of models) {
    signal.throwIfAborted();
    let fingerprints: MatchSubject['fingerprints'] = null, sampled = false;
    if (model.headCommitId && provider.loadCommitFingerprints) {
      const set = await provider.loadCommitFingerprints(ctx, { projectId, modelId: model.id, commitId: model.headCommitId }, { maxEntries: 50_000, dataOnly: true, signal });
      fingerprints = set.entries.map(e => ({ ...e, components: e.components ? { ...e.components } : undefined, ref: undefined })); sampled = !!set.sample;
    }
    candidates.push({ id: model.id, label: model.name, fileName: model.name, fingerprints, sampled, origin: 'source' });
  }
  return { models, candidates };
}

export async function uploadRevision(input: { provider: FileSourceProvider; ctx: PluginContext; projectId: string; model: SourceModel | null; subject: MatchSubject; match: MatchResult; bytes: ArrayBuffer; message: string; idempotencyKey: string; newModel?: boolean; signal: AbortSignal; onModelCreated?: (model: SourceModel) => void; onProgress?: (sent: number, total?: number) => void }): Promise<SourceCommit> {
  const { provider, ctx, projectId, subject, signal } = input;
  if (!provider.createCommit || !provider.createModel || !provider.manifest.capabilities.commits?.write) throw new Error('This source is read-only');
  signal.throwIfAborted();
  const model = input.model ?? await provider.createModel(ctx, { projectId, name: subject.label });
  input.onModelCreated?.(model);
  signal.throwIfAborted();
  let candidate = input.match.results.find(r => r.candidateId === model.id);
  const create = (parent: string | null) => provider.createCommit!(ctx, { projectId, modelId: model.id, expectedParentId: parent, bytes: input.bytes, fileName: subject.fileName, message: input.message, idempotencyKey: input.idempotencyKey, signal, onProgress: input.onProgress,
    resolution: { decision: input.newModel || !input.model ? 'new-model' : 'revision-of', candidateModelId: input.model?.id, candidateCommitId: parent ?? undefined, resolver: input.match.resolver, verdict: candidate?.verdict ?? 'unrelated', evidence: { score: candidate?.score ?? 0, guidOverlap: candidate?.evidence.guidOverlap ?? 0, partial: candidate?.evidence.partial ?? true }, decidedAt: new Date().toISOString() } });
  try { return await create(model.headCommitId || null); }
  catch (error) {
    if ((error as { code?: string })?.code !== 'conflict' || !input.model || !provider.getModel || !provider.loadCommitFingerprints) throw error;
    signal.throwIfAborted();
    const updated = await provider.getModel(ctx, { projectId, modelId: model.id });
    const set = await provider.loadCommitFingerprints(ctx, { projectId, modelId: model.id, commitId: updated.headCommitId }, { maxEntries: 50_000, dataOnly: true, signal });
    const next = await matchModels(subject, [{ id: model.id, label: model.name, fileName: model.name, origin: 'source', sampled: !!set.sample, fingerprints: set.entries.map(e => ({ ...e, components: e.components ? { ...e.components } : undefined, ref: undefined })) }]);
    if (next.results[0]?.verdict !== candidate?.verdict) throw Object.assign(new Error('The source head changed; review the updated match before retrying'), { code: 'conflict', updatedModel: updated, updatedMatch: next });
    candidate = next.results[0];
    return create(updated.headCommitId);
  }
}
