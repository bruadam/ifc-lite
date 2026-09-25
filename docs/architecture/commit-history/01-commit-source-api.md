# 01 · Commit-aware source API

Status: draft for implementation. Package: `@ifc-lite/plugin-api` (types), `@ifc-lite/source-fixture` (oracle), `@ifc-lite/source-commit-http` (generic provider).

## 1. Purpose

Today a `FileSourceProvider` exposes files, and optionally a flat, newest-first list of revisions for one file (`listRevisions`). The viewer never calls `listRevisions`; it only downloads the latest bytes and watches for new revisions.

This spec lets a provider describe **models as a history of immutable commits**, and lets a host:

- list models and their commits, with parents, author, message and time
- load the payload of any commit
- read a commit's element fingerprints without loading its payload
- read a stored diff between two commits
- read the history of one element across commits
- read and write reviewed identity records between two commits
- create models and commits, for uploads resolved by spec 03
- watch model heads for new commits

## 2. Relationship to the existing contract

| Existing (2.0.0) | Commit-aware (2.1.0) |
| --- | --- |
| `SourceFile` with `currentRevisionId` | `SourceModel` with `headCommitId`. A model may be backed by one source file or by none. |
| `SourceRevision` (id, label, createdAt, createdBy, sizeBytes) | `SourceCommit` adds `parents`, `message`, `artifact` digest, `status`, optional `stats` and a link back to the file revision it came from. |
| `listRevisions` per file | `listCommits` per model |
| `download(ref)` returns `ArrayBuffer` | `loadCommit(ref)` returns a typed `CommitPayload` |
| Identity sidecars pinned to raw file digests | Identity records pinned to commit artifact digests, which are the same `sha256:` digests |
| `watchRevisions` | `watchCommits` |

A provider may implement both. The host prefers the commit API when `capabilities.commits` is present.

**Revision-only providers.** Providers with `revisionHistory: true` but no commit API get a host-side adapter, `revisionsAsCommits` (§8), that presents their revisions as a linear commit chain. This gives the History UI something useful for Dropbox and Microsoft Graph sources with no provider changes.

## 3. Versioning

- `PLUGIN_API_VERSION` becomes `'2.1.0'`. All additions are optional members, so `^2.0.0` providers still register.
- Commit-aware providers declare `api: '^2.1.0'`.
- Add a changeset: minor bump for `@ifc-lite/plugin-api`.
- Update `scripts/api-surface.json` with `pnpm api-surface:update`.

## 4. Concepts and invariants

- **Model.** A named, versioned IFC model inside a project, such as one discipline's model. Stable opaque `id`.
- **Commit.** An immutable version of a model. Opaque `id`, unique within the provider. A commit never changes after creation.
- **Parents.** `parents[0]` is the mainline parent. The first commit has `parents: []`. More than one parent means a merge commit. v1 hosts render only the mainline and show merges as a marker.
- **Head.** The newest mainline commit of a model. `SourceModel.headCommitId` is empty only for a model with no commits.
- **Artifact.** The original file bytes the commit was created from. `artifact.digest` is `sha256:<hex>` over those exact bytes, the same algorithm and format as `ModelIdentity.hash` in `@ifc-lite/diff`. Existing identity and lineage sidecars therefore pin to commits with no format change.
- **Key.** Element identity across commits is the IFC `GlobalId`, unless a `keyProperty` is used, with the same meaning as in the diff engine (`Tag` or `Pset.Property`).
- **Status.** `published` commits are visible to all users of the model. `pending` and `rejected` are visible only to users the provider authorizes. The host shows non-published commits with a badge and never selects them as head.

## 5. Capability declaration

Add one optional object to `ProviderCapabilities`. Its presence marks the provider as commit-aware.

```ts
export type CommitPayloadFormat = 'ifc-step' | 'ifc-zip' | 'ifcx' | 'ifc-lite-cache';

export interface CommitCapabilities {
  /** Formats `loadCommit` can return, in the provider's order of preference. */
  readonly payloadFormats: readonly CommitPayloadFormat[];
  /** Provider implements `loadCommitFingerprints`. */
  readonly fingerprints: boolean;
  /** Provider implements `getCommitDiff`. */
  readonly storedDiffs: boolean;
  /** Provider implements `listElementHistory`. */
  readonly elementHistory: boolean;
  /** Provider implements `listIdentityRecords`. */
  readonly identityRecords: boolean;
  /** Provider implements `createModel`, `createCommit` and `recordIdentity`. */
  readonly write: boolean;
  /** Provider implements `watchCommits`. */
  readonly watch: boolean;
}

export interface ProviderCapabilities {
  // ...existing fields unchanged
  /** Present only on commit-aware providers. */
  readonly commits?: CommitCapabilities;
}
```

