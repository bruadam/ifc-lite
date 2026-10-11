/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useHistoryExport, type HistoryExportSelection } from '@/hooks/history/useHistoryExport';
import { useModelHistory } from '@/hooks/history/useModelHistory';

export function HistoryExportSection({ modelId, initialMode = 'history' }: { modelId: string; initialMode?: HistoryExportSelection['mode'] }) {
  const { t } = useTranslation();
  const tag = useViewerStore(s => s.commitTags.get(modelId));
  const link = useViewerStore(s => s.localLineage.get(modelId));
  const history = useModelHistory(modelId);
  const run = useHistoryExport();
  const [selection, setSelection] = useState<HistoryExportSelection>({ mode: initialMode });
  const [digest, setDigest] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  if (!tag && !link) return null;
  return <><fieldset className="space-y-2 rounded border p-3" disabled={busy}><legend>{t('history.export.title')}</legend>
    <label className="block">{t('history.export.title')}<select className="ml-2 rounded border bg-background" value={selection.mode} onChange={e => setSelection({ ...selection, mode: e.target.value as HistoryExportSelection['mode'] })}>
      <option value="history">{t('history.export.stamp')}</option><option value="change-set">{t('history.export.changes')}</option><option value="package">{t('history.export.package')}</option>
    </select></label>
    {(selection.mode === 'change-set' || selection.mode === 'package') && tag && <label>{t('history.export.changes')}<select aria-label={t('history.export.changes')} value={selection.baseId ?? ''} onChange={e => setSelection({ ...selection, baseId: e.target.value })}>
      <option value="">{t('history.resolver.choose')}</option>{history.commits.filter(c => c.id !== tag.commitId).map(c => <option key={c.id} value={c.id}>{c.message ?? c.id}</option>)}
    </select></label>}
    {selection.mode !== 'history' && <>
      <label className="block"><input type="checkbox" checked={selection.deletedBcf ?? selection.mode === 'change-set'} onChange={e => setSelection({ ...selection, deletedBcf: e.target.checked })} /> {t('history.export.deletedBcf')}</label>
      <label className="block"><input type="checkbox" checked={selection.deletedCsv ?? selection.mode === 'change-set'} onChange={e => setSelection({ ...selection, deletedCsv: e.target.checked })} /> {t('history.export.deletedCsv')}</label>
    </>}
    {selection.mode !== 'package' && <label className="block">{t('history.export.pset')}<input className="ml-2 rounded border bg-background" value={selection.psetName ?? ''} placeholder={t(selection.mode === 'history' ? 'history.export.historyPset' : 'history.export.changePset')} onChange={e => setSelection({ ...selection, psetName: e.target.value || undefined })} /></label>}
    {selection.mode === 'package' && <label className="block"><input type="checkbox" checked={!!selection.allArtifacts} onChange={e => setSelection({ ...selection, allArtifacts: e.target.checked })} /> {t('history.export.artifacts')}</label>}
    {selection.mode === 'package' && <label className="block"><input type="checkbox" checked={!!selection.stampPackage} onChange={e => setSelection({ ...selection, stampPackage: e.target.checked })} /> {t('history.export.stamp')}</label>}
    {selection.mode === 'package' && <p>{t('history.export.size', { bytes: history.commits.reduce((total, c) => total + c.artifact.sizeBytes, 0) })}</p>}
    <label className="block"><input type="checkbox" checked={!!selection.allowPartial} onChange={e => setSelection({ ...selection, allowPartial: e.target.checked })} /> {t('history.export.allowPartial')}</label>
    {digest && <output className="block break-all text-xs">{digest}</output>}
    <p className="text-xs text-muted-foreground">{t('history.export.privacy')}</p>
    <label className="block"><input type="checkbox" checked={!!selection.omitAuthors} onChange={e => setSelection({ ...selection, omitAuthors: e.target.checked })} /> {t('history.export.omit')}</label>
    <Button onClick={() => {
      const controller = new AbortController(); abort.current = controller; setBusy(true);
      void run(modelId, { ...selection, signal: controller.signal }).then(result => { if (result?.digest) setDigest(result.digest); if (result?.partial) toast.info(t('history.export.partial')); }).catch(error => toast.error(error instanceof Error ? error.message : String(error))).finally(() => { setBusy(false); abort.current = null; });
    }}>{t('history.export.run')}</Button>
  </fieldset>{busy && <Button onClick={() => abort.current?.abort()}>{t('history.export.cancel')}</Button>}</>;
}
