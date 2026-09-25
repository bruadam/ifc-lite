# 04 · Exporting a model with its history

Status: draft for implementation. Packages: new `@ifc-lite/history-export`, `@ifc-lite/cli`, `apps/viewer`. Uses specs 01 to 03.

## 1. Purpose

An IFC2X3 or IFC4 file describes one state of a model. It cannot hold several versions. This spec defines three exports that carry history as far as the receiving tool can read it:

| Mode | Output | Readable by |
| --- | --- | --- |
| **Stamped** | One commit as IFC, with a history property set on every element | Any IFC tool that shows property sets |
| **Change set** | One commit as IFC, with each element marked added, modified or unchanged against a base commit; deleted elements as BCF and CSV | Any IFC tool, plus any BCF tool |
| **History package** | A zip with the IFC, the commit list, diffs, identity and lineage files, and optionally past deliveries | IFClite, which can browse the history offline; other tools open the IFC inside |

An IFC5 layer-stack export that carries every commit natively is described in the appendix and is not part of v1.

## 2. Principles

1. **An export is a derived file, not a delivery.** Stamped and change-set files differ from the commit's artifact, so their digest differs. The export records which commit it came from (§7). It must never be committed back as a new revision of the same model.
2. **Write through the existing exporter.** History properties are written as property mutations through `MutablePropertyView`, then exported with `StepExporter`. Generated property sets already inherit the host element's owner history, which keeps IFC2X3 files valid.
3. **History data comes from spec 01.** Commit lists, stored diffs and element history come from the commit source. Without a source, only the change set against a locally linked earlier model (spec 03 §8.1) is available.
4. **The original stays untouched.** The history package stores the original artifact bytes by default. Stamping is applied only to the copy being exported.

## 3. Package `@ifc-lite/history-export`

Pure TypeScript, usable in the viewer, the CLI and a server-side commit service.

- Dependencies: `@ifc-lite/export`, `@ifc-lite/mutations`, `@ifc-lite/parser`, `@ifc-lite/data`, `@ifc-lite/diff`, `@ifc-lite/bcf`, `jszip` (already used by `@ifc-lite/export` and `@ifc-lite/bcf`).
- Types for commits, diffs and identity records are imported from `@ifc-lite/plugin-api`.
- Tests: vitest. Every module under ~400 lines.

