/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { matchModels, nameSimilarity, normalizeModelName, type MatchCandidate, type MatchResult, type MatchSubject } from '@ifc-lite/model-match';
import type { FileSourceProvider, PluginContext, SourceModel, SourceCommit } from '@ifc-lite/plugin-api';

export async function sourceCandidates(provider: FileSourceProvider, ctx: PluginContext, projectId: string, signal: AbortSignal, subject?: MatchSubject): Promise<{ models: SourceModel[]; candidates: MatchCandidate[] }> {
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
  const name = subject ? normalizeModelName(subject.fileName) : undefined;
  const ranked = models.map(model => ({ model, score: name ? nameSimilarity(name, normalizeModelName(model.name)) : 1 })).sort((a, b) => b.score - a.score);
  const selected = new Set(ranked.filter(item => item.score >= .5).slice(0, 5).map(item => item.model.id));
  for (const model of models) {
    signal.throwIfAborted();
    let fingerprints: MatchSubject['fingerprints'] = null, sampled = false;
    if (selected.has(model.id) && model.headCommitId && provider.loadCommitFingerprints) {
      const set = await provider.loadCommitFingerprints(ctx, { projectId, modelId: model.id, commitId: model.headCommitId }, { maxEntries: 50_000, dataOnly: true, signal });
      if (set.commit.projectId !== projectId || set.commit.modelId !== model.id || set.commit.commitId !== model.headCommitId) throw new Error('Fingerprint set belongs to another commit');
      if (provider.getCommit) {
        const commit = await provider.getCommit(ctx, set.commit);
        if (commit.artifact.digest !== set.artifactDigest) throw new Error('Fingerprint artifact digest mismatch');
      }
      fingerprints = set.entries.map(e => ({ ...e, components: e.components ? { ...e.components } : undefined, ref: undefined })); sampled = !!set.sample;
    }
    candidates.push({ id: model.id, label: model.name, fileName: model.name, fingerprints, sampled, origin: 'source' });
  }
  if (subject?.fingerprints?.some(entry => entry.geometryHash !== undefined) && provider.loadCommitFingerprints) {
    const best = (await matchModels(subject, candidates, { signal })).results[0];
    const candidate = best && candidates.find(item => item.id === best.candidateId);
    const model = candidate && models.find(item => item.id === candidate.id);
    if (best?.verdict === 'possible-revision' && candidate && model?.headCommitId) {
      const set = await provider.loadCommitFingerprints(ctx, { projectId, modelId: model.id, commitId: model.headCommitId }, { maxEntries: 50_000, dataOnly: false, signal });
      if (set.commit.projectId !== projectId || set.commit.modelId !== model.id || set.commit.commitId !== model.headCommitId) throw new Error('Fingerprint set belongs to another commit');
      candidates[candidates.indexOf(candidate)] = { ...candidate, sampled: !!set.sample, fingerprints: set.entries.map(entry => ({ ...entry, components: entry.components ? { ...entry.components } : undefined, ref: undefined })) };
    }
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
    const next = await matchModels(subject, [{ id: model.id, label: model.name, fileName: model.name, origin: 'source', sampled: !!set.sample, fingerprints: set.entries.map(e => ({ ...e, components: e.components ? { ...e.components } : undefined, ref: undefined })) }], { signal });
    signal.throwIfAborted();
    if (next.results[0]?.verdict !== candidate?.verdict) throw Object.assign(new Error('The source head changed; review the updated match before retrying'), { code: 'conflict', updatedModel: updated, updatedMatch: next });
    candidate = next.results[0];
    return create(updated.headCommitId);
  }
}