Rules:

- If `commits` is present, `listModels`, `getModel`, `listCommits`, `getCommit` and `loadCommit` are required.
- Every other commit method is present exactly when its flag is `true`. The fixture enforces this, as it already does for `listRevisions`.
- v1 hosts accept `ifc-step`, `ifc-zip` and `ifcx`. `ifc-lite-cache` is reserved (§9).

## 6. Types

All types are dependency-free and `readonly`, following the existing file. Fingerprint and diff types are structurally compatible with `@ifc-lite/diff` but defined here, because plugin-api has no dependencies.

```ts
export interface ModelRef {
  readonly projectId: string;
  readonly modelId: string;
}

export interface CommitRef extends ModelRef {
  readonly commitId: string;
}

export interface SourceModel {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  /** Container the model is filed under, when the provider has containers. */
  readonly containerId?: string;
  /** Controlled discipline code, when the provider classifies models. */
  readonly discipline?: string;
  readonly headCommitId: string;
  readonly commitCount?: number;
  readonly updatedAt?: string;
  readonly meta?: Record<string, unknown>;
}

export interface CommitArtifact {
  /** `sha256:<hex>` over the original file bytes. */
  readonly digest: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  /** Schema token from FILE_SCHEMA, e.g. `IFC4X3_ADD2`. */
  readonly schema?: string;
}

export interface CommitStats {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly unchanged: number;
}

export type CommitStatus = 'published' | 'pending' | 'rejected';

export interface SourceCommit {
  readonly id: string;
  readonly modelId: string;
  readonly projectId: string;
  /** `parents[0]` is the mainline parent. Empty for the first commit. */
  readonly parents: readonly string[];
  readonly createdAt: string;
  readonly author?: SourceIdentity;
  readonly message?: string;
  readonly status: CommitStatus;
  readonly artifact: CommitArtifact;
  /** Change counts against `parents[0]`, when the provider has computed them. */
  readonly stats?: CommitStats;
  /** Where the artifact came from, when it was synced from a file source. */
  readonly origin?: {
    readonly provider?: string;
    readonly fileId?: string;
    readonly revisionId?: string;
  };
  readonly meta?: Record<string, unknown>;
}

export interface ListCommitsOptions extends ListOptions {
  /** Only commits created before this ISO timestamp. */
  readonly before?: string;
  /** Only commits created after this ISO timestamp. */
  readonly after?: string;
  /** Include `pending` and `rejected` commits the caller may see. Default false. */
  readonly includeUnpublished?: boolean;
}

export interface LoadCommitOptions extends DownloadOptions {
  /** Acceptable formats in the host's order of preference. */
  readonly accept?: readonly CommitPayloadFormat[];
}

export interface CommitPayload {
  readonly format: CommitPayloadFormat;
  /** File name the host should give the bytes, including extension. */
  readonly fileName: string;
  readonly bytes: ArrayBuffer;
  /** Digest of the commit's original artifact, equal to `SourceCommit.artifact.digest`. */
  readonly artifactDigest: string;
}

/** Structurally compatible with `EntityFingerprint` from `@ifc-lite/diff`, minus `ref`. */
export interface SourceFingerprint {
  readonly key: string;
  readonly ifcType: string;
  readonly dataHash: string;
  /** Hex string of the 64-bit geometry hash, or a `p:` placement string for geometry-less products. */
  readonly geometryHash?: string;
  readonly aabb?: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] };
  readonly volume?: number;
  readonly components?: Readonly<Record<string, string>>;
  readonly container?: string;
}

export interface CommitFingerprintSet {
  readonly format: 'ifc-lite/fingerprints';
  readonly version: 1;
  readonly commit: CommitRef;
  readonly artifactDigest: string;
  /** Absent means GlobalId keys. */
  readonly keyProperty?: string;
  /** Producer, e.g. `@ifc-lite/diff@0.10.0`, so hosts can refuse incompatible hashes. */
  readonly engine: string;
  readonly entries: readonly SourceFingerprint[];
  /** Present when the set is a sample rather than every element. */
  readonly sample?: { readonly total: number; readonly strategy: 'stratified-by-type' };
}

export interface LoadFingerprintsOptions {
  readonly keyProperty?: string;
  /** Upper bound on entries. The provider samples stratified by IFC type above it. */
  readonly maxEntries?: number;
  /** Omit geometry fields to reduce size. */
  readonly dataOnly?: boolean;
  readonly signal?: AbortSignal;
}

export type StoredDiffState = 'added' | 'modified' | 'deleted';
export type StoredChangeKind = 'data' | 'geometry' | 'container';

export interface StoredDiffEntry {
  /** Key in the head commit. For `deleted`, the key in the base commit. */
  readonly key: string;
  /** Base key when an identity record re-keyed the element. */
  readonly baseKey?: string;
  readonly ifcType: string;
  readonly state: StoredDiffState;
  readonly changeKinds: readonly StoredChangeKind[];
  /** Component keys as in `@ifc-lite/diff`, e.g. `attr:core`, `pset:Pset_WallCommon`. */
  readonly changedComponents?: readonly string[];
}

export interface IdentityEntryLike {
  readonly base: string;
  readonly here: string;
  /** Same reason vocabulary as identity sidecars, e.g. `content-match:renamed`. */
  readonly reason: string;
}

export interface StoredCommitDiff {
  readonly format: 'ifc-lite/commit-diff';
  readonly version: 1;
  readonly base: CommitRef;
  readonly head: CommitRef;
  readonly engine: string;
  readonly options: {
    readonly scope: 'data' | 'geometry' | 'both';
    readonly matchUnpairedByContent: boolean;
    readonly keyProperty?: string;
  };
  readonly counts: CommitStats;
  /** Unchanged elements are omitted. */
  readonly entries: readonly StoredDiffEntry[];
  /** Identity entries that were applied as key aliases for this diff. */
  readonly appliedIdentity: readonly IdentityEntryLike[];
}

export type ElementHistoryState =
  | 'added' | 'modified' | 'deleted' | 'renamed' | 'split' | 'merged' | 'replaced';

export interface ElementHistoryQuery extends ModelRef {
  /** Key of the element in `atCommitId` (default: head). */
  readonly key: string;
  readonly keyProperty?: string;
  readonly atCommitId?: string;
}

export interface ElementHistoryEntry {
  readonly commitId: string;
  readonly createdAt: string;
  /** The element's key in this commit. Differs from the query key after a rename. */
  readonly key: string;
  readonly state: ElementHistoryState;
  readonly changeKinds: readonly StoredChangeKind[];
  readonly changedComponents?: readonly string[];
  /** Other keys involved: the old key after `renamed`, pieces after `split`, sources after `merged`. */
  readonly relatedKeys?: readonly string[];
  readonly reason?: string;
}

export interface IdentityRecordSet {
  readonly base: CommitRef & { readonly artifactDigest: string };
  readonly head: CommitRef & { readonly artifactDigest: string };
  readonly keyProperty?: string;
  readonly entries: readonly (IdentityEntryLike & {
    readonly reviewedBy?: string;
    readonly reviewedAt?: string;
  })[];
}

export interface CreateModelInput {
  readonly projectId: string;
  readonly name: string;
  readonly containerId?: string;
  readonly discipline?: string;
  readonly meta?: Record<string, unknown>;
}

export type RevisionDecision = 'revision-of' | 'new-model';

/** Written by the revision resolver (spec 03). Opaque to the provider except for storage. */
export interface RevisionResolutionRecord {
  readonly decision: RevisionDecision;
  readonly candidateModelId?: string;
  readonly candidateCommitId?: string;
  /** Resolver package and version, e.g. `@ifc-lite/model-match@0.1.0`. */
  readonly resolver: string;
  readonly verdict: string;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly decidedAt: string;
}

export interface CreateCommitInput {
  readonly projectId: string;
  readonly modelId: string;
  /** Head the caller evaluated against. `null` for the first commit of a new model. */
  readonly expectedParentId: string | null;
  readonly fileName: string;
  readonly bytes: ArrayBuffer;
  readonly message?: string;
  /** Client-generated UUID. Repeating a call with the same key returns the same commit. */
  readonly idempotencyKey: string;
  readonly resolution?: RevisionResolutionRecord;
  /** Reviewed element identity against `expectedParentId`, if any. */
  readonly identity?: readonly IdentityEntryLike[];
  readonly signal?: AbortSignal;
  readonly onProgress?: (sent: number, total?: number) => void;
}

export interface CommitEvent {
  readonly modelId: string;
  readonly headCommitId: string;
  readonly previousHeadCommitId?: string;
  readonly deleted?: boolean;
}

export interface CommitWatchResult {
  readonly events: readonly CommitEvent[];
  readonly cursor?: string;
}
```