```ts
/** Per-element history summary, keyed by the element's key in the exported commit. */
export interface ElementHistorySummary {
  readonly key: string;
  readonly createdCommitId: string;
  readonly createdAt: string;
  readonly lastChangedCommitId: string;
  readonly lastChangedAt: string;
  readonly lastChangedBy?: string;
  readonly lastChangeKinds: readonly ('data' | 'geometry' | 'container')[];
  /** Commits in which the element was added or changed, including the one that created it. */
  readonly changeCount: number;
  /** Earlier keys this element had, oldest first, from identity and lineage records. */
  readonly previousKeys: readonly string[];
}

export interface HistoryIndex {
  readonly model: { readonly projectId: string; readonly modelId: string; readonly name: string };
  readonly exportedCommit: SourceCommit;
  /** Mainline commits from the first to `exportedCommit`, oldest first. */
  readonly chain: readonly SourceCommit[];
  readonly elements: ReadonlyMap<string, ElementHistorySummary>;
  /** True when some adjacent diffs were unavailable and summaries are incomplete. */
  readonly partial: boolean;
}

/** Builds the index by walking stored diffs between adjacent mainline commits. */
export function buildHistoryIndex(input: {
  readonly model: HistoryIndex['model'];
  readonly chain: readonly SourceCommit[];
  readonly diffs: ReadonlyMap<string /* `${base}:${head}` */, StoredCommitDiff>;
}): HistoryIndex;

export interface StampOptions {
  /** Property set name. Default `IfcLite_History`. Must not start with `Pset_` or `Qto_`. */
  readonly psetName?: string;
  /** IFC types left unstamped. Default: `IfcOpeningElement`, `IfcVirtualElement`, `IfcAnnotation`. */
  readonly excludeTypes?: readonly string[];
  /** Owner history handling (§5.4). Default `keep`. */
  readonly ownerHistory?: 'keep' | 'stamp';
}

export function stampHistory(
  store: IfcDataStore,
  view: MutablePropertyView,
  index: HistoryIndex,
  options?: StampOptions,
): StampReport;

export interface ChangeSetOptions {
  /** Property set name. Default `IfcLite_Change`. Must not start with `Pset_` or `Qto_`. */
  readonly psetName?: string;
  readonly includeUnchanged?: boolean;   // default true: unchanged elements get ChangeState=Unchanged
  readonly deleted?: { readonly bcf: boolean; readonly csv: boolean };  // default both true
  readonly excludeTypes?: readonly string[];
}

export function markChangeSet(
  store: IfcDataStore,
  view: MutablePropertyView,
  diff: StoredCommitDiff,
  base: SourceCommit,
  head: SourceCommit,
  options?: ChangeSetOptions,
): ChangeSetReport;

export function deletedElementsBcf(
  diff: StoredCommitDiff,
  baseFingerprints: CommitFingerprintSet | null,
  context: { readonly base: SourceCommit; readonly head: SourceCommit; readonly modelName: string },
): Promise<Blob>;

export function deletedElementsCsv(diff: StoredCommitDiff, baseFingerprints: CommitFingerprintSet | null): string;

export function buildHistoryPackage(input: HistoryPackageInput): Promise<Blob>;
export function readHistoryPackage(bytes: ArrayBuffer): Promise<HistoryPackage>;

export interface StampReport {
  readonly stamped: number;
  readonly skippedExcluded: number;
  /** Elements in the file with no entry in the index, e.g. when `partial` is true. */
  readonly withoutHistory: number;
}

export interface ChangeSetReport {
  readonly added: number;
  readonly modified: number;
  readonly unchanged: number;
  readonly deleted: number;
}
```

## 4. Building the history index

1. Take the mainline from the first commit to the exported commit, following `parents[0]`.
2. For each adjacent pair, get the stored diff with `getCommitDiff`. When the source lacks `storedDiffs`, the viewer can compute a diff locally only if both commits' payloads can be loaded; otherwise the pair is skipped and the index is `partial`.
3. Walk the pairs oldest first. Keep a map from current key to summary:
   - `added`: new summary with created and last-changed set to this commit.
   - `modified`: update last-changed fields and increment `changeCount`.
   - `deleted`: remove the summary.
   - An entry with `baseKey`: move the summary from `baseKey` to `key` and append `baseKey` to `previousKeys`.
4. `lastChangedBy` is the commit author's display name.

`listElementHistory` is not used here. Walking diffs once is cheaper than one request per element.

## 5. Stamped export

### 5.1 History property set

Written to every stamped element. Default name `IfcLite_History`, configurable, never with a `Pset_` or `Qto_` prefix, which buildingSMART reserves.

| Property | Type | Value |
| --- | --- | --- |
| `ExportedCommit` | `IfcIdentifier` | Id of the exported commit |
| `SourceModel` | `IfcLabel` | Model name in the source |
| `CreatedCommit` | `IfcIdentifier` | Commit that added the element |
| `CreatedAt` | `IfcDateTime`, or `IfcLabel` in IFC2X3 | ISO 8601 UTC |
| `LastChangedCommit` | `IfcIdentifier` | Last commit that changed the element |
| `LastChangedAt` | `IfcDateTime`, or `IfcLabel` in IFC2X3 | ISO 8601 UTC |
| `LastChangedBy` | `IfcLabel` | Author display name, when known |
| `LastChangeKinds` | `IfcLabel` | Comma-separated, e.g. `geometry,data` |
| `ChangeCount` | `IfcInteger` | Commits that added or changed the element |
| `PreviousGlobalIds` | `IfcText` | Comma-separated earlier keys, oldest first; omitted when empty |

