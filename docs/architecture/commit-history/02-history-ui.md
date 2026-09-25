# 02 · History UI

Status: draft for implementation. Package: `apps/viewer`. Depends on spec 01.

## 1. Purpose

Let a user see a model's version history in the viewer, open any version read-only, compare any two versions, and see the history of one selected element.

This is a first implementation of the "Time Machine" described in `docs/architecture/layer-prs/08-review.md` §8.5: click any historical state to open it read-only. It works on commits from a source, not on IFCX layer stacks. The panel layout should leave room for layer-DAG playback later.

## 2. User stories

1. As a coordinator, I open a model from a source and see its commits, newest first, with author, time, message and change counts.
2. I open last month's commit to see what the model looked like then, and I cannot edit it by mistake.
3. I pick two commits and see what changed between them, in the list and coloured in 3D.
4. I select a wall and see every commit that changed it, including when it was re-created under a new GlobalId.
5. When a new commit lands on a model I have open, I am told and can switch to it.
6. For a model from a revision-only source, such as a shared drive, I still see its revisions as a simple history.

## 3. Entry points

| Entry point | Behaviour |
| --- | --- |
| Activity bar icon "History" | Opens the panel focused on the active model. |
| Model row in the hierarchy (`ModelHeaderRow.tsx`) | New menu item "Show history". Focuses the panel on that model. |
| Commit badge on a model row | Click opens the panel on that model with the loaded commit highlighted. |
| Properties panel | New "History" card for the selected element (§8). |
| Command palette | "Show model history", "Back to latest version". |

## 4. Panel

Register panel id `'history'` in `lib/panels/registry.ts`, appended after the existing ids (the first ten are frozen for Alt+N). Group `'review'`, region `'side'`. Add `['historyPanelVisible', 'history']` to `SIDEBAR_PANEL_FLAGS` and a lazy branch in `renderPanelBody.tsx`.

### 4.1 Layout

```
┌ History ──────────────────────────────────────┐
│ Model  [ Structural model            ▾ ]       │
│ Source  Commit service · Project North         │
│ ─────────────────────────────────────────────  │
│ Compare  A [ none ▾ ]  B [ none ▾ ]  [Compare] │
│ ─────────────────────────────────────────────  │
│ ● Update slab openings level 3        HEAD     │
│ │ J. Hansen · 2 hours ago   +12 ~48 −3         │
│ │                                  [Open ▾]    │
│ ● Coordination round 14             LOADED     │
│ │ M. Berg · 12 Sep 2026     +0 ~211 −9         │
│ ◆ Merge from shared-structure                  │
│ │ …                                            │
│ ● Initial delivery                             │
│   A. Holm · 3 Mar 2026                         │
│                          [ Load more ]         │
└────────────────────────────────────────────────┘
```

### 4.2 Commit row

| Part | Content |
| --- | --- |
| Rail | Dot for a commit, diamond for a merge commit. Mainline only in v1. |
| Title | First line of `message`. Fallback: artifact file name. |
| Meta | Author display name, relative time with an absolute time tooltip (`intlFormat`). |
| Stats | `+added ~modified −deleted` when `stats` is present. Hidden otherwise. |
| Badges | `HEAD` for the model head. `LOADED` for the commit currently open for this model. `Pending` or `Rejected` for non-published commits. |
| Actions menu | Open (replace), Open alongside, Set as A, Set as B, Compare with loaded, Copy commit id. |

Rows are keyboard-navigable. Enter opens the actions menu. The list is virtualized when more than 200 rows are loaded. Pages of 50 via `listCommits` cursor.

### 4.3 States

| State | Shown |
| --- | --- |
| No model loaded | "Open a model to see its history." |
| Model has no source tag | "History is available for models opened from a source." Plus, if the model has a local lineage link from spec 03, a short list of local versions. |
| Revision-only source | Linear list from the `revisionsAsCommits` adapter. No stats. Open is disabled when `downloadHistoricalRevisions` is false, with a tooltip saying why. |
| Commit-aware source | Full panel. |
| Loading | Skeleton rows. |
| Error | `alert` with the provider's message and a Retry button. `forbidden` shows "You do not have access to this model's history." |
| Empty model | "This model has no commits yet." |

## 5. Store

New slice `store/slices/historySlice.ts`, created with `createHistorySlice`, registered in the teardown registry as `historyTeardown`.

