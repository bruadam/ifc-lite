/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export { normalizeModelName, nameSimilarity } from './names.js';
export { headerSignalsFromStore, typeHistogramSimilarity, guidOverlap } from './signals.js';
export { matchModels, DEFAULT_THRESHOLDS } from './match.js';
export type { HeaderSignals, MatchSubject, MatchCandidate, MatchResult, MatchOptions, MatchThresholds, CandidateResult, CandidateEvidence, Verdict, ReasonCode, NamingConfig, NormalizedName } from './types.js';