`IfcDateTime` exists from IFC4. IFC2X3 files get the same ISO string as `IfcLabel`.

Values map to `PropertyValueType` as `Identifier`, `Label`, `Text` and `Integer`. Dates use `Label` in IFC2X3; for IFC4 and later the exporter writes `IFCDATETIME`, which needs the small addition in §5.3.

### 5.2 Steps

1. Load the exported commit through `loadCommit`, or use the model already loaded in the viewer.
2. Build the index (§4).
3. Create a `MutablePropertyView` on the store, as the export dialog already does.
4. `stampHistory` writes the properties with `view.setProperty(entityId, psetName, name, value, type)` for every element whose key is in the index.
5. Export with `StepExporter.export({ schema, applyMutations: true, description, filename })`, keeping the schema of the source unless the user chooses another.

### 5.3 Exporter addition

`PropertyValueType` has no date type, and the exporter has no date handling today. `MutablePropertyView.setProperty` already accepts an optional `dataType` string as its eighth parameter. Stamping passes `valueType: Label` with `dataType: 'IfcDateTime'`. Teach the exporter to write `IFCDATETIME('…')` for that data type in IFC4 and later, and `IFCLABEL('…')` in IFC2X3. Add a round-trip test in `packages/export`.

### 5.4 Owner history stamping

`ownerHistory: 'stamp'` is optional and off by default. When on:

- Create one `IfcOwnerHistory` per `(ChangeAction, LastModifiedDate)` group, reusing the file's existing `OwningUser` and `OwningApplication`.
- Set `ChangeAction` to `ADDED` for elements created in the exported commit, `MODIFIED` for elements changed in it, `NOCHANGE` otherwise. `LastModifiedDate` is the epoch seconds of the element's last change.
- Point each stamped element's `OwnerHistory` at its group.

This rewrites owner history references that authoring tools often share across all elements. Keep it off by default, and add it only after the property-set path has shipped. It needs its own exporter support and tests in `packages/export`, next to `owner-history.test.ts`.

## 6. Change-set export

### 6.1 Change property set

Default name `IfcLite_Change`.

| Property | Type | Value |
| --- | --- | --- |
| `ChangeState` | `IfcLabel` | `Added`, `Modified` or `Unchanged` |
| `ChangeKinds` | `IfcLabel` | Comma-separated, for `Modified` |
| `ChangedComponents` | `IfcText` | Readable component names, e.g. `Pset_WallCommon, geometry` |
| `BaseCommit` | `IfcIdentifier` | Base commit id |
| `HeadCommit` | `IfcIdentifier` | Exported commit id |
| `PreviousGlobalId` | `IfcIdentifier` | The element's key in the base commit, when it was re-keyed |

The file is the head commit, so a coordinator can filter on `ChangeState` in any tool.

### 6.2 Deleted elements

Deleted elements do not exist in the head commit, so they are delivered next to the IFC:

- **BCF:** one topic titled "Deleted since <base short id>", with one component per deleted element (IfcGuid set to its base key), topic type `Remark`, and, when base fingerprints with bounding boxes are available, a viewpoint framing their combined box. Built with `createBCFProject`, `createBCFTopic` and `writeBCF`, as the compare panel's BCF-from-change flow already does.
- **CSV:** columns `GlobalId`, `IfcType`, `Container`, `BaseCommit`, from the diff and base fingerprints.

### 6.3 Local mode

Without a commit source, a change set is available between a model and the earlier model it was linked to by the resolver (spec 03 §8.1). The diff comes from a local compare run instead of a stored diff. `BaseCommit` and `HeadCommit` then hold the two files' `sha256:` digests.

## 7. File header of derived exports

Stamped and change-set files state what they are:

- `FILE_NAME` name: `<model name>@<short commit id>.ifc`.
- One `FILE_DESCRIPTION` item is appended: `ifc-lite-export(history|change-set); commit=<id>; base=<id>; source-digest=<sha256>`. Existing items, including the view definition, stay first and unchanged.
- The export dialog shows the output digest after writing, so it can be recorded as a derivation where the source supports it (open question 1).

