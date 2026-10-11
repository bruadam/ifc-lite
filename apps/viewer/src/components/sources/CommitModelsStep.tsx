/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileSourceProvider, PluginContext, SourceModel } from '@ifc-lite/plugin-api';
import { Box } from 'lucide-react';
import { dispatchSourceDownload } from '@/services/sources/source-host';
import { verifyCommitPayload } from '@/lib/history/commitPayload';
import { useTranslation } from '@/i18n';
import { SourceEntityList, LoadMoreRow } from './SourceEntityList';
import { usePagedList } from './usePagedList';

export function CommitModelsStep({ provider, ctx, projectId, onError }: { provider: FileSourceProvider; ctx: PluginContext; projectId: string; onError: (error: string | null) => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const paged = usePagedList<SourceModel>(useCallback((cursor, signal) => provider.listModels!(ctx, projectId, { cursor, signal, limit: 100 }), [provider, ctx, projectId]), onError);
  const { start } = paged;
  useEffect(() => { start(); return () => request.current?.abort(); }, [start]);
  const open = async (model: SourceModel) => {
    if (request.current) return;
    const abort = new AbortController(); request.current = abort; setBusy(true); onError(null);
    try {
      if (!provider.getModel || !provider.getCommit || !provider.loadCommit) throw new Error('This source cannot open model commits');
      const current = await provider.getModel(ctx, { projectId, modelId: model.id });
      if (!current.headCommitId) throw new Error('This model has no published delivery');
      const ref = { projectId, modelId: model.id, commitId: current.headCommitId };
      const commit = await provider.getCommit(ctx, ref);
      const payload = await provider.loadCommit(ctx, ref, { accept: ['ifc-step', 'ifc-zip', 'ifcx'], signal: abort.signal });
      await verifyCommitPayload(payload, commit);
      abort.signal.throwIfAborted();
      dispatchSourceDownload([{ name: payload.fileName, buffer: payload.bytes, displayName: model.name, commit: { provider: provider.manifest.name, projectId, sourceModelId: model.id, commitId: commit.id, artifactDigest: payload.artifactDigest, historical: false, loadedAt: Date.now() } }]);
    } catch (error) { if (!abort.signal.aborted) onError(error instanceof Error ? error.message : String(error)); }
    finally { request.current = null; if (!abort.signal.aborted) setBusy(false); }
  };
  return <div className="min-h-0 flex-1 overflow-y-auto">
    <SourceEntityList items={paged.items} loading={paged.loading || busy} icon={Box} emptyLabel={t('history.source.empty')} onSelect={model => { void open(model); }} />
    <LoadMoreRow hasMore={paged.hasMore} loading={paged.loadingMore} onLoadMore={paged.loadMore} label={t('history.source.more')} />
  </div>;
}
