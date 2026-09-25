# 03 · Revision resolver

Status: draft for implementation. Packages: new `@ifc-lite/model-match`, `@ifc-lite/cli`, `apps/viewer`. Uses spec 01 for source mode and spec 02 for the resulting history.

## 1. Purpose

When a user opens or uploads an IFC file, find out whether it is a new version of a model the viewer or the source already knows, and ask the user to confirm.

The resolver works from cheap signals to expensive ones: file name first, then the IFC header, then element identity. Names only choose which candidates to examine. The decision rests on elements.

The resolver never decides alone. It produces a verdict with evidence, and the user chooses.

## 2. Where it runs

| Mode | Trigger | Candidates | Outcome of "yes" |
| --- | --- | --- | --- |
| Local | A file opened from disk, drag and drop, or recent files, while other models are loaded | Loaded federated models | Local lineage link, compare preset (§8.1) |
| Source | "Upload to source…" on a loaded model, or a file dropped on a project in the Sources panel | Models in the chosen project of a commit-aware source with `commits.write` | New commit on the chosen model (§8.2) |

The resolver runs **after** the file has loaded through the canonical `loadFile` path. It does not block loading and does not add a second ingest pipeline. The user sees the model while the question is on screen.

It does not run for models loaded from a commit (they are already identified), for cache restores of a file already tagged, or for models created in the viewer.

## 3. Package `@ifc-lite/model-match`

Pure TypeScript, no viewer or DOM dependencies, so the CLI and a server-side commit service can use the same logic.

- Dependencies: `@ifc-lite/diff` and `@ifc-lite/data` (`workspace:^`).
- Tests: vitest.
- Every module under ~400 lines.

```ts
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

export function normalizeModelName(fileName: string, naming?: NamingConfig): NormalizedName;
export function nameSimilarity(a: NormalizedName, b: NormalizedName): number;
export function headerSignalsFromStore(store: IfcStoreBase): HeaderSignals;
export function typeHistogramSimilarity(a: readonly EntityFingerprint[], b: readonly EntityFingerprint[]): number;
export function guidOverlap(a: readonly EntityFingerprint[], b: readonly EntityFingerprint[], excludeTypes?: readonly string[]): { overlap: number; jaccard: number; shared: number };
export function matchModels(subject: MatchSubject, candidates: readonly MatchCandidate[], options?: MatchOptions): Promise<MatchResult>;
export const DEFAULT_THRESHOLDS: MatchThresholds;
```

## 4. Stage 1: file name

### 4.1 Normalization

```ts
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
```

Steps, in order:

1. Drop any directory part.
2. Remove extensions: `.ifc`, `.ifczip`, `.ifcxml`, `.ifcx`, and double forms such as `.ifc.zip`.
3. Unicode NFKC, lowercase, trim.
4. Split into tokens on runs of space, `_`, `-`, `.` and brackets.
5. Try ISO 19650: seven or more hyphen-separated fields where the fields match the configured field lengths. When it parses, the comparison key is the first seven fields. Status and revision fields are recorded and removed.
6. Otherwise remove, from the end of the token list only, repeatedly:
   - copy markers: `(1)`, `(2)`, `copy`, `kopi`, `kopia`, plus `copyMarkers`
   - dates: `yyyymmdd`, `yyyy-mm-dd`, `ddmmyyyy`, `dd-mm-yyyy`, and `yymmdd` when it is a valid calendar date; optional `hhmm` or `hhmmss` after a date
   - revisions: `rev` or `revision` followed by a token of up to 3 characters; `r\d{1,3}`; `v\d{1,3}(\.\d+)*`; `version \d+`; `udgave \d+`; ISO revision codes `[pc]\d{2}(\.\d+)?`; plus `revisionPatterns`
7. The stem is the remaining tokens joined with `-`.

Removing only trailing tokens avoids stripping meaningful parts such as `level-02` in the middle of a name.

### 4.2 Similarity

- Both ISO 19650: `1.0` when the seven fields are equal, else `0.0`. A different container number is a different container.
- Stems equal: `1.0`.
- Otherwise the larger of token Jaccard and `1 - levenshtein(stemA, stemB) / max(len)`.

### 4.3 Test table