## 8. History package

### 8.1 Layout

File extension `.ifchistory.zip`. Not `.ifczip`, which tools expect to hold a single IFC file.

```
manifest.json
README.txt
model/<file name>                      exported commit: original bytes, or stamped when chosen
commits.json                           SourceCommit[] of the mainline, oldest first
diffs/<base>__<head>.json              StoredCommitDiff for each adjacent pair
identity/<base>__<head>.json           IdentityMapSidecar, pinned to the two artifact digests
lineage/<base>__<head>.json            LineageSidecar, when available
artifacts/<commit id>/<file name>      optional past deliveries
changes/deleted-since-<base>.bcf       optional, when a change-set base was chosen
```

### 8.2 Manifest

```ts
export interface HistoryPackageManifest {
  readonly format: 'ifc-lite/history-package';
  readonly version: 1;
  readonly createdAt: string;
  readonly createdWith: string;              // e.g. '@ifc-lite/history-export@0.1.0'
  readonly model: { readonly name: string; readonly sourceProvider?: string; readonly projectId?: string; readonly modelId?: string };
  readonly exportedCommitId: string;
  readonly modelFile: { readonly path: string; readonly digest: string; readonly stamped: boolean };
  readonly commitCount: number;
  /** 'none' | 'exported' | 'all' */
  readonly artifacts: 'none' | 'exported' | 'all';
  /** Every file in the zip except the manifest, with its sha256 digest. */
  readonly files: readonly { readonly path: string; readonly digest: string; readonly sizeBytes: number }[];
  readonly partial: boolean;
}
```

- `readHistoryPackage` refuses a package whose file digests do not match the manifest, or whose identity and lineage sidecars do not pin to the artifact digests in `commits.json`.
- `README.txt` explains in plain words what the package contains and that the IFC in `model/` opens in any tool.

### 8.3 Opening a package in the viewer

Opening a `.ifchistory.zip` in the viewer:

1. Loads `model/<file name>` through `loadFile`.
2. Registers an in-memory, read-only commit-aware provider built from the package: `listCommits` from `commits.json`, `getCommitDiff` from `diffs/`, `listIdentityRecords` from `identity/`, element history derived from the diffs, and `loadCommit` from `artifacts/` when present.
3. Sets a commit tag on the loaded model, so the History panel (spec 02) works offline. Commits without an artifact show Open as disabled with the reason "Not included in this package."

The provider is registered for the session only and does not appear in the Sources panel.

## 9. Viewer

### 9.1 Export dialog

`ExportDialog.tsx` gets a "History" section, shown when the selected model has a commit tag or a local lineage link:

```
History
  ○ None
  ○ Add history properties to every element
  ○ Mark changes since  [ Coordination round 14 ▾ ]
       ☑ Deleted elements as BCF   ☑ Deleted elements as CSV
  Property set name  [ IfcLite_History ]
```

- "Mark changes since" lists earlier mainline commits, or the linked earlier model in local mode.
- When the index is partial, the dialog shows "Some history is unavailable. Elements without history get no properties." before export.
- Downloads go through `lib/export/download.ts` and `sanitizeFilename`. Change sets with deleted-element files download as one zip.

### 9.2 History package command

A separate command, "Export history package…", from the History panel header and the command palette:

```
Export history package
  Model file     ○ Original delivery   ○ With history properties
  Past versions  ○ None   ○ All (≈ 1.4 GB)
  ☐ Include deleted elements since [ … ▾ ]
                                        [ Cancel ]  [ Export ]
```

The size estimate is the sum of `artifact.sizeBytes`. Past versions are loaded one at a time and streamed into the zip, to keep memory bounded.

### 9.3 Files

