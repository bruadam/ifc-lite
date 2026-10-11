# @ifc-lite/history-export

Create IFC history properties, marked change sets, deleted-element CSV/BCF and
verified `.ifchistory.zip` packages. Shared by the viewer and CLI.

`buildHistoryIndex` consumes an oldest-first mainline and adjacent stored diffs.
The initial snapshot uses an empty base commit id (`:first-commit-id` in the diff
map). Missing edges mark the index partial; incomplete creation histories are not
invented. `stampHistory` and `markChangeSet` write through `MutablePropertyView`;
export the result with `StepExporter`. Dates use `IfcDateTime` in IFC4 and
`IfcLabel` in IFC2X3. Custom property sets cannot use `Pset_` or `Qto_` prefixes.

`buildHistoryPackage` includes original delivery bytes, commit records, diffs,
reviewed identity and lineage sidecars, and optional past artifacts.
`readHistoryPackage` checks every file digest and sidecar artifact pin before
exposing content. `createHistoryPackageProvider` serves the package offline;
missing historical artifacts or comparisons produce explicit errors.

Packages include commit messages and author names. Pass `omitAuthors` to omit
commit author fields; history stamping likewise omits `LastChangedBy`. The IFC's
original authoring metadata is preserved. Derived IFC exports must not be treated
as original source deliveries.

Packages are limited to 2 GB of uncompressed content. Creation compresses past
artifacts one at a time via `pastArtifacts`, retaining compressed output only.
Reading checks the limit while inflating and retains the verified package in
memory. Optional `deletedReports` adds CSV and BCF reports for a chosen base. OwnerHistory rewriting and IFC5 history layers are deferred as
specified by the design.