| Subject | Candidate | Expected stem equality | Removed from subject |
| --- | --- | --- | --- |
| `STR_Model_R03.ifc` | `STR_Model_R02.ifc` | equal | extension, `r03` |
| `ARK-Hovedmodel 2026-09-12.ifc` | `ARK-Hovedmodel 2026-08-30.ifc` | equal | extension, date |
| `Building A v2.1.ifc` | `Building A.ifc` | equal | extension, `v2.1` |
| `MEP model (1).ifc` | `MEP model.ifc` | equal | extension, copy |
| `PRJ-ORG-ZZ-02-M3-S-0001-S2-P03.ifc` | `PRJ-ORG-ZZ-02-M3-S-0001-S1-P02.ifc` | equal (ISO) | status, revision |
| `PRJ-ORG-ZZ-02-M3-S-0001-S2-P03.ifc` | `PRJ-ORG-ZZ-02-M3-S-0002-S2-P03.ifc` | different (ISO number) | status, revision |
| `level-02-slabs.ifc` | `level-03-slabs.ifc` | different | extension only |

### 4.4 Candidate selection

All candidates are scored by name. Candidates that go on to element stages, at most `maxElementCandidates` plus the project-GUID matches below:

- the top candidates by `nameScore` with `nameScore ≥ 0.5`
- every candidate whose `projectGlobalId` equals the subject's, up to 10, even with a low name score, because files are often renamed between deliveries

## 5. Stages 2 and 3: header and elements

### 5.1 Signals

| Signal | Definition |
| --- | --- |
| Digest | Equal `sha256:` digests of the original bytes. Checked first. |
| Project GUID | `IfcProject.GlobalId` equal. Strong, but shared by every model of one project. Never decisive alone. |
| Site or building GUID | Any `IfcSite` or `IfcBuilding` GlobalId in common. |
| Authoring tool | `originatingSystem` equal after removing version numbers. |
| Schema changed | Schema tokens differ, e.g. IFC2X3 to IFC4. Shown as a note; GlobalIds usually survive a re-export. |
| Type similarity | Cosine similarity of `log(1 + count)` per `ifcType`, over compared entities. Separates disciplines within one project. |
| GlobalId overlap | Shared keys divided by the smaller key set, over compared entities. Also Jaccard for reporting. |
| Content match ratio | When GlobalId overlap is below `contentMatchBelow`: run `diffModels(candidate, subject, { scope, matchUnpairedByContent: true })` and count subject elements paired by key or by a retiring content match, divided by the smaller set. Scope is `both` when both sides have geometry hashes, else `data`. |

Compared entities: `IfcProduct` subtypes with a key, excluding by default `IfcOpeningElement`, `IfcVirtualElement`, `IfcAnnotation`, `IfcGrid`, `IfcGridAxis`, and the spatial structure types (`IfcProject`, `IfcSite`, `IfcBuilding`, `IfcBuildingStorey`), which feed the header signals instead. `excludeTypes` overrides the list. The viewer passes the compare blacklist when one is set.

### 5.2 Verdict rules

Evaluated in order. First match wins.

```ts
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
```

1. **identical**: digests equal.
2. **unrelated, same project other model**: project GUID equal, type similarity below `otherModelTypeSimilarity`, and GlobalId overlap below 0.10. Reason `same-project-other-model`, shown as a note when this is the best candidate.
3. **likely-revision**: type similarity at least `minTypeSimilarity`, and either GlobalId overlap at least `likelyGuidOverlap` or content match ratio at least `likelyContentMatch`.
4. **possible-revision**: GlobalId overlap at least `possibleGuidOverlap`, or content match ratio at least `possibleContentMatch`, or name score at least `nameOnlyScore` together with an equal project GUID and type similarity at least 0.6.
5. **unrelated**: anything else.

Add `reguid-suspected` when GlobalId overlap is below 0.10 and content match ratio is at least `possibleContentMatch`. The exporter probably reassigned GlobalIds.

Score within a tier: `0.6 × max(guidOverlap, contentMatchRatio) + 0.25 × typeSimilarity + 0.15 × nameScore`. Missing signals count as 0.

The default thresholds are starting values. Calibrate them on a corpus of real consecutive deliveries before the first release and record the corpus results in the package README. Keep all thresholds configurable.

### 5.3 Partial evidence

When the time budget runs out or a candidate has no fingerprints, the result keeps the stages that finished, sets `evidence.partial`, and adds `evidence-partial`. A candidate without element evidence can reach at most `possible-revision`.

### 5.4 Size limits

- Subjects and candidates above 200,000 compared entities use a stratified sample of 20,000 per side for content matching. GlobalId overlap always uses every key.
- Source candidates are fetched with `loadCommitFingerprints({ maxEntries: 50000, dataOnly: true })` first. Geometry is requested only for the best candidate when its data-only verdict is `possible-revision` and the subject has geometry hashes.

