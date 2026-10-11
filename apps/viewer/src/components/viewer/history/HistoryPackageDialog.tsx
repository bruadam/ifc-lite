/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { HistoryExportSection } from './HistoryExportSection';

export function HistoryPackageDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), [modelId, setModelId] = useState('');
  const models = useViewerStore(s => s.models);
  const tags = useViewerStore(s => s.commitTags), links = useViewerStore(s => s.localLineage);
  const available = [...models.values()].filter(model => tags.has(model.id) || links.has(model.id));
  useEffect(() => {
    const show = (event: Event) => {
      const state = useViewerStore.getState();
      const requested = event instanceof CustomEvent && typeof event.detail === 'string' ? event.detail : state.historyFocusModelId;
      setModelId(requested ?? [...state.models.keys()].find(id => state.commitTags.has(id) || state.localLineage.has(id)) ?? '');
      setOpen(true);
    };
    window.addEventListener('ifc-export-history-package', show);
    return () => window.removeEventListener('ifc-export-history-package', show);
  }, []);
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent>
    <DialogTitle>{t('history.export.package')}</DialogTitle>
    <DialogDescription>{t('history.export.privacy')}</DialogDescription>
    <label>{t('history.panel.modelLabel')}<select value={modelId} onChange={event => setModelId(event.target.value)}>
      <option value="">{t('history.resolver.choose')}</option>
      {available.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
    </select></label>
    {open && available.some(model => model.id === modelId) && <HistoryExportSection key={modelId} modelId={modelId} initialMode="package" />}
  </DialogContent></Dialog>;
}