```ts
export interface CommitTag {
  readonly provider: string;
  readonly projectId: string;
  /** Source model id (not the viewer's model id). */
  readonly sourceModelId: string;
  readonly commitId: string;
  readonly artifactDigest: string;
  /** True when this commit is not the source model's head at load time. */
  readonly historical: boolean;
  readonly loadedAt: number;
}

export interface LocalLineageLink {
  readonly baseModelId: string;   // viewer model id of the earlier version
  readonly decidedAt: number;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
}

export interface HistorySlice {
  historyPanelVisible: boolean;
  /** Keyed by the viewer's model id. */
  commitTags: Map<string, CommitTag>;
  /** Written by the revision resolver in local mode (spec 03). Keyed by the newer viewer model id. */
  localLineage: Map<string, LocalLineageLink>;
  /** Viewer model id the panel is showing. */
  historyFocusModelId: string | null;
  historyPickA: CommitRef | null;
  historyPickB: CommitRef | null;
  /** New heads reported by watchCommits, keyed by viewer model id. */
  historyNewHeads: Map<string, string>;

  setHistoryPanelVisible(visible: boolean): void;
  setCommitTag(modelId: string, tag: CommitTag): void;
  removeCommitTag(modelId: string): void;
  setLocalLineage(modelId: string, link: LocalLineageLink): void;
  removeLocalLineage(modelId: string): void;
  setHistoryFocus(modelId: string | null): void;
  pickCommit(slot: 'A' | 'B', ref: CommitRef | null): void;
  noteNewHead(modelId: string, commitId: string): void;
  clearNewHead(modelId: string): void;
}
```

Rules:

- `removeModel` clears the model's `commitTags`, `localLineage` and `historyNewHeads` entries through the teardown registry.
- Paged commit lists are not stored in the slice. `useModelHistory` keeps them in a module-level cache keyed by `provider|projectId|sourceModelId`, since commits are immutable.
- Add `isHistoricalModel(modelId)` as a selector: true when the model's commit tag has `historical: true`.

## 6. Opening a commit

### 6.1 Load path

Reuse the source download bridge. Extend `SourceDownloadItem` in `services/sources/source-host.ts`:

```ts
interface SourceDownloadItem {
  name: string;
  buffer: ArrayBuffer;
  sourceFile?: SourceFile;   // becomes optional: commit loads may have no file
  tag?: SourceTag;
  commit?: CommitTag;        // new
  /** Replace this viewer model instead of adding a new one. */
  replaceModelId?: string;   // new
}
```

`useCommitLoad.openCommit(ref, mode)` calls `provider.loadCommit(ctx, ref, { accept: ['ifc-step', 'ifc-zip', 'ifcx'] })`, checks that `artifactDigest` matches the commit, then dispatches the item. The listener in `ViewportContainer.tsx` does what it does today, and additionally calls `setCommitTag(modelId, item.commit)` on success.

- **Open (replace):** set `replaceModelId` to the model being viewed. The listener follows the `syncSourceModel` pattern: load the new model, carry over model tags with `lib/model-tags/carry-over.ts`, then remove the old one. Selection is carried over by key (GlobalId) where the element still exists.
- **Open alongside:** no `replaceModelId`. The commit loads as another federated model. Its display name is `"<model name> @ <short id> · <date>"`.

### 6.2 Read-only historical models

- Add a gate next to the existing collab gate in `mutationSlice.ts`: every mutation action starts with `if (!get().canEditModel(modelId)) return null;`, where `canEditModel` returns false when `isHistoricalModel(modelId)` or when `canCollabEdit()` is false.
- Editing tools and property edit affordances render disabled on historical models, with the tooltip "This is a past version and cannot be edited."
- The model row shows a commit badge: short id and date, amber tint. The row menu gets "Back to latest version", which opens the head with Open (replace).
- Exports from a historical model are allowed. File names include the short commit id.

### 6.3 New commits

When the source has `commits.watch`, `useCommitWatch` polls `watchCommits` for loaded commit-tagged models, reusing the interval and cursor persistence of `lib/sources/revisionWatch.ts`. A new head calls `noteNewHead`. The model row shows "New version available" with an action that opens the head (replace). Nothing reloads automatically.

## 7. Comparing two commits

### 7.1 Flow

1. The user sets A and B from row menus, or chooses "Compare with loaded" on a row, which sets A to that commit and B to the loaded commit.
2. If the source has `storedDiffs`, the panel fetches `getCommitDiff(A, B)` and shows a preview: counts and the first 100 changed elements grouped by state and IFC type. `not-ready` shows "Calculating changes…" and retries after `retryAfterMs`.
3. "Show in 3D" makes sure both commits are loaded. A commit already loaded is reused. A missing one is opened alongside with `visible: false` for the base. Then the existing compare runs: `compareSlice` base and head are set to the two viewer model ids and `useCompare().runComparison()` is called.
4. If the source has `identityRecords`, reviewed identity between A and B is converted to key aliases and added to the compare run through `compareAcceptedIdentity`, so re-GUIDed elements pair correctly.
5. Without `storedDiffs`, step 2 is skipped and the preview appears after step 3 from the local diff.

