/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { SourceUploadDialog } from '../resolver/SourceUploadDialog';
import { HistoryExportSection } from './HistoryExportSection';
import { useOptionalSourceHost } from '@/services/sources/SourceHostProvider';

export function HistoryActions({ modelId }: { modelId: string }) {
  const { t } = useTranslation(), host = useOptionalSourceHost();
  const [upload, setUpload] = useState(false);
  const ask = useViewerStore(s => s.resolverEnabled);
  const setAsk = useViewerStore(s => s.setResolverEnabled);
  const pending = useViewerStore(s => s.resolverPending.has(modelId));
  const link = useViewerStore(s => s.localLineage.get(modelId));
  const base = useViewerStore(s => link ? s.models.get(link.baseModelId)?.name : undefined);
  return <div className="space-y-2 p-2 text-xs">
    {base && <p>{t('history.local.versionOf', { name: base })}</p>}
    <label className="block"><input type="checkbox" checked={ask} onChange={e => setAsk(e.target.checked)} /> {t('history.resolver.ask')}</label>
    {pending && <Button variant="outline" onClick={() => window.dispatchEvent(new Event('ifc-resolve-history'))}>{t('history.resolver.resolve')}</Button>}
    {host?.list().some(p => p.manifest.capabilities.commits?.write) && <Button variant="outline" onClick={() => setUpload(true)}>{t('history.upload.title')}</Button>}
    {upload && <SourceUploadDialog modelId={modelId} onClose={() => setUpload(false)} />}
    <Button variant="outline" onClick={() => window.dispatchEvent(new CustomEvent('ifc-export-history-package', { detail: modelId }))}>{t('history.export.package')}</Button>
    <HistoryExportSection modelId={modelId} />
  </div>;
}