| File | Contents |
| --- | --- |
| `hooks/history/useHistoryExport.ts` | Index building, stamping or change marking, export and download |
| `hooks/history/useHistoryPackage.ts` | Package export and progress |
| `lib/history/packageProvider.ts` | In-memory provider from a read package |
| `components/viewer/export/HistoryExportSection.tsx` | Export dialog section |
| `components/viewer/history/HistoryPackageDialog.tsx` | Package dialog |
| `i18n/catalogues/history-export.en.ts` | Strings |

## 10. CLI

Works on files, without a commit source, so a folder of deliveries can become a history.

```
ifc-lite history build <v1.ifc> <v2.ifc> ... [--by-content] [--geometry] [--out package.ifchistory.zip] [--include-artifacts]
ifc-lite history stamp <package.ifchistory.zip> --out stamped.ifc [--pset NAME]
ifc-lite history changes <package.ifchistory.zip> --since <commit-id|index> --out changes.ifc [--bcf deleted.bcf] [--csv deleted.csv]
ifc-lite history inspect <package.ifchistory.zip> [--json]
```

- `build` treats the files as a mainline in the order given, one commit per file, with the file's modification time as `createdAt` and its name as the message. Adjacent pairs are diffed with the existing diff engine, using `--identity-in` and `--lineage-in` sidecars when supplied.
- Commit ids are the files' `sha256:` digests.

## 11. Privacy

- Author names and commit messages are included in stamped files and packages. The export dialog says so next to the Export button: "The file will include author names and commit messages from the history."
- An option "Leave out author names" omits `LastChangedBy` and replaces authors in `commits.json` with "Unknown".
- Telemetry: `history_export` with `{ mode, schema, partial }`. No names or ids.

## 12. Tests

`@ifc-lite/history-export`, vitest, with small inline IFC2X3 and IFC4 models as the export tests already use:

1. Index: add, modify, delete and re-key across four commits give the expected summaries.
2. Stamp IFC2X3: every stamped element has the property set; dates are `IFCLABEL`; generated property sets reference an existing owner history; the output has no dangling references.
3. Stamp IFC4: dates are `IFCDATETIME`.
4. Pset name validation: `Pset_History` is refused.
5. Change set: counts match the diff; re-keyed elements carry `PreviousGlobalId`; the BCF has one component per deleted element; the CSV has one row per deleted element.
6. Header: the appended `FILE_DESCRIPTION` item is present and earlier items are unchanged.
7. Package: round trip through `buildHistoryPackage` and `readHistoryPackage`; a modified file inside the zip is refused; a sidecar pinned to the wrong digest is refused.
8. Partial index: missing diffs mark the index partial and leave affected elements unstamped.

Viewer, `node:test`: the export dialog section appears only for models with history; opening a package registers the in-memory provider and the History panel lists its commits.

CLI: `history build` on three fixture files produces a package whose `inspect` output lists three commits.

## 13. Open questions

1. Should spec 01 gain an optional `recordDerivation` method, so a commit service can register exported files as derivations of a commit?
2. Should the stamped property set also carry the element's full change list, or only the summary? A full list can grow large on models with many revisions.
3. Should packages support splitting past versions across several zip files for very large histories?

## Appendix: IFC5 layer-stack export (not in v1)

IFC5 can carry the full history natively. The repository already has the pieces in `@ifc-lite/ifcx` and `@ifc-lite/merge`: layer stacks, tombstones, provenance manifests with author, intent, parents and identity map, and layer diffs.

A future `ifcx-history` mode would:

1. Convert the first commit to an IFCX base layer.
2. For each later mainline commit, convert it to IFCX and emit a delta layer holding only the changed entities and components, with tombstones for deletions.
3. Attach a provenance manifest to each delta layer: `author` from the commit author, `intent` from the message, `created` from `createdAt`, `parents` from the previous layer, and `identity_map` from the commit's identity records.

It is deferred because IFC5 is still being standardized and few tools read it today. It should follow the layer format in `docs/architecture/layer-prs/02-layer-format.md` exactly, so it can later feed the layer registry described in `10-registry.md`.
