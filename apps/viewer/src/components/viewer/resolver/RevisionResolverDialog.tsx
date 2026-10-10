/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import type { MatchResult } from '@ifc-lite/model-match';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
export interface RevisionChoice { modelId: string; baseId: string; hide: boolean; compare: boolean }
export function RevisionResolverDialog({ results, labels, onConfirm, onLater }: { results: readonly MatchResult[]; labels: ReadonlyMap<string, string>; onConfirm: (choices: RevisionChoice[]) => void; onLater: () => void }) {
  const { t } = useTranslation();
  const [choices, setChoices] = useState<Record<string, string>>(() => Object.fromEntries(results.map(r => [r.subjectId, r.results[0]?.verdict === 'likely-revision' ? r.results[0].candidateId : ''])));
  const [hide, setHide] = useState(true), [compare, setCompare] = useState(true);
  const selected = Object.values(choices).filter(v => v && v !== 'new');
  const duplicate = new Set(selected).size !== selected.length;
  return <Dialog open modal={false} onOpenChange={open => { if (!open) onLater(); }}><DialogContent><DialogTitle>{t('history.resolver.title')}</DialogTitle><DialogDescription>{t('history.resolver.description')}</DialogDescription>
    {results.map(result => <div key={result.subjectId} className="space-y-2 border-b pb-3">
      <label className="block">{labels.get(result.subjectId)}<select className="block w-full rounded border bg-background p-2" value={choices[result.subjectId] ?? ''} onChange={e => setChoices({ ...choices, [result.subjectId]: e.target.value })}>
        <option value="">{t('history.resolver.choose')}</option><option value="new">{t('history.resolver.new')}</option>
        {result.results.map(r => <option key={r.candidateId} value={r.candidateId}>{labels.get(r.candidateId)} · {r.verdict}</option>)}
      </select></label>
      <ul className="text-xs text-muted-foreground">{(result.results.find(r => r.candidateId === choices[result.subjectId]) ?? result.results[0])?.reasons.map(reason => <li key={reason}>{t(`history.reason.${reason}`)}</li>)}</ul>
    </div>)}
    <label><input type="checkbox" checked={hide} onChange={e => setHide(e.target.checked)} /> {t('history.resolver.hide')}</label>
    <label><input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} /> {t('history.resolver.compare')}</label>
    {duplicate && <p role="alert">{t('history.resolver.duplicate')}</p>}
    <Button variant="outline" onClick={onLater}>{t('history.resolver.later')}</Button>
    <Button disabled={duplicate || results.some(r => !choices[r.subjectId])} onClick={() => onConfirm(results.map(r => ({ modelId: r.subjectId, baseId: choices[r.subjectId], hide, compare })))}>{t('history.resolver.confirm')}</Button>
  </DialogContent></Dialog>;
}