## 7. Methods

Added to `FileSourceProvider` as optional members.

```ts
export interface FileSourceProvider {
  // ...existing members unchanged

  listModels?(ctx: PluginContext, projectId: string, options?: ListOptions & { readonly query?: string }): Promise<Page<SourceModel>>;
  getModel?(ctx: PluginContext, ref: ModelRef): Promise<SourceModel>;
  listCommits?(ctx: PluginContext, ref: ModelRef, options?: ListCommitsOptions): Promise<Page<SourceCommit>>;
  getCommit?(ctx: PluginContext, ref: CommitRef): Promise<SourceCommit>;
  loadCommit?(ctx: PluginContext, ref: CommitRef, options?: LoadCommitOptions): Promise<CommitPayload>;

  loadCommitFingerprints?(ctx: PluginContext, ref: CommitRef, options?: LoadFingerprintsOptions): Promise<CommitFingerprintSet>;
  getCommitDiff?(ctx: PluginContext, base: CommitRef, head: CommitRef, options?: { readonly keyProperty?: string; readonly signal?: AbortSignal }): Promise<StoredCommitDiff>;
  listElementHistory?(ctx: PluginContext, query: ElementHistoryQuery, options?: ListOptions): Promise<Page<ElementHistoryEntry>>;
  listIdentityRecords?(ctx: PluginContext, base: CommitRef, head: CommitRef): Promise<IdentityRecordSet>;

  createModel?(ctx: PluginContext, input: CreateModelInput): Promise<SourceModel>;
  createCommit?(ctx: PluginContext, input: CreateCommitInput): Promise<SourceCommit>;
  recordIdentity?(ctx: PluginContext, base: CommitRef, head: CommitRef, entries: readonly IdentityEntryLike[]): Promise<IdentityRecordSet>;

  watchCommits?(ctx: PluginContext, models: readonly ModelRef[], cursor?: string, options?: ListOptions): Promise<CommitWatchResult>;
}
```

