/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CandidateResult } from '@ifc-lite/model-match';
import { useTranslation } from '@/i18n';
import { getLocale } from '@/i18n/registry';
import { formatLocaleNumber } from '@/i18n/intlFormat';

export function EvidenceList({ result }: { result?: CandidateResult }) {
  const { t } = useTranslation();
  if (!result) return null;
  const { evidence } = result;
  const percent = (value: number) => formatLocaleNumber(getLocale(), value, { style: 'percent', maximumFractionDigits: 1 });
  const count = (value: number) => formatLocaleNumber(getLocale(), value);
  return <ul className="text-xs text-muted-foreground">
    {result.reasons.map(reason => <li key={reason}>{t(`history.reason.${reason}`)}</li>)}
    {evidence.guidOverlap !== undefined && <li>{t('history.evidence.keys', { percent: percent(evidence.guidOverlap), shared: count(evidence.counts.sharedKeys ?? 0), subject: count(evidence.counts.subject), candidate: count(evidence.counts.candidate) })}</li>}
    {evidence.contentMatchRatio !== undefined && <li>{t('history.evidence.content', { percent: percent(evidence.contentMatchRatio) })}</li>}
  </ul>;
}