### 7.2 Compare panel changes

- `CompareResult` gets an optional `commits?: { base: CommitTag; head: CommitTag }`. `CompareRunControls` shows commit labels instead of model names when present.
- Accepting a content match in the compare panel on two commit-tagged models calls `recordIdentity` when the source has `commits.write`, after the same confirmation the panel already uses. Without write access it stays local, as today.

## 8. Element history card

New card `components/viewer/properties/ElementHistoryCard.tsx`, shown in `PropertiesPanel` below the existing cards when the selected entity's model has a commit tag and the source has `elementHistory`.

```
┌ History ─────────────────────────────────────┐
│ ● Modified · geometry, Pset_WallCommon        │
│   Update slab openings level 3 · 2 hours ago  │
│ ● Renamed from 3vB2x… (content match)         │
│   Coordination round 14 · 12 Sep 2026         │
│ ● Added                                       │
│   Initial delivery · 3 Mar 2026               │
│                           [ Show all ]        │
└───────────────────────────────────────────────┘
```

- Key: the entity's GlobalId, or the compare `keyProperty` value when one is set.
- Query: `listElementHistory({ projectId, modelId: sourceModelId, key, atCommitId: tag.commitId })`, first page of 10, lazy on expand.
- Each entry shows state, change kinds, changed component names made readable (`pset:Pset_WallCommon` shows as "Pset_WallCommon"), the commit title and time.
- Clicking an entry opens that commit alongside and selects the element by its key in that commit, resolving the express id through `store.entityIndex` and the federation registry.
- Revision-only sources and sources without `elementHistory` show "Element history is not available for this source."

## 9. Files

All production modules stay under ~400 lines.

| File | Contents |
| --- | --- |
| `store/slices/historySlice.ts` | Slice, selectors, teardown |
| `hooks/history/useModelHistory.ts` | Paged `listCommits`, cache, revision-only adapter selection |
| `hooks/history/useCommitLoad.ts` | `openCommit(ref, mode)`, digest check, bridge dispatch |
| `hooks/history/useCommitWatch.ts` | Head watching |
| `hooks/history/useCommitCompare.ts` | Stored diff fetch, retry, handoff to `useCompare` |
| `hooks/history/useElementHistory.ts` | Card data |
| `lib/sources/revisionsAsCommits.ts` | Adapter from spec 01 §8 |
| `lib/history/commitGraph.ts` | Pure: mainline order and rail layout from `parents` |
| `lib/history/commitLabels.ts` | Pure: short id, display name, stats text |
| `components/viewer/HistoryPanel.tsx` | Panel root and states |
| `components/viewer/history/CommitTimeline.tsx` | Virtualized list |
| `components/viewer/history/CommitRow.tsx` | Row and actions menu |
| `components/viewer/history/HistoryCompareBar.tsx` | A/B pickers and preview |
| `components/viewer/properties/ElementHistoryCard.tsx` | Card |
| `i18n/catalogues/history.en.ts` | Strings |

## 10. Text, telemetry and accessibility

- All strings go through `t()` with keys under `history.*`.
- Telemetry events: `history_panel_opened`, `history_commit_opened` with `{ mode }`, `history_compare_run` with `{ stored: boolean }`, `history_element_card_expanded`. No names, messages, ids or authors.
- Commit rows use `role="listitem"` inside a labelled list. Badges have text, not colour alone. The historical-model tint also has a text label.

## 11. Performance budgets

| Interaction | Budget |
| --- | --- |
| First page of commits rendered after response | 100 ms |
| Scrolling 1,000 loaded commits | 60 fps, virtualized |
| Stored diff preview for 10,000 changed elements | 300 ms to first render; the list is virtualized |
| Element history card first page | One request; no model load |

## 12. Tests

`node:test` via `tsx`, following the component test recipe in `AGENTS.md`, with a fixture commit provider from `@ifc-lite/source-fixture` registered through `SourceHostProvider additionalProviders`.

1. `commitGraph`: order, merge markers, pagination joins.
2. `historySlice`: tag set and cleared on model removal; `isHistoricalModel`.
3. Mutation gate: `setProperty` on a historical model returns null and leaves no undo entry.
4. Panel states: each state in §4.3 renders its message.
5. Open (replace) swaps the model, keeps model tags and re-selects by GlobalId.
6. Compare: stored diff preview renders counts; "Show in 3D" sets compare base and head to the right model ids; identity records become key aliases.
7. Element history card: renders entries, click opens the commit alongside.
8. Revision-only adapter: builds a linear chain; Open disabled without `downloadHistoricalRevisions`.

## 13. Out of scope

- Branch lanes other than mainline.
- Scrubbing playback across commits.
- Editing, reverting or cherry-picking commits from the viewer.