### 7.1 Semantics

| Method | Rules |
| --- | --- |
| `listModels` | Paged. Order: most recently updated first. `query` is a case-insensitive name filter. |
| `listCommits` | Paged, newest first by `createdAt`, ties broken by commit id. Returns mainline and merge commits. Published only unless `includeUnpublished`. |
| `loadCommit` | Returns the first format in `accept` the provider can serve. Throws `unsupported-format` when none match. `artifactDigest` must equal the commit's artifact digest. |
| `loadCommitFingerprints` | Fingerprints of the commit's elements, computed with the engine named in `engine`. Hosts refuse sets whose engine major version differs from their own `@ifc-lite/diff`. Sampling is allowed only when `maxEntries` is set and exceeded. |
| `getCommitDiff` | Any two commits of the same model, not only adjacent ones. May throw `not-ready` with `retryAfterMs` while the provider computes it. `counts` exclude nothing; `entries` exclude unchanged elements. |
| `listElementHistory` | Newest first. Follows the element through identity and lineage records, so a renamed element keeps one history. Stops at `added`. |
| `listIdentityRecords` | Reviewed identity between two commits. Converts losslessly to an `IdentityMapSidecar` whose `base.hash` and `head.hash` are the artifact digests. |
| `createModel` | Creates an empty model. The caller then creates its first commit with `expectedParentId: null`. |
| `createCommit` | Atomic. Throws `conflict` with the current head in `details.headCommitId` when `expectedParentId` is not the model's head. Repeating a call with the same `idempotencyKey` returns the original commit. |
| `recordIdentity` | Adds reviewed entries. The same `(base, here)` pair recorded twice is a no-op. Conflicting claims throw `conflict`. |
| `watchCommits` | Same cursor semantics as `watchRevisions`. One event per model whose head moved. |

