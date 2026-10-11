# Model history

Commit-aware sources keep immutable model deliveries and the changes between them.
Open **Model history** from the command palette or a model's version badge to browse
commits, compare versions, open an older delivery, or return to the latest version.
Historical models are read-only. Providers advertise their capabilities: a source
without stored diffs or uploads does not gain those operations by appearing here.

## Recognizing a new delivery

Open a file normally while an earlier version is loaded. The viewer compares
delivery names, IFC project information, element GlobalIds and content. A likely
match is preselected; a possible match requires an explicit choice. Confirming can
hide the earlier model and open the existing comparison tools. Element identity
suggestions still require their own review. **Decide later** leaves a Resolve
version action on the model row. The History panel also has a setting to disable
automatic prompts.

For a writable source, choose **Upload to source** in Model history, or drop an IFC
delivery on a project in Sources. The file loads through the normal viewer loader
before upload review. Choose a source model or create a new one, review the evidence,
and supply a commit message. A changed source head is reevaluated before retrying;
a changed verdict returns to review. Closing the upload dialog cancels the request.

The same matcher is available without a browser:

```bash
ifc-lite match Structure_R03.ifc Structure_R02.ifc --geometry --json
```

Names narrow the candidates; they do not establish identity. Thresholds are
configurable with `--threshold name=value`. Defaults remain heuristics pending
calibration against real consecutive deliveries; sampled or incomplete evidence
does not receive a likely verdict.

## Exporting history

The export dialog and Model history panel offer three outputs:

| Output | Contents |
| --- | --- |
| History properties | IFC with `IfcLite_History` on elements whose history is known |
| Change set | Head IFC with `IfcLite_Change`, optionally accompanied by deleted-element CSV and BCF |
| History package | `.ifchistory.zip` containing the original delivery, commits, diffs and identity records, with optional past artifacts and deleted-element reports |

**Export history package** also appears in the command palette. Packages can carry
a stamped model instead of the original. Opening a package uses the normal model
loader and attaches a session-local read-only source. Versions without included
artifacts remain visible in the timeline, with Open disabled.

Incomplete history requires explicit acknowledgement before viewer export. Custom
property-set names cannot begin with `Pset_` or `Qto_`. History author fields can be
omitted; this preserves the original IFC's own authoring metadata. Derived IFC files
have an additional `FILE_DESCRIPTION` provenance item and a new output digest. They
cannot be uploaded as another delivery of the same source model.

Past artifacts are loaded and compressed one at a time. The complete compressed
package remains in memory; reading retains verified, expanded content. Packages
are limited to 2 GB of uncompressed data.

```bash
ifc-lite history build first.ifc second.ifc third.ifc --geometry --by-content --include-artifacts --out model.ifchistory.zip
ifc-lite history inspect model.ifchistory.zip --json
ifc-lite history stamp model.ifchistory.zip --out history.ifc
ifc-lite history changes model.ifchistory.zip --since 1 --out changes.ifc --csv deleted.csv --bcf deleted.bcf
```

Files form a mainline in the supplied order. Commit ids are SHA-256 artifact
digests. `--identity-in` and `--lineage-in` accept reviewed sidecars pinned to
adjacent deliveries. `--by-content` explicitly accepts unambiguous content matches
for this build; review those matches before using the package as an identity record.
See the [CLI guide](cli.md#model-revision-matching-and-history) for source access,
authentication, upload and matching options.

Applications can use `@ifc-lite/model-match` and `@ifc-lite/history-export` directly.
History properties use `MutablePropertyView` and the shared `StepExporter`.
`StepExportOptions.additionalDescriptions` appends provenance while retaining the
original `FILE_DESCRIPTION` items and their order. OwnerHistory rewriting and IFC5
history layers remain outside this implementation.