## 6. When the user is asked

| Best verdict | Behaviour |
| --- | --- |
| `identical` | Toast: "This file is identical to <candidate>." Actions: "Keep both", "Close the new copy". No dialog. |
| `likely-revision` or `possible-revision` | Dialog (§7). |
| `unrelated`, or no candidates | No dialog. Toast: "Opened as a new model." Action: "Link to an existing model…", which opens the dialog with every candidate listed and no pre-selection. |

A viewer setting "Ask when an opened file may be a new version" is on by default. Turning it off keeps only the toast. There is no automatic acceptance in v1.

## 7. Dialog

Built with the existing `components/ui/dialog.tsx`. Non-modal to the 3D view: the user can orbit the new model while deciding.

```
┌ Is this a new version of an existing model? ────────────────┐
│ You opened  STR_Model_R03.ifc                                │
│                                                              │
│ ◉ New version of  STR_Model_R02.ifc          Likely          │
│     ✓ Same file name after removing "R03"                    │
│     ✓ Same IFC project                                       │
│     ✓ 78% of elements share their GlobalId (12,340 of 15,820)│
│     ✓ Exported from the same application                     │
│ ○ New version of another model…   [ ARK_Model_R02.ifc ▾ ]    │
│ ○ This is a different model                                  │
│                                                              │
│ ☑ Hide the previous version                                  │
│ ☑ Show what changed                                          │
│                                  [ Decide later ]  [ Confirm ]│
└──────────────────────────────────────────────────────────────┘
```

- The best candidate is pre-selected only for `likely-revision`. For `possible-revision` nothing is pre-selected, and the evidence list shows first so the user reads it before choosing.
- Evidence lines are rendered from `reasons` with `t('resolver.reason.<code>', params)`. Numbers use `intlFormat`.
- A `reguid-suspected` line reads: "Only 3% of elements share their GlobalId, but 91% match by content. The exporting tool probably reassigned GlobalIds."
- A `schema-changed` line reads: "The schema changed from IFC2X3 to IFC4."
- A `same-project-other-model` note reads: "Same project, but the content looks like a different model, for example another discipline."
- "Decide later" leaves the model loaded with an "Unresolved" badge on its hierarchy row. The badge action "Resolve…" reopens the dialog with the stored result.
- Escape and the close button mean "Decide later".

### 7.1 Several files at once

When several files are opened together, one dialog lists them as rows:

| Opened file | Suggested match | Verdict | Choice |
| --- | --- | --- | --- |
| `STR_Model_R03.ifc` | `STR_Model_R02.ifc` | Likely | [New version of… ▾] |
| `MEP_Model_R07.ifc` | `MEP_Model_R06.ifc` | Possible | [Choose ▾] |
| `Site_survey.ifc` | none | | [Different model ▾] |

Expanding a row shows its evidence. "Confirm all" applies the choices. Two opened files cannot both be chosen as a new version of the same candidate; the second row shows an inline error.

## 8. Outcomes

### 8.1 Local mode

Confirming "New version of X":

1. `setLocalLineage(newModelId, { baseModelId: X, decidedAt, evidence })` in `historySlice`.
2. Hierarchy row badge: "New version of X".
3. If "Hide the previous version" is checked, X is hidden, not removed.
4. If "Show what changed" is checked, compare base is X, head is the new model, and `runComparison` starts. Content matches found by the resolver are shown as suggestions in the compare panel. They are not accepted automatically: element identity still goes through the compare panel's accept flow.
5. The History panel shows local versions for models linked this way (spec 02 §4.3).

Confirming "Different model" records nothing. "Decide later" records the pending state in a small `resolverPending: Map<modelId, MatchResult>` inside `historySlice`, cleared on model removal.

### 8.2 Source mode

1. The user chooses "Upload to source…" on a loaded model, picks a commit-aware source and project, or drops a file onto a project in the Sources panel. Upload requires `commits.write`.
2. Candidates are the project's models. Subject fingerprints come from the loaded model through `buildEntityFingerprints`. Candidate fingerprints come from `loadCommitFingerprints` on each candidate's head. No candidate payload is downloaded.
3. The dialog adds a "Message" field, default `"Upload <file name>"`.
4. On confirm:
   - **New version of X:** `createCommit({ modelId: X, expectedParentId: <head evaluated>, bytes, message, idempotencyKey, resolution })`.
   - **Different model:** `createModel({ name: <stem>, … })`, then `createCommit({ expectedParentId: null, … })`.
   - `resolution` is a `RevisionResolutionRecord` with the verdict, the evidence numbers and the resolver version.
