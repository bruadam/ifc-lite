# Commit history for IFClite: specs

Status: v1 implementation available for review on `feat/commit-aware-sources`. The documents below retain the design contracts; see [Model history](../../guide/model-history.md) for the implemented viewer and CLI entry points.

These specs add model version history to IFClite. A source can describe models as a chain of immutable commits. The viewer can open any commit, compare any two commits, show one element's history, and ask the user whether a newly opened file is a new version of a model it already knows.

| Spec | Scope | Main packages |
| --- | --- | --- |
| [01 Commit-aware source API](01-commit-source-api.md) | Additive extension of the file-source plugin contract: models, commits, payloads, fingerprints, stored diffs, element history, identity records, writes | `@ifc-lite/plugin-api`, `@ifc-lite/source-fixture`, new `@ifc-lite/source-commit-http` |
| [02 History UI](02-history-ui.md) | History panel, read-only historical models, commit compare, element history card | `apps/viewer` |
| [03 Revision resolver](03-revision-resolver.md) | "Is this a new version of an existing model?" on file open and upload | new `@ifc-lite/model-match`, `@ifc-lite/cli`, `apps/viewer` |
| [04 History export](04-history-export.md) | IFC with history properties, change sets against a base commit, and offline history packages | new `@ifc-lite/history-export`, `@ifc-lite/export`, `@ifc-lite/cli`, `apps/viewer` |

## Design principles

1. **Additive only.** Every new plugin-api member is optional and gated by a capability. `PLUGIN_API_VERSION` moves from `2.0.0` to `2.1.0`. Existing providers keep working unchanged.
2. **Reuse what exists.** Identity maps and lineage keep their sidecar formats, pinned to the commit's artifact digest. Fingerprints keep the `EntityFingerprint` shape from `@ifc-lite/diff`. Compare keeps `useCompare` and `diffModels`.
3. **One load path.** A commit opened in the viewer still arrives as bytes, is wrapped in a `File`, and goes through `useIfcLoader().loadFile`. No second ingest pipeline.
4. **Work without the model file where possible.** Fingerprints, stored diffs and element history let the viewer list changes, show an element's history and resolve revisions without transferring the IFC file. Only rendering a commit in 3D needs its payload.
5. **Commits are immutable.** A commit id and its artifact digest never change. Anything derived from a commit can be cached by commit id without expiry.
6. **The user decides identity.** Name and element matching produce evidence. Model lineage and element identity are recorded only after a person accepts them.
7. **Public repository rules.** No client, partner or internal system names in code, docs, fixtures or tests. The backend is referred to as a "commit service".

## Delivery plan

Each step is one PR under the ~1,500 changed-line limit, stacked in this order.

| # | PR | Depends on |
| --- | --- | --- |
| 1 | plugin-api 2.1.0 commit types, capability object and error codes; type tests | none |
| 2 | source-fixture: commit world spec, fixture commit provider, `runCommitConformanceSuite` | 1 |
| 3 | `@ifc-lite/model-match`: name normalization, header signals, element overlap, verdicts; unit tests | none |
| 4 | CLI `ifc-lite match` | 3 |
| 5 | Viewer: `historySlice`, commit tags, loading a commit through the source bridge | 1, 2 |
| 6 | Viewer: History panel timeline, open read-only, back to latest | 5 |
| 7 | Viewer: commit compare and element history card | 6 |
| 8 | Viewer: revision resolver dialog, local mode | 3 |
| 9 | Viewer: upload to a commit source with resolver, source mode | 7, 8 |
| 10 | `@ifc-lite/source-commit-http` generic provider and REST contract | 1, 2 |
| 11 | `@ifc-lite/export`: `IfcDateTime` data type on property values | none |
| 12 | `@ifc-lite/history-export`: history index, stamping, change sets, deleted-element BCF and CSV | 1, 11 |
| 13 | History package format, reader, in-memory package provider; CLI `ifc-lite history` | 12 |
| 14 | Viewer: export dialog history section and history package command | 6, 12, 13 |

Steps 3, 4, 8 and 11 can start in parallel with 1 and 2.

## Out of scope for v1

- Branches other than a single mainline per model. `parents[]` allows merge commits so the format does not need to change later.
- Editing historical commits. Historical models are read-only.
- Loading a pre-parsed snapshot instead of the IFC file (`ifc-lite-cache` payload). Reserved in the format list; see 01 §9.
- Automatic acceptance of resolver verdicts. The resolver always asks.
- IFC5 layer-stack export of the full history. Outlined in the appendix of spec 04.

## Reproducible implementation evidence

Run `node tools/commit-history-evidence.mjs` after building the CLI and WASM and
fetching `ara3d/AC20-FZK-Haus.ifc` with `pnpm fixtures`. The script starts with the
catalogued Archicad 20 IFC4 delivery, changes only wall #15042's Name in a second
version, and changes only that wall's GlobalId in a third. These are controlled
edits to a real authoring-tool file, not a corpus of real consecutive deliveries.

The [recorded receipt](evidence/archicad-controlled-edits.json) shows three commits,
a likely revision verdict, creation history retained through the GlobalId change,
and a Modified change-set state with the earlier GlobalId. All 107 geometry
fingerprints are identical between the head delivery and each derived export.
Original header descriptions remain present. Export digests vary between runs
because the file header records export time.

Unit and integration coverage includes IFC2X3 and IFC4 property round trips,
identity swaps, nonadjacent comparisons, package integrity and artifact pinning,
offline history without old payloads, source-head conflict reevaluation, local
resolver confirmation, read-only mutation guards and teardown.

Before release, calibrate the configurable matching thresholds on real consecutive
project deliveries. This branch also depends on a repair to the published
`dalux-build-api@2.5.0` tarball, which omits its compiled `dist` files. Local
validation used the tested SDK build; a clean installation requires that SDK
release to be repaired. OwnerHistory rewriting and IFC5 history layers remain
explicitly deferred by spec 04.