### 7.2 Errors

Providers keep their own `Error` subclasses and add a `code` property, so hosts can branch without knowing the provider.

```ts
export type CommitSourceErrorCode =
  | 'not-found'
  | 'forbidden'
  | 'conflict'
  | 'not-ready'
  | 'unsupported-format'
  | 'invalid'
  | 'unavailable';

/** Shape a host checks with `isCommitSourceError`. */
export interface CommitSourceErrorLike {
  readonly code: CommitSourceErrorCode;
  readonly message: string;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function isCommitSourceError(value: unknown): value is CommitSourceErrorLike;
```

`isCommitSourceError` is a runtime export, like `matchesGlob`. It checks for an object with a `code` in the union and a string `message`.

## 8. Host adapter for revision-only providers

`apps/viewer/src/lib/sources/revisionsAsCommits.ts` presents a revision-only file as a model:

- One model per source file. `modelId` is the file id.
- Commits are the file's revisions from `listRevisions`, newest first. `parents[0]` is the next older revision.
- `artifact.digest` is unknown until the bytes are loaded. The adapter computes it on load and caches it by revision id.
- `loadCommit` calls `download` with the revision id. It is available only when `downloadHistoricalRevisions` is true. Otherwise the UI shows the history but disables opening old revisions.
- No fingerprints, stored diffs, element history or writes.

## 9. Payload formats and loading without the model file

| Format | v1 host behaviour |
| --- | --- |
| `ifc-step` | Wrapped in a `File` and loaded through `loadFile`. |
| `ifc-zip` | Same. The loader already unwraps ifcZIP. |
| `ifcx` | Same, through the existing IFCX ingest path. |
| `ifc-lite-cache` | Reserved. Needs a load path that hydrates `@ifc-lite/cache` output for a federated model, and lazy access to source bytes for on-demand extraction. Specified separately. |

What works without transferring the model file in v1:

- commit lists, commit metadata and change counts
- stored diffs between any two commits
- element history
- the revision resolver in source mode, using fingerprints

What needs the payload: rendering the commit in 3D and features that read `store.source`, such as the properties panel's on-demand extraction.

Commit payloads are never written to the user's disk. The existing IndexedDB cache may store them keyed by artifact digest, since commits are immutable.

## 10. Security

- Commit-aware providers should use `auth: 'interactive'` with OIDC authorization code and PKCE, reusing `@ifc-lite/oauth-pkce`. Long-lived secrets must not be stored in the plugin `KeyValueStore`.
- All requests go through the host's sandboxed `ctx.fetch`, so the manifest's `permissions.network` allow-list applies.
- The provider enforces authorization. The host never assumes that seeing a model grants seeing its unpublished commits.
- Telemetry must not carry model names, file names, commit messages or author names, per `lib/analytics-scrub.ts`.

## 11. Fixture and conformance

Extend `@ifc-lite/source-fixture`:

```ts
export interface FixtureCommitSpec {
  readonly id: string;
  readonly parents: readonly string[];
  readonly createdAt: string;
  readonly author?: string;
  readonly message?: string;
  readonly status?: CommitStatus;
  readonly fileName: string;
  readonly content: Uint8Array | string;
  /** Optional precomputed data, so conformance does not need the wasm runtime. */
  readonly fingerprints?: readonly SourceFingerprint[];
  readonly identity?: readonly IdentityEntryLike[];
}

export interface FixtureModelSpec {
  readonly id: string;
  readonly name: string;
  readonly containerId?: string;
  readonly discipline?: string;
  /** Any order; the fixture sorts newest first and derives the head from the mainline. */
  readonly commits: readonly FixtureCommitSpec[];
}

export interface FixtureProjectSpec {
  // ...existing fields
  readonly models?: readonly FixtureModelSpec[];
}

export interface FixtureCapabilityOptions {
  // ...existing fields
  readonly commits?: Partial<CommitCapabilities> | false;
}
```

