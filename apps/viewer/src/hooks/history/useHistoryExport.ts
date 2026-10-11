/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback } from 'react';
import { artifactDigest, buildHistoryIndex, buildHistoryPackage, stampHistory, markChangeSet, historyKeyAliases, storeCommitDiff, deletedElementsBcf, deletedElementsCsv, type HistoryPackageInput } from '@ifc-lite/history-export';
import { diffModels } from '@ifc-lite/diff';
import type { CommitPayload, SourceCommit, StoredCommitDiff, IdentityRecordSet } from '@ifc-lite/plugin-api';
import { IfcParser, extractPropertiesOnDemand, unwrapIfcZipView } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView } from '@ifc-lite/mutations';
import JSZip from 'jszip';
import { useResolveHistoryProvider } from './useHistoryProvider';
import { useViewerStore } from '@/store';
import { subjectFromModel } from '@/lib/resolver/subjectFromModel';
import { buildEntityFingerprints } from '@/lib/compare/buildFingerprints';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';

const ref = (c: SourceCommit) => ({ projectId: c.projectId, modelId: c.modelId, commitId: c.id });
async function fingerprints(payload: CommitPayload) {
  const store = await new IfcParser().parseColumnar(await unwrapIfcZipView(new Uint8Array(payload.bytes)));
  return buildEntityFingerprints({ modelId: 'history', store, meshes: [], idOffset: 0 });
}
export interface HistoryExportSelection { mode: 'history' | 'change-set' | 'package'; psetName?: string; baseId?: string; allArtifacts?: boolean; stampPackage?: boolean; allowPartial?: boolean; deletedBcf?: boolean; deletedCsv?: boolean; omitAuthors?: boolean; signal?: AbortSignal }

