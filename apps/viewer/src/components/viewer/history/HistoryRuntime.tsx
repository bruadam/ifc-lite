/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { SourceDropUpload, sourceUploadLoads } from '../resolver/SourceDropUpload';
import { HistoryPackageDialog } from './HistoryPackageDialog';
import { useEffect, useRef, useState } from 'react';
import { matchModels, type MatchResult } from '@ifc-lite/model-match';
import { createHistoryPackageProvider } from '@ifc-lite/history-export';
import { useViewerStore } from '@/store';
import { useOptionalSourceHost } from '@/services/sources/SourceHostProvider';
import { subjectFromModel } from '@/lib/resolver/subjectFromModel';
import { openedHistoryPackages } from '@/lib/history/packageFiles';
import { RevisionResolverDialog, type RevisionChoice } from '../resolver/RevisionResolverDialog';
import { useCompare } from '@/hooks/useCompare';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';

export function HistoryRuntime() {
  const { t } = useTranslation();
  const host = useOptionalSourceHost();
  const commitTags = useViewerStore(s => s.commitTags);
  const sessions = useRef(new Set<string>());
  const [generation, setGeneration] = useState(0);
  const mounted = useRef(true);
  const models = useViewerStore(s => s.models), loading = useViewerStore(s => s.loading);
  const [results, setResults] = useState<MatchResult[]>([]);
  const seen = useRef(new Set<string>());
  const running = useRef(false);
  const { runComparison } = useCompare();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    for (const id of seen.current) if (!models.has(id)) seen.current.delete(id);
    for (const name of sessions.current) {
      if ([...commitTags.values()].some(tag => tag.provider === name)) continue;
      host?.unregister(name); sessions.current.delete(name);
    }
  }, [models, commitTags, host]);
  useEffect(() => {
    if (loading || running.current) return;
    const fresh = [...models.values()].filter(m => !seen.current.has(m.id) && m.sourceFile && m.ifcDataStore);
    if (!fresh.length) return;
    const freshIds = new Set(fresh.map(model => model.id));
    running.current = true;
    void (async () => {
      const pending: MatchResult[] = [];
      for (const model of fresh) {
        if (!mounted.current) return;
        seen.current.add(model.id);
        const state = useViewerStore.getState();
        const pack = openedHistoryPackages.get(model.sourceFile!);
        if (pack && host) {
          const name = `history-${crypto.randomUUID()}`;
          if (!host.registerSession(createHistoryPackageProvider(pack, name))) throw new Error('Could not register history package');
          sessions.current.add(name);
          const head = pack.chain.at(-1)!;
          state.setCommitTag(model.id, { provider: name, projectId: head.projectId, sourceModelId: head.modelId, commitId: head.id, artifactDigest: head.artifact.digest, historical: !!pack.stamped, loadedAt: Date.now() });
          continue;
        }
        if (sourceUploadLoads.has(model.id) || state.commitTags.has(model.id) || state.sourceTags.has(model.id) || state.collabRole !== null || !state.resolverEnabled) continue;
        const subject = await subjectFromModel(model);
        const candidates = [];
        for (const candidate of models.values()) if (!freshIds.has(candidate.id) && candidate.ifcDataStore && candidate.loadedAt <= model.loadedAt) candidates.push({ ...await subjectFromModel(candidate), origin: 'loaded' as const });
        if (!candidates.length || !state.models.has(model.id)) continue;
        const result = await matchModels(subject, candidates);
        if (!useViewerStore.getState().models.has(model.id)) continue;
        if (result.results[0]?.verdict === 'identical') {
          toast.info(t('history.resolver.identical'), { label: t('history.resolver.closeCopy'), onClick: () => useViewerStore.getState().removeModel(model.id) });
        } else if (result.results.some(r => r.verdict !== 'unrelated')) pending.push(result);
        else state.setResolverPending(model.id, result);
      }
      if (mounted.current) setResults(current => [...current, ...pending]);
    })().catch(error => toast.error(error instanceof Error ? error.message : String(error))).finally(() => { running.current = false; if (mounted.current) setGeneration(n => n + 1); });
  }, [models, loading, host, t, generation]);
  useEffect(() => {
    const reopen = () => setResults([...useViewerStore.getState().resolverPending.values()]);
    window.addEventListener('ifc-resolve-history', reopen);
    return () => window.removeEventListener('ifc-resolve-history', reopen);
  }, []);
  const finish = (choices?: RevisionChoice[]) => {
    const state = useViewerStore.getState();
    for (const result of results) {
      const choice = choices?.find(c => c.modelId === result.subjectId);
      if (!choice) { state.setResolverPending(result.subjectId, result); continue; }
      state.setResolverPending(choice.modelId, null);
      if (choice.baseId === 'new' || !state.models.has(choice.modelId) || !state.models.has(choice.baseId)) continue;
      const match = result.results.find(r => r.candidateId === choice.baseId)!;
      state.setLocalLineage(choice.modelId, { baseModelId: choice.baseId, decidedAt: Date.now(), evidence: { verdict: match.verdict, score: match.score, guidOverlap: match.evidence.guidOverlap ?? 0 } });
      if (choice.hide) state.setModelVisibility(choice.baseId, false);
      if (choice.compare) { state.setCompareBaseModelId(choice.baseId); state.setCompareHeadModelId(choice.modelId); state.showWorkspacePanel('compare'); }
    }
    if (choices?.some(c => c.compare && c.baseId !== 'new')) void runComparison();
    setResults([]);
  };
  return <><HistoryPackageDialog /><SourceDropUpload />{results.length ? <RevisionResolverDialog key={results.map(r => r.subjectId).join('|')} results={results} labels={new Map([...models.values()].map(m => [m.id, m.name]))} onConfirm={finish} onLater={() => finish()} /> : null}</>;
}
