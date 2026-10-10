/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityFingerprint } from '@ifc-lite/diff';

export interface HeaderSignals {
  readonly schema: string;                 // FILE_SCHEMA token, e.g. 'IFC4'
  readonly originatingSystem?: string;
  readonly preprocessorVersion?: string;
  readonly organization: readonly string[];
  readonly author: readonly string[];
  readonly projectGlobalId?: string;
  readonly siteGlobalIds: readonly string[];
  readonly buildingGlobalIds: readonly string[];
}

export interface MatchSubject {
  readonly id: string;
  readonly label: string;
  /** File name as delivered, including extension. */
  readonly fileName: string;
  /** `sha256:<hex>` of the original bytes, when known. */
  readonly digest?: string;
  readonly header?: HeaderSignals;
  /** Null when not available yet; element stages are then skipped for this subject. */
  readonly fingerprints: readonly EntityFingerprint[] | null;
  /** True when `fingerprints` is a sample. */
  readonly sampled?: boolean;
}

export interface MatchCandidate extends MatchSubject {
  readonly origin: 'loaded' | 'source';
}

export type Verdict = 'identical' | 'likely-revision' | 'possible-revision' | 'unrelated';

export type ReasonCode =
  | 'digest-equal'
  | 'name-stem-equal'
  | 'name-similar'
  | 'iso19650-same-container'
  | 'project-guid-equal'
  | 'site-or-building-guid-equal'
  | 'same-authoring-tool'
  | 'guid-overlap-high'
  | 'guid-overlap-partial'
  | 'content-match-high'
  | 'content-match-partial'
  | 'reguid-suspected'
  | 'schema-changed'
  | 'same-project-other-model'
  | 'evidence-partial';

export interface CandidateEvidence {
  readonly digestMatch: boolean;
  readonly nameScore: number;              // 0..1
  readonly nameStems: { readonly subject: string; readonly candidate: string };
  readonly removedTokens: readonly string[];
  readonly projectGuidMatch: boolean;
  readonly siteOrBuildingGuidMatch: boolean;
  readonly sameAuthoringTool: boolean;
  readonly typeSimilarity?: number;        // 0..1
  readonly guidOverlap?: number;           // 0..1, over the smaller set
  readonly guidJaccard?: number;           // 0..1
  readonly contentMatchRatio?: number;     // 0..1, over the smaller set
  readonly counts: { readonly subject: number; readonly candidate: number; readonly sharedKeys?: number; readonly contentMatched?: number };
  readonly partial: boolean;
}

export interface CandidateResult {
  readonly candidateId: string;
  readonly verdict: Verdict;
  /** Ordering score within a verdict tier. Not a probability. */
  readonly score: number;
  readonly reasons: readonly ReasonCode[];
  readonly evidence: CandidateEvidence;
}

export interface MatchResult {
  readonly subjectId: string;
  /** Sorted: verdict tier, then score. */
  readonly results: readonly CandidateResult[];
  /** e.g. `@ifc-lite/model-match@0.1.0`. */
  readonly resolver: string;
}

export interface MatchOptions {
  readonly naming?: NamingConfig;
  readonly thresholds?: Partial<MatchThresholds>;
  /** IFC types left out of element comparison. Default in §5.1. */
  readonly excludeTypes?: readonly string[];
  /** Candidates that proceed to element stages after the name stage. Default 5. */
  readonly maxElementCandidates?: number;
  /** Run content matching when GlobalId overlap is low. Default true. */
  readonly contentMatch?: boolean;
  /** Stop expensive stages after this many ms and mark evidence partial. Default 2000. */
  readonly timeBudgetMs?: number;
  readonly signal?: AbortSignal;
}


export interface NormalizedName {
  /** Comparison stem: lowercase, separators unified, revision/date/copy tokens removed. */
  readonly stem: string;
  readonly tokens: readonly string[];
  readonly removed: readonly { readonly kind: 'extension' | 'copy' | 'date' | 'revision' | 'status'; readonly text: string }[];
  /** Present when the name parses as an ISO 19650 container name. */
  readonly iso19650?: {
    readonly project: string; readonly originator: string; readonly volume: string;
    readonly level: string; readonly type: string; readonly role: string; readonly number: string;
    readonly status?: string; readonly revision?: string;
  };
}

export interface NamingConfig {
  /** Extra regex sources for revision tokens, matched case-insensitively against whole tokens. */
  readonly revisionPatterns?: readonly string[];
  /** Extra copy markers, e.g. localized words for "copy". */
  readonly copyMarkers?: readonly string[];
  /** Parse ISO 19650 names. Default true. */
  readonly iso19650?: boolean;
}

export interface MatchThresholds {
  likelyGuidOverlap: number;       // 0.60
  possibleGuidOverlap: number;     // 0.25
  likelyContentMatch: number;      // 0.70
  possibleContentMatch: number;    // 0.40
  minTypeSimilarity: number;       // 0.80
  contentMatchBelow: number;       // 0.50: run content matching when GUID overlap is below this
  nameOnlyScore: number;           // 0.85
  otherModelTypeSimilarity: number;// 0.50
}