Fixture behaviour:

- Computes `artifact.digest` from `content`.
- Computes `getCommitDiff` from `fingerprints` with `diffModels`, applying `identity` as key aliases. The fixture package takes `@ifc-lite/diff` as a dev dependency only.
- Derives element history by walking stored diffs along the mainline.
- Supports `setFailure` for every new method, including `conflict` on `createCommit`.

Add `runCommitConformanceSuite(provider, options)` to `@ifc-lite/source-fixture/conformance`. It checks:

1. Manifest: `commits` present implies the five required methods exist; each flag matches its method.
2. Ordering: `listCommits` is newest first, stable across pages, and every non-empty `parents[0]` resolves with `getCommit`.
3. Immutability: two reads of one commit are deep-equal.
4. Payload: `loadCommit` honours `accept` and returns bytes whose SHA-256 equals `artifact.digest`.
5. Fingerprints: keys are unique within a set; `engine` is present; sampling only happens when `maxEntries` is set.
6. Diff: `counts` match `entries`; diffing a commit with itself gives zero changes.
7. Element history: the first entry matches the element's state in the queried commit; the last entry is `added`.
8. Writes: `createCommit` rejects a stale `expectedParentId` with `conflict`; replaying an idempotency key returns the same commit.
9. Errors: every thrown error passes `isCommitSourceError`.

Wire the suite into the fixture's own tests and into `@ifc-lite/source-commit-http` tests against a mocked server.

## 12. Generic HTTP provider

`@ifc-lite/source-commit-http` implements the commit API against a documented REST contract, so any commit service can plug in without a custom provider.

- Manifest name `commit-http`, `auth: 'interactive'`, preference `baseUrl`.
- Capabilities are read from `GET /capabilities` at `testConnection` and cached per base URL.

| Method | Endpoint |
| --- | --- |
| capabilities | `GET /capabilities` |
| `listProjects` | `GET /projects?cursor&limit&query` |
| `listModels` | `GET /projects/{projectId}/models?cursor&limit&query` |
| `getModel` | `GET /projects/{projectId}/models/{modelId}` |
| `listCommits` | `GET /projects/{projectId}/models/{modelId}/commits?cursor&limit&before&after&includeUnpublished` |
| `getCommit` | `GET /projects/{projectId}/models/{modelId}/commits/{commitId}` |
| `loadCommit` | `GET .../commits/{commitId}/payload` with `Accept` listing media types |
| `loadCommitFingerprints` | `GET .../commits/{commitId}/fingerprints?keyProperty&maxEntries&dataOnly` |
| `getCommitDiff` | `GET .../models/{modelId}/diff?base={commitId}&head={commitId}&keyProperty` |
| `listElementHistory` | `GET .../models/{modelId}/elements/{key}/history?atCommitId&keyProperty&cursor&limit` |
| `listIdentityRecords` | `GET .../models/{modelId}/identity?base&head` |
| `createModel` | `POST /projects/{projectId}/models` |
| `createCommit` | `POST .../models/{modelId}/commits` as multipart: `meta` JSON part and `file` part; `Idempotency-Key` header |
| `recordIdentity` | `POST .../models/{modelId}/identity?base&head` |
| `watchCommits` | `POST /projects/{projectId}/commit-events` with model ids and cursor |

Media types: `application/x-step` for `ifc-step`, `application/zip` for `ifc-zip`, `application/json` for `ifcx`. Errors return JSON `{ code, message, retryAfterMs?, details? }` with HTTP 404, 403, 409, 202 for `not-ready`, 415, 400 and 503 respectively.

## 13. Tests

- `plugin-api`: `expectTypeOf` tests for every new type and method signature; runtime test for `isCommitSourceError`.
- `source-fixture`: unit tests for digest, ordering, diff derivation and history derivation; the conformance suite run against the fixture with all flags on and with each flag off.
- `source-commit-http`: conformance suite against a mocked `fetch`.

## 14. Open questions

1. Should element history include `unchanged` entries on request, for a full per-commit timeline of one element?
2. Should `getCommitDiff` support a `scope` parameter, or always return `both`?
3. How should a host treat a fingerprint set produced by an older minor engine version: accept, or recompute locally when the payload is loaded?