5. On `conflict`, fetch the new head's fingerprints, rerun the match for that candidate and ask again only if the verdict changed. Otherwise retry once with the new head.
6. On success, set a commit tag on the loaded model (spec 02 §5), so it becomes the head commit in the History panel.
7. Upload progress uses the `onProgress` callback. Aborting the dialog aborts the upload.

## 9. Viewer integration

| File | Contents |
| --- | --- |
| `hooks/resolver/useRevisionResolver.ts` | Queue of newly loaded model ids, fingerprint building, calls `matchModels`, opens dialog or toast |
| `hooks/resolver/useSourceUpload.ts` | Source mode: candidates, fingerprints, `createModel`, `createCommit`, conflict retry |
| `lib/resolver/subjectFromModel.ts` | Builds `MatchSubject` from a `FederatedModel`: `modelDigest`, `headerSignalsFromStore`, `buildEntityFingerprints` |
| `components/viewer/resolver/RevisionResolverDialog.tsx` | Single-file dialog |
| `components/viewer/resolver/RevisionResolverBatch.tsx` | Multi-file table |
| `components/viewer/resolver/EvidenceList.tsx` | Reason lines |
| `i18n/catalogues/resolver.en.ts` | Strings |

Hook point: after a successful `loadFile` for files routed through `usePreparedModelFileRoute` / `routeLoad` in `ViewportContainer.tsx` and `useFileCommands.tsx`, push the new model id onto the resolver queue. Loads from the source bridge with a `commit` tag, and collab room models, are skipped.

Fingerprints: run `buildEntityFingerprints` once data parsing finishes. If geometry hashes arrive later from the mesh pass, the resolver reruns only when the first result was `possible-revision` and the dialog is still open, then updates the evidence in place.

Digest: use `modelDigest(model)` from `lib/compare/identitySidecar.ts`. It is `null` for cache-restored models without bytes; the digest stage is then skipped.

## 10. CLI

```
ifc-lite match <file> <candidate>... [--geometry] [--json] [--no-content] [--exclude-types T,...] [--threshold name=value ...]
```

- Parses every file, builds fingerprints with the geometry pass when `--geometry` is given, and prints one line per candidate: verdict, score and reasons.
- `--json` prints the `MatchResult`.
- Exit code 0 always. Scripts read the verdict from JSON.

## 11. Privacy

- File names, stems and evidence stay in the browser in local mode.
- Telemetry: `resolver_prompted` with `{ verdict, fileCount }`, `resolver_decided` with `{ decision, verdict }`. No names, digests or numbers that could identify a model.
- In source mode the resolution record is sent to the source as part of the commit.

## 12. Tests

`@ifc-lite/model-match`, vitest:

1. Name normalization: the table in §4.3, plus trailing-only removal and configured patterns.
2. Name similarity: ISO equal and unequal containers; Levenshtein fallback.
3. Type similarity: identical histograms give 1; disjoint give 0.
4. Verdicts with synthetic fingerprint sets:
   - identical bytes
   - revision with 10% of elements changed and 5% added
   - full re-GUID with unchanged content, which must give `likely-revision` with `reguid-suspected`
   - sibling discipline in the same project, which must give `unrelated` with `same-project-other-model`
   - a model split into two files, where each half gives `likely-revision` against the whole
   - schema re-export with GlobalIds kept
5. Time budget: an aborted content stage gives `evidence.partial` and at most `possible-revision`.

Viewer, `node:test` with happy-dom:

6. Opening a second file whose name and elements match a loaded model shows the dialog with the right pre-selection.
7. Confirm in local mode sets the lineage link, hides the old model and starts compare.
8. An identical file shows the toast, not the dialog.
9. Batch dialog refuses two files mapped to one candidate.
10. Source mode: confirm calls `createCommit` with the evaluated head; a fixture `conflict` triggers one re-evaluation.

Fixtures from `tests/models/` must be skipped when absent, following the repository rule.

## 13. Open questions

1. Should the resolver also compare against recently closed files, using fingerprints cached by digest, so a file opened next week still finds last week's version?
2. Should confirmed local lineage be exportable as a sidecar so it survives reloads without a source?
3. Which ISO 19650 field lengths and separators should the default naming config assume, given national variations?
