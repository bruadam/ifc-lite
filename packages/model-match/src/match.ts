/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { diffModels } from '@ifc-lite/diff';
import { nameSimilarity, normalizeModelName } from './names.js';
import { compared, guidOverlap, sample, typeHistogramSimilarity } from './signals.js';
import type { CandidateEvidence, CandidateResult, MatchCandidate, MatchOptions, MatchResult, MatchSubject, MatchThresholds, ReasonCode, Verdict } from './types.js';

export const DEFAULT_THRESHOLDS: MatchThresholds = { likelyGuidOverlap: .6, possibleGuidOverlap: .25, likelyContentMatch: .7, possibleContentMatch: .4, minTypeSimilarity: .8, contentMatchBelow: .5, nameOnlyScore: .85, otherModelTypeSimilarity: .5 };

export async function matchModels(subject: MatchSubject, candidates: readonly MatchCandidate[], options: MatchOptions = {}): Promise<MatchResult> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  for (const [key, value] of Object.entries(thresholds)) if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid threshold ${key}: expected 0..1`);
  const started = performance.now();
  const budget = options.timeBudgetMs ?? 2000;
  if (!Number.isFinite(budget) || budget < 0) throw new Error('timeBudgetMs must be non-negative');
  const name = normalizeModelName(subject.fileName, options.naming);
  const ranked = candidates.map(candidate => {
    const normalized = normalizeModelName(candidate.fileName, options.naming);
    return { candidate, normalized, nameScore: nameSimilarity(name, normalized) };
  }).sort((a, b) => b.nameScore - a.nameScore || a.candidate.id.localeCompare(b.candidate.id));
  const selected = new Set(ranked.filter(c => c.nameScore >= .5).slice(0, options.maxElementCandidates ?? 5).map(c => c.candidate.id));
  ranked.filter(c => subject.header?.projectGlobalId && subject.header.projectGlobalId === c.candidate.header?.projectGlobalId).slice(0, 10).forEach(c => selected.add(c.candidate.id));
  const results: CandidateResult[] = [];
  for (const { candidate, normalized, nameScore } of ranked) {
    // Yield between candidates so cancellation from a UI event can be observed.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const reasons: ReasonCode[] = [];
    const projectGuidMatch = !!subject.header?.projectGlobalId && subject.header.projectGlobalId === candidate.header?.projectGlobalId;
    const spatial = [...(subject.header?.siteGlobalIds ?? []), ...(subject.header?.buildingGlobalIds ?? [])];
    const otherSpatial = new Set([...(candidate.header?.siteGlobalIds ?? []), ...(candidate.header?.buildingGlobalIds ?? [])]);
    const tool = (value?: string) => value?.toLowerCase().replace(/\d+(?:\.\d+)*/g, '').trim();
    const sameAuthoringTool = !!tool(subject.header?.originatingSystem) && tool(subject.header?.originatingSystem) === tool(candidate.header?.originatingSystem);
    const digestMatch = !!subject.digest && subject.digest.startsWith('sha256:') && subject.digest === candidate.digest;
    const a = compared(subject.fingerprints ?? [], options.excludeTypes ? [...options.excludeTypes] : undefined);
    const b = compared(candidate.fingerprints ?? [], options.excludeTypes ? [...options.excludeTypes] : undefined);
    let partial = !!subject.sampled || !!candidate.sampled || subject.fingerprints === null || candidate.fingerprints === null;
    let overlap: ReturnType<typeof guidOverlap> | undefined, similarity: number | undefined, contentRatio: number | undefined;
    if (selected.has(candidate.id) && !options.signal?.aborted && performance.now() - started < budget && subject.fingerprints !== null && candidate.fingerprints !== null) {
      overlap = guidOverlap(a, b, []);
      similarity = typeHistogramSimilarity(a, b);
      if (options.contentMatch !== false && overlap.overlap < thresholds.contentMatchBelow && a.length && b.length) {
        const sampled = Math.max(a.length, b.length) > 200_000;
        const sa = sampled ? sample(a, 20_000) : a, sb = sampled ? sample(b, 20_000) : b;
        const scope = sa.some(e => e.geometryHash !== undefined) && sb.some(e => e.geometryHash !== undefined) ? 'both' : 'data';
        const diff = diffModels(sb, sa, { scope, matchUnpairedByContent: true });
        contentRatio = (diff.entries.filter(e => e.base && e.head).length + (diff.contentMatches ?? []).filter(m => ['renamed', 'moved', 'reshaped', 'respecified'].includes(m.kind)).reduce((n, m) => n + m.head.length, 0)) / (Math.min(sa.length, sb.length) || 1);
        partial ||= sampled;
      }
      partial ||= !!options.signal?.aborted || performance.now() - started >= budget;
    } else partial = true;
    if (digestMatch) reasons.push('digest-equal');
    if (nameScore === 1) reasons.push(name.iso19650 && normalized.iso19650 ? 'iso19650-same-container' : 'name-stem-equal');
    else if (nameScore >= .5) reasons.push('name-similar');
    if (projectGuidMatch) reasons.push('project-guid-equal');
    const siteOrBuildingGuidMatch = spatial.some(k => otherSpatial.has(k));
    if (siteOrBuildingGuidMatch) reasons.push('site-or-building-guid-equal');
    if (sameAuthoringTool) reasons.push('same-authoring-tool');
    if (subject.header && candidate.header && subject.header.schema !== candidate.header.schema) reasons.push('schema-changed');
    const g = overlap?.overlap ?? 0, c = contentRatio ?? 0, t = similarity ?? 0;
    if (g >= thresholds.likelyGuidOverlap) reasons.push('guid-overlap-high');
    else if (g >= thresholds.possibleGuidOverlap) reasons.push('guid-overlap-partial');
    if (c >= thresholds.likelyContentMatch) reasons.push('content-match-high');
    else if (c >= thresholds.possibleContentMatch) reasons.push('content-match-partial');
    if (g < .1 && c >= thresholds.possibleContentMatch) reasons.push('reguid-suspected');
    let verdict: Verdict = 'unrelated';
    if (digestMatch) verdict = 'identical';
    else if (projectGuidMatch && similarity !== undefined && t < thresholds.otherModelTypeSimilarity && g < .1) reasons.push('same-project-other-model');
    else if (!partial && t >= thresholds.minTypeSimilarity && (g >= thresholds.likelyGuidOverlap || c >= thresholds.likelyContentMatch)) verdict = 'likely-revision';
    else if (g >= thresholds.possibleGuidOverlap || c >= thresholds.possibleContentMatch || (nameScore >= thresholds.nameOnlyScore && projectGuidMatch && (similarity === undefined || t >= .6))) verdict = 'possible-revision';
    if (partial) reasons.push('evidence-partial');
    const evidence: CandidateEvidence = { digestMatch, nameScore, nameStems: { subject: name.stem, candidate: normalized.stem }, removedTokens: name.removed.map(r => r.text), projectGuidMatch, siteOrBuildingGuidMatch, sameAuthoringTool, typeSimilarity: similarity, guidOverlap: overlap?.overlap, guidJaccard: overlap?.jaccard, contentMatchRatio: contentRatio, counts: { subject: a.length, candidate: b.length, sharedKeys: overlap?.shared, contentMatched: contentRatio === undefined ? undefined : Math.round(contentRatio * Math.min(a.length, b.length)) }, partial };
    results.push({ candidateId: candidate.id, verdict, score: .6 * Math.max(g, c) + .25 * t + .15 * nameScore, reasons, evidence });
  }
  const tier = { identical: 0, 'likely-revision': 1, 'possible-revision': 2, unrelated: 3 };
  results.sort((a, b) => tier[a.verdict] - tier[b.verdict] || b.score - a.score || a.candidateId.localeCompare(b.candidateId));
  return { subjectId: subject.id, results, resolver: '@ifc-lite/model-match@0.1.0' };
}