export function useHistoryExport() {
  const resolve = useResolveHistoryProvider();
  return useCallback(async (modelId: string, selection: HistoryExportSelection) => {
    const model = useViewerStore.getState().models.get(modelId);
    if (!model) throw new Error('Model is no longer loaded');
    const source = resolve(modelId);
    const chain: SourceCommit[] = [], diffs: StoredCommitDiff[] = [], identity: IdentityRecordSet[] = [];
    const artifacts = new Map<string, CommitPayload>();
    const localFiles = new Map<string, File>();
    const localPayload = async (commit: SourceCommit): Promise<CommitPayload | undefined> => {
      const file = localFiles.get(commit.id);
      return file ? { bytes: await file.arrayBuffer(), fileName: file.name, artifactDigest: commit.artifact.digest, format: /\.(ifczip|zip)$/i.test(file.name) ? 'ifc-zip' : 'ifc-step' } : undefined;
    };
    let partial = false;
    const check = () => selection.signal?.throwIfAborted();
    if (source?.provider.getCommit && source.provider.loadCommit && source.commitTag) {
      const ctx = source.createContext(), provider = source.provider;
      let id: string | undefined = source.commitTag.commitId;
      const seen = new Set<string>();
      while (id) {
        check();
        if (seen.has(id) || seen.size >= 10_000) throw new Error('Invalid or oversized commit chain');
        seen.add(id);
        const commit = await provider.getCommit!(ctx, { projectId: source.projectId, modelId: source.sourceModelId, commitId: id });
        chain.unshift(commit); id = commit.parents[0];
      }
      for (const commit of chain) {
        check();
        if (commit.id === chain.at(-1)!.id || commit.id === selection.baseId) {
          const payload = await provider.loadCommit!(ctx, ref(commit), { accept: ['ifc-step', 'ifc-zip'], signal: selection.signal });
          if (await artifactDigest(payload.bytes) !== commit.artifact.digest) throw new Error('Commit artifact digest mismatch');
          artifacts.set(commit.id, payload);
        }
      }
      const getPayload = async (commit: SourceCommit) => {
        const payload = artifacts.get(commit.id) ?? await provider.loadCommit!(ctx, ref(commit), { accept: ['ifc-step', 'ifc-zip'], signal: selection.signal });
        if (await artifactDigest(payload.bytes) !== commit.artifact.digest) throw new Error('Commit artifact digest mismatch');
        return payload;
      };
      for (let i = 0; i < chain.length; i++) {
        check(); const commit = chain[i], base = chain[i - 1];
        const baseRef = base ? ref(base) : { ...ref(commit), commitId: '' };
        let stored: StoredCommitDiff | undefined;
        if (provider.getCommitDiff) {
          try { stored = await provider.getCommitDiff(ctx, baseRef, ref(commit), { signal: selection.signal }); }
          catch (error) { check(); console.warn('[history-export] Stored diff unavailable; trying original artifacts', error); }
        }
        if (!stored) {
          try { stored = storeCommitDiff(diffModels(base ? await fingerprints(await getPayload(base)) : [], await fingerprints(await getPayload(commit)), { scope: 'data' }), baseRef, ref(commit)); }
          catch (error) { check(); console.warn('[history-export] Original artifacts unavailable', error); partial = true; }
        }
        if (stored) diffs.push(stored);
        if (base && provider.listIdentityRecords) identity.push(await provider.listIdentityRecords(ctx, ref(base), ref(commit)));
      }
    } else {
      const baseId = useViewerStore.getState().localLineage.get(modelId)?.baseModelId;
      const baseModel = baseId ? useViewerStore.getState().models.get(baseId) : undefined;
      if (!baseModel) throw new Error('Link this model to an earlier version first');
      const versions = [model], seen = new Set([model.id]);
      for (let version = baseModel; version && !seen.has(version.id);) {
        seen.add(version.id); versions.unshift(version);
        const parent = useViewerStore.getState().localLineage.get(version.id)?.baseModelId;
        const previous = parent ? useViewerStore.getState().models.get(parent) : undefined;
        if (!previous) break; version = previous;
      }
      let previous: Awaited<ReturnType<typeof subjectFromModel>>['fingerprints'] = [];
      for (const version of versions) {
        check();
        if (!version.sourceFile) throw new Error('Original delivery bytes are unavailable');
        const subject = await subjectFromModel(version), bytes = await version.sourceFile.arrayBuffer();
        const digest = await artifactDigest(bytes), parent = chain.at(-1);
        const commit: SourceCommit = { id: digest, projectId: 'local', modelId, parents: parent ? [parent.id] : [], createdAt: new Date(version.loadedAt).toISOString(), message: version.name, status: 'published', artifact: { digest, fileName: version.sourceFile.name, sizeBytes: bytes.byteLength } };
        chain.push(commit); localFiles.set(digest, version.sourceFile);
        if (version.id === model.id || digest === selection.baseId) artifacts.set(digest, { bytes, fileName: version.sourceFile.name, artifactDigest: digest, format: /\.(ifczip|zip)$/i.test(version.sourceFile.name) ? 'ifc-zip' : 'ifc-step' });
        diffs.push(storeCommitDiff(diffModels(previous ?? [], subject.fingerprints ?? [], { scope: 'both' }), { ...ref(commit), commitId: parent?.id ?? '' }, ref(commit)));
        previous = subject.fingerprints;
      }
    }
    check();
    const head = chain.at(-1)!, payload = artifacts.get(head.id)!;
    async function* pastArtifacts() {
      for (const commit of chain) {
        check();
        const payload = artifacts.get(commit.id) ?? await localPayload(commit) ?? await source!.provider.loadCommit!(source!.createContext(), ref(commit), { accept: ['ifc-step', 'ifc-zip'], signal: selection.signal });
        yield [commit.id, payload] as const;
      }
    }
    const base = chain.find(c => c.id === selection.baseId) ?? chain.at(-2);
    const compare = async (): Promise<StoredCommitDiff> => {
      if (!base) throw new Error('Choose an earlier version');
      let comparison = diffs.find(d => d.base.commitId === base.id && d.head.commitId === head.id);
      if (!comparison && source?.provider.getCommitDiff) {
        try { comparison = await source.provider.getCommitDiff(source.createContext(), ref(base), ref(head), { signal: selection.signal }); }
        catch (error) { check(); console.warn('[history-export] Comparison unavailable; trying original artifacts', error); }
      }
      if (!comparison) {
        const original = artifacts.get(base.id) ?? await localPayload(base) ?? await source?.provider.loadCommit?.(source.createContext(), ref(base), { accept: ['ifc-step', 'ifc-zip'], signal: selection.signal });
        if (original) {
          if (await artifactDigest(original.bytes) !== base.artifact.digest) throw new Error('Base artifact digest mismatch');
          comparison = storeCommitDiff(diffModels(await fingerprints(original), await fingerprints(payload), { scope: 'data', keyAliases: historyKeyAliases(chain, diffs, base.id, head.id) }), ref(base), ref(head));
        }
      }
      if (!comparison) throw new Error('The requested comparison is unavailable');
      return comparison;
    };
    const deletedReports = async (diff: StoredCommitDiff) => ({
      baseCommitId: base!.id,
      csv: selection.deletedCsv !== false ? deletedElementsCsv(diff, null) : undefined,
      bcf: selection.deletedBcf !== false ? await deletedElementsBcf(diff, null, { base: base!, head: selection.omitAuthors ? { ...head, author: undefined } : head, modelName: model.name }) : undefined,
    });
    const input: HistoryPackageInput = { model: { name: model.name, modelId: head.modelId, projectId: head.projectId }, chain, diffs, modelFile: payload, identity, partial, omitAuthors: selection.omitAuthors, pastArtifacts: selection.allArtifacts ? pastArtifacts() : undefined,
      deletedReports: selection.mode === 'package' && (selection.deletedBcf || selection.deletedCsv) ? await deletedReports(await compare()) : undefined };
    const filename = sanitizeFilename(model.name);
    const savePackage = async (contents: HistoryPackageInput) => {
      const blob = await buildHistoryPackage(contents); check(); downloadBlob(blob, `${filename}.ifchistory.zip`);
      return { partial, digest: await artifactDigest(await blob.arrayBuffer()) };
    };
    if (partial && !selection.allowPartial) throw new Error('Some history is unavailable. Enable export of incomplete history to continue.');
    if (selection.mode === 'package' && !selection.stampPackage) return savePackage(input);
    const store = await new IfcParser().parseColumnar(await unwrapIfcZipView(new Uint8Array(payload.bytes)));
    const view = new MutablePropertyView(store.properties, model.id);
    view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
    const index = buildHistoryIndex({ model: { name: model.name, projectId: head.projectId, modelId: head.modelId }, chain, diffs: new Map(diffs.map(d => [`${d.base.commitId}:${d.head.commitId}`, d])) });
    let chosenDiff: StoredCommitDiff | undefined;
    if (index.partial && !selection.allowPartial) throw new Error('Some history is unavailable. Enable export of incomplete history to continue.');
    if (selection.mode === 'history' || selection.mode === 'package') stampHistory(store, view, index, selection);
    else {
      if (!base) throw new Error('Choose an earlier version');
      chosenDiff = await compare();
      markChangeSet(store, view, chosenDiff, base, head, selection);
    }
    const output = new StepExporter(store, view).export({ schema: store.schemaVersion, applyMutations: true, filename: `${filename}.ifc`, additionalDescriptions: [`ifc-lite-export(${selection.mode === 'package' ? 'history' : selection.mode}); commit=${head.id}; base=${base?.id ?? ''}; source-digest=${head.artifact.digest}`] });
    check();
    const outputBytes = Uint8Array.from(output.content).buffer, digest = await artifactDigest(outputBytes);
    if (selection.mode === 'package') return savePackage({ ...input, stamped: true, modelFile: { bytes: outputBytes, fileName: `${filename}.ifc`, artifactDigest: digest, format: 'ifc-step' } });
    if (chosenDiff && base) {
      const reports = await deletedReports(chosenDiff);
      const zip = new JSZip(); zip.file(`${filename}.ifc`, output.content);
      if (reports.csv !== undefined) zip.file('deleted.csv', reports.csv);
      if (reports.bcf) zip.file('deleted.bcf', await reports.bcf.arrayBuffer());
      downloadBlob(new Blob([await zip.generateAsync({ type: 'arraybuffer' })]), `${filename}-changes.zip`);
    } else downloadBlob(new Blob([Uint8Array.from(output.content)]), `${filename}-history.ifc`);
    return { partial: index.partial, digest };
  }, [resolve]);
}
