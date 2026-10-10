/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isDerivedHistoryExport } from '@ifc-lite/history-export';
import { invalidateModelHistory } from '@/hooks/history/useModelHistory';
import { useEffect, useRef, useState } from 'react';
import { matchModels, type MatchResult, type MatchSubject } from '@ifc-lite/model-match';
import type { SourceModel, SourceProject } from '@ifc-lite/plugin-api';
import { useViewerStore } from '@/store';
import { useOptionalSourceHost } from '@/services/sources/SourceHostProvider';
import { loadResolvedSourcePrefs } from '@/lib/sources/preferences';
import { subjectFromModel } from '@/lib/resolver/subjectFromModel';
import { sourceCandidates, uploadRevision } from '@/hooks/resolver/sourceUpload';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';

export function SourceUploadDialog({ modelId, onClose }: { modelId: string; onClose: () => void }) {
  const { t } = useTranslation(), host = useOptionalSourceHost();
  const providers = host?.list().filter(p => p.manifest.capabilities.commits?.write) ?? [];
  const [providerId, setProviderId] = useState(providers[0]?.manifest.name ?? '');
  const [projects, setProjects] = useState<SourceProject[]>([]), [projectId, setProjectId] = useState('');
  const [models, setModels] = useState<SourceModel[]>([]), [targetId, setTargetId] = useState('');
  const [match, setMatch] = useState<MatchResult | null>(null), [subject, setSubject] = useState<MatchSubject | null>(null);
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [progress, setProgress] = useState(0);
  const createdModel = useRef<SourceModel | null>(null);
  const request = useRef<AbortController | null>(null), key = useRef(crypto.randomUUID());
  useEffect(() => {
    const abort = new AbortController(); setProjectId(''); setProjects([]);
    const provider = host?.get(providerId);
    if (provider && host) {
      const ctx = host.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest));
      void (async () => {
        const all: SourceProject[] = []; let cursor: string | undefined; const seen = new Set<string>();
        do { const page = await provider.listProjects(ctx, { cursor, signal: abort.signal }); all.push(...page.items); cursor = page.cursor; if (cursor && seen.has(cursor) || all.length > 10_000) throw new Error('Invalid project listing'); if (cursor) seen.add(cursor); } while (cursor);
        if (!abort.signal.aborted) setProjects(all);
      })().catch(e => { if (!abort.signal.aborted) setError(String(e)); });
    }
    return () => abort.abort();
  }, [host, providerId]);
  useEffect(() => {
    createdModel.current = null; key.current = crypto.randomUUID();
    const abort = new AbortController(); setMatch(null); setTargetId(''); setModels([]); setError('');
    const provider = host?.get(providerId), model = useViewerStore.getState().models.get(modelId);
    if (host && provider && projectId && model) {
      setBusy(true);
      void (async () => {
        const subject = await subjectFromModel(model);
        const found = await sourceCandidates(provider, host.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest)), projectId, abort.signal);
        const result = await matchModels(subject, found.candidates, { signal: abort.signal });
        if (abort.signal.aborted) return;
        setSubject(subject); setModels(found.models); setMatch(result);
        if (result.results[0]?.verdict === 'likely-revision') setTargetId(result.results[0].candidateId);
      })().catch(e => { if (!abort.signal.aborted) setError(String(e)); }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    } else setBusy(false);
    return () => abort.abort();
  }, [host, providerId, projectId, modelId]);
  useEffect(() => () => request.current?.abort(), []);
  const upload = async () => {
    const provider = host?.get(providerId), model = useViewerStore.getState().models.get(modelId);
    if (!host || !provider || !model?.sourceFile || !subject || !match) return;
    if (targetId !== 'new' && isDerivedHistoryExport(model.ifcDataStore?.sourceHeader?.description)) { setError(t('history.upload.derived')); return; }
    const abort = new AbortController(); request.current = abort; setBusy(true); setError('');
    try {
      const commit = await uploadRevision({ provider, ctx: host.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest)), projectId, model: models.find(m => m.id === targetId) ?? createdModel.current, onModelCreated: model => { if (targetId === 'new') createdModel.current = model; }, subject, match, bytes: await model.sourceFile.arrayBuffer(), message, idempotencyKey: key.current, newModel: targetId === 'new', signal: abort.signal, onProgress: (sent, total) => setProgress(total ? Math.round(sent / total * 100) : 0) });
      invalidateModelHistory(providerId, projectId, commit.modelId);
      if (useViewerStore.getState().models.has(modelId)) useViewerStore.getState().setCommitTag(modelId, { provider: providerId, projectId, sourceModelId: commit.modelId, commitId: commit.id, artifactDigest: commit.artifact.digest, historical: false, loadedAt: Date.now() });
      onClose();
    } catch (e) {
      if (e && typeof e === 'object' && 'updatedModel' in e && 'updatedMatch' in e) {
        const updated = e.updatedModel as SourceModel;
        setModels(current => current.map(m => m.id === updated.id ? updated : m));
        setMatch(e.updatedMatch as MatchResult);
      }
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    }
    finally { setBusy(false); request.current = null; }
  };
  return <Dialog open onOpenChange={open => { if (!open) { request.current?.abort(); onClose(); } }}><DialogContent><DialogTitle>{t('history.upload.title')}</DialogTitle><DialogDescription>{t('history.resolver.description')}</DialogDescription>
    <label>{t('history.upload.source')}<select disabled={busy} value={providerId} onChange={e => setProviderId(e.target.value)}>{providers.map(p => <option key={p.manifest.name} value={p.manifest.name}>{p.manifest.title}</option>)}</select></label>
    <label>{t('history.upload.project')}<select disabled={busy} value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">{t('history.resolver.choose')}</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label>{t('history.resolver.choose')}<select disabled={busy} value={targetId} onChange={e => { setTargetId(e.target.value); key.current = crypto.randomUUID(); }}><option value="">{t('history.resolver.choose')}</option><option value="new">{t('history.upload.new')}</option>{models.map(m => <option key={m.id} value={m.id}>{m.name} · {match?.results.find(r => r.candidateId === m.id)?.verdict}</option>)}</select></label>
    <ul>{match?.results.find(r => r.candidateId === targetId)?.reasons.map(reason => <li key={reason}>{t(`history.reason.${reason}`)}</li>)}</ul>
    <label>{t('history.upload.message')}<input disabled={busy} value={message} onChange={e => { setMessage(e.target.value); key.current = crypto.randomUUID(); }} /></label>
    {busy && <progress value={progress} max={100} aria-label={t('history.upload.submit')} />}{error && <p role="alert">{error}</p>}
    <Button disabled={busy || !match || !targetId} onClick={() => { void upload(); }}>{t('history.upload.submit')}</Button>
  </DialogContent></Dialog>;
}
