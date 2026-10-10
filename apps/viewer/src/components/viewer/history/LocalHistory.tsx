/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { useCompare } from '@/hooks/useCompare';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';

export function LocalHistory({ modelId }: { modelId: string }) {
  const { t } = useTranslation();
  const models = useViewerStore(s => s.models), links = useViewerStore(s => s.localLineage);
  const { runComparison } = useCompare();
  const chain: string[] = [], seen = new Set<string>();
  for (let id: string | undefined = modelId; id && models.has(id) && !seen.has(id); id = links.get(id)?.baseModelId) { seen.add(id); chain.push(id); }
  if (chain.length < 2) return <p className="p-3 text-xs text-muted-foreground">{t('history.state.noSource')}</p>;
  return <ol aria-label={t('history.local.title')} className="divide-y p-3 text-xs">{chain.map((id, index) => <li key={id} className="space-y-1 py-2">
    <p>{models.get(id)!.name}</p>
    <Button variant="outline" onClick={() => { const state = useViewerStore.getState(); state.setActiveModel(id); state.setModelVisibility(id, true); }}>{t('history.local.focus')}</Button>
    {chain[index + 1] && <Button variant="outline" onClick={() => {
      const state = useViewerStore.getState(); state.setCompareBaseModelId(chain[index + 1]); state.setCompareHeadModelId(id); state.showWorkspacePanel('compare'); void runComparison();
    }}>{t('history.action.compareWithLoaded')}</Button>}
  </li>)}</ol>;
}
