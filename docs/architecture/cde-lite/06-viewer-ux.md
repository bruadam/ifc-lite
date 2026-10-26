# 06: PRD — The Viewer-Centric Interface

Part of the [cde-lite research set](index.md). PRD, not a specification.

## 1. Problem

Every CDE's primary surface is a **file tree**. The model viewer is a secondary
tool you open from a row in that tree. This is backwards for the one job a CDE
exists to support — deciding whether a delivery is acceptable — because the
reviewer's question is about the building, not about the file.

cde-lite inverts it: the **3D viewer is the application**, and the file register
is a view within it.

## 2. The primary object is the change set

The home screen of a project is not a folder listing. It is a queue of
**change sets awaiting a decision**, each one answering:

- Which container, which originator, which revision and suitability.
- What changed: counts of added, modified and deleted elements, grouped by
  component key — `attr:core`, `pset:<Name>`, `qset:<Name>`, `type-assignment`,
  `material`, `classification`, `placement`, `geometry:<tier>`.
- Whether the gates pass: IDS result, naming conformance.
- What is being asked: share, publish, or comment.

The vocabulary is deliberately the one ifc-git's diff already emits, so the UI
names the same things the engine does and there is no translation layer to drift.

## 3. The review surface

Three regions, with the 3D view dominant:

```
┌──────────────────────────────┬───────────────────────────┐
│                              │  CHANGES                  │
│                              │  ▸ pset:Pset_WallCommon 12│
│        3D VIEW               │  ▸ geometry:tessellated 4 │
│   added    · green           │  ▸ attr:core            7 │
│   modified · amber           │  ▸ deleted              3 │
│   deleted  · red ghost       ├───────────────────────────┤
│   unchanged· grey ghost      │  DETAIL                   │
│                              │  IfcWall '3wdauVJT...'    │
│                              │  FireRating  60 → 90      │
│                              │  LoadBearing true → true  │
├──────────────────────────────┴───────────────────────────┤
│  GATES  ✓ IDS (142/142)   ⚠ naming: 'volume' absent      │
│  [ Request changes ]  [ Approve → Published S4/A1 ]      │
└──────────────────────────────────────────────────────────┘
```

Behaviours that matter more than the layout:

- **Selecting a change selects the element in 3D**, and selecting an element in
  3D filters the change list to it. One selection model, both directions.
- **Isolate changed** as a default, not an option. A reviewer should not hunt
  for twelve changed walls in a 40,000-element model; unchanged geometry is
  ghosted context.
- **Property changes are shown as before → after**, localised to the component
  that changed. This is ifc-git's change-localisation rule made visible: edit a
  value inside a property set and the change belongs to *that property-set
  node*, with the owning element merely marked.
- **Deleted elements are rendered from the parent revision.** They do not exist
  in the new model, so the viewer must hold both and ghost the removals — a real
  constraint on the viewer's data layer, not a styling choice.

## 4. The register view, for containers that are not models

A project holds PDFs, spreadsheets and reports. They get a conventional
register: name with parsed convention fields, state, suitability, revision,
originator, date. Versioned and state-gated identically; simply no 3D and no
diff (`03` §6 question 2).

This view must be genuinely good rather than grudging — it is where
non-modelling participants spend their time, and a CDE that treats them as
second class will not be adopted by the people who sign things off.

## 5. Issues: BCF, anchored properly

`packages/bcf` and `bcf-api` already provide topics, comments and viewpoints.
The improvement cde-lite can make is **anchoring**:

- A topic raised from a change set records the **elements** it concerns, not
  only a camera viewpoint and a screenshot.
- Because element identity is content-derived, a topic survives a re-export that
  regenerates `GlobalId`s — the case where file-based CDEs lose the link and the
  issue silently detaches from its subject.
- A topic can block a gate: an open topic at `S4` is a reason Published cannot
  be reached, if the project configures it so.

Interoperability is kept — topics remain BCF 2.1 over the wire, so they flow to
other tools — with element anchoring carried in a way that degrades rather than
breaks for clients that ignore it.

## 6. Performance, as a requirement rather than a hope

A review session opens **two** revisions of a model that may be hundreds of
megabytes. This is the hardest technical requirement in the document.

- Diff is computed server-side and streamed as a change set; the client never
  diffs two full models in the browser.
- Geometry streams by need: changed elements first, context progressively.
- The change list is usable before geometry finishes loading, because a reviewer
  often only needs the property delta.
- Large-model behaviour is measured against the models the repository already
  uses for scale work, not against the sample model.

## 7. Explicitly not built

- **Markup and annotation tools.** BCF viewpoints and comments, yes; a drawing
  markup suite, no. That is a feature war against incumbents (`index.md` §9).
- **Forms, RFIs, submittals, transmittal paperwork.** Out of scope per
  `index.md` §5.
- **Native mobile.** A responsive review surface is in scope; apps are not.
- **Model authoring or editing.** cde-lite reviews and accepts. Editing is the
  `layer-prs` spec set's subject.

## 8. Open questions

1. **How is a federated review presented?** Coordination happens across
   containers from several originators, but a change set belongs to one
   container. Reviewing a federated model against a change set in one of its
   parts is a real workflow with no obvious UI.
2. **What is the right default for "modified"?** An element whose only change is
   `placement` is visually identical from most angles, and a reviewer may call
   that a false positive. Grouping by component helps; it may not be enough.
3. **Does the reviewer need a 2D surface?** `drawing-2d` exists in-tree.
   Sign-off in practice often happens on drawings, not models.
4. **Approval granularity.** Can a reviewer approve some components and reject
   others, or is acceptance all-or-nothing per version? Partial acceptance is
   attractive and may not map onto a single suitability code.
