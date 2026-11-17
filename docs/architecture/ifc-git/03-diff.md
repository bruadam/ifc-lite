# 03: Diff

Status: draft, for discussion. Part of the [ifc-git spec set](index.md).

This document describes an engine that **already shipped**, under
[#8042](https://github.com/LTplus-AG/ifc-lite/issues/8042) (#8043 → #8105). It
does not propose that engine; it says what ifc-git takes from it, what it does
not, and where the two disagree. How to *call* the engine — options, defaults,
tolerances, the CLI and viewer surfaces — is the
[Model Diff guide](../../guide/model-diff.md) and the `@ifc-lite/diff` README,
and is not restated here.

## 3.1 Role: the delta-layer computer

Index §1 says a delivery becomes a delta layer "computed from the **diff
against that previous delivery** rather than from the file bytes". This is the
diff. Its job in ifc-git is to answer three questions about two deliveries of
one model, in this order:

1. **Which entity in the new delivery is which entity in the old one?** Keyed
   pairing, then content-keyed reconciliation where keys cannot be trusted.
2. **For each pair, did anything change, and what?** A verdict per entity, and
   the component keys (02 §2.3) that moved.
3. **What could it not decide?** Abstentions, reported as such and never
   resolved by guessing.

The answers feed `05-layer-adapter.md` (row 8): a pair that changed becomes
opinions on the changed members, an unpaired base entity becomes a tombstone
(index §4), an unpaired head entity becomes an addition, and an accepted
re-keying becomes an `identity_map` entry. Nothing in the engine writes a
layer, and nothing in it should.

## 3.2 What the engine is

`rust/diff` (`ifc-lite-diff`) is pure: no I/O, no parser, no geometry kernel. A
caller extracts one `EntityFingerprint` per entity from whatever store it holds
and hands over two lists. The engine never sees an IFC file.

| Field | Source | Read by |
| --- | --- | --- |
| `key` | the adapter; normally `GlobalId` | keyed pairing |
| `ifcType` | the adapter | every pass (bucket key and collision guard) |
| `dataHash` | `build_data_fingerprint` over a `DataFingerprintInput` | keyed verdict, content buckets |
| `components` | `build_component_fingerprints` over the same input | `changedComponents`, collision guard |
| `geometryHash` | the geometry pass (§3.6), or a `p:` placement fingerprint | keyed verdict, content tiers 1–2 |
| `aabb`, `volume` | the geometry pass | move/reshape split, positional pairing, split/merge |
| `container` | the adapter: a spatial **name** path, never `GlobalId`s | `container` change kind, successor `position` profile |

`diff_models` (`rust/diff/src/engine.rs`) composes four passes. The order is
fixed, and the second column is the property everything downstream leans on:

| Pass | Retires entries? | Output |
| --- | --- | --- |
| Keyed pass (`key_diff.rs`) | — | `entries`, `counts`, `byKey`: one `added` / `modified` / `deleted` / `unchanged` per key |
| Content matching (`content_match.rs`), opt-in | **yes**: replaces an `added` + `deleted` pair with one match record | `contentMatches`, each with a `kind` and a `tier` |
| Split / merge (`split_merge.rs`), opt-in, needs content matching | no, additive | `splitMerges` |
| Successors (`successor.rs`), opt-in, needs content matching | no, additive | `successors` |

"Additive" is a guarantee, not a description: a split, merge or successor claim
never removes an entry or touches `counts`, because one claim binding `k + 1`
entities on a single chain of evidence must not be able to delete `k + 1` real
changes. Only content matching retires, and only on the evidence §3.5 lists.

The TypeScript package `@ifc-lite/diff` is now a facade over this crate,
compiled to its own WASM module (`rust/diff-wasm`, published as
`@ifc-lite/wasm/diff`). There is no TypeScript engine at runtime; §3.8 says
where the old one went.

## 3.3 Change localisation, as shipped

Index §2.3 says a change belongs to the node that carries it. The engine
delivers the *reporting* half of that today, through component fingerprints.

`build_component_fingerprints` hashes the same `DataFingerprintInput` that
`build_data_fingerprint` hashes, sliced by component:

```
attr:core              Name, Description, ObjectType, PredefinedType, the IFC
                       class, and Tag for type objects only
pset:<Name>            one per property set
pset#<n>:<Name>        the n-th set of a repeated name (n ≥ 2)
qset:<Name>            likewise for quantity sets, with qset#<n>:<Name>
type-assignment        assigned types by name and class, never by GlobalId
material               resolved material names, omitted when empty
classification         resolved classification references, omitted when empty
```

When both sides of a pair carry `components`, `DiffEntry.changedComponents`
names the slices whose sub-hash differs. The ordinal form is a correction
(#8136): keyed by name alone, the last of two same-named sets overwrote the
first, and an entity could come back `modified` with an empty
`changedComponents`. 02 §2.3 lists `pset:<Name>` "one per property set", which
is true of the common case and should be read with the ordinal included. The
ordinal follows the sets' content order, so editing one of two same-named sets
can renumber them and report both as changed. That is a reporting cost, and a
node model does not have it: two property-set nodes are two addresses whatever
order they sort in.

**What the engine does not do is the node half.** A property set shared by two
occurrences and edited once is, in the corpus (`tools/ifc-git-corpus`, `r11`),
reported as **two** `modified` entries that each name `pset:Pset_WallCommon`.
The engine has no notion of sharing; it hashes each occurrence's projection
independently. "One node change plus N markers" is delivered by `rust/git`,
where two identical projections of a set produce one address. The engine
supplies the markers, and `rust/git` supplies the single node.

### Change kinds that are not components

`DiffEntry.changeKinds` has three values, and only one of them is localised:

| Kind | Raised when | Localised to a component? |
| --- | --- | --- |
| `data` | `ifcType` or `dataHash` differs | yes, through `changedComponents` |
| `geometry` | the geometry hash differs (and geometry is in scope, §3.6) | no |
| `container` | both sides carry a non-empty container name path and they differ (#5214) | no |

A storey reassignment is therefore reported as `modified` with
`changeKinds: ['container']` and an **empty** `changedComponents`. In graph
terms it is a change to an `IfcRelContainedInSpatialStructure`, which is a
`relationship` node — and `rust/git` has no relationship nodes yet (§3.9).

## 3.4 Two kinds of hash, and which one answers what

The engine and the object layer hash the same content projection with
different functions, for different purposes. Confusing the two is the most
likely way to build a wrong adapter.

| | Engine (`rust/diff`, geometry pass) | Object layer (`rust/git`) |
| --- | --- | --- |
| Data | 64-bit FNV-1a over `JSON.stringify`-compatible text (`dataHash`, component sub-hashes) | BLAKE3 over the node encoding (index §6.1) |
| Geometry | 64-bit splitmix fold over quantized world vertices and per-plane area | **none yet** |
| Built for | catching drift, byte-identical to the historical TypeScript engine (§3.8) | content addressing that an approval can rest on |
| Collision-resistant | no; the guide states the residual | yes |

The adapter in `rust/git` takes this seriously already: it reuses the engine's
**projection** (`DataFingerprintInput`, so "what counts as content" is decided
in one place) and never the engine's **hashes**.

So the engine's verdicts should not be what decides whether a delivery is a new
version. 02 §2.7 already says the no-empty-commit test is "taken over the
tree's `key → node` **entries**". That is a comparison of BLAKE3 addresses per
key, not of `dataHash`. **Proposed:** the engine decides *pairing* (§3.5) and
*attribution* (`changedComponents`); the object layer decides *whether
anything changed*, by comparing entries under that pairing. A 64-bit FNV
collision then costs a wrong component name in a report, rather than a change
silently missing from history.

This proposal has a precondition that does not hold today. The object layer can
only decide "no change" over the content it addresses, and §3.9 lists what it
does not address yet: geometry, placement and relationships. Until it does, a
delivery that changes only those — corpus `r02`, a wall moved 250 mm with its
data untouched — has identical tree entries, and an entry-level test reads it
as unchanged. The engine sees that move (`geometry` change kind). The object
layer cannot. That condition is the same kind as the one 02 §2.7 already
records for coincident duplicates: an "empty diff ⇒ no commit" claim that holds
only over the content the encoding actually captures.

## 3.5 Reconciliation: the content-match tiers

02 §2.4 says a re-GUID "reads as the rename case the shipped content-matching
tiers already resolve". This is that mechanism, from ifc-git's side.

The keyed pass pairs by `key` and leaves everything unpaired as `added` or
`deleted`. With `matchUnpairedByContent`, a second pass buckets that residue by
`(ifcType, dataHash)` and pairs inside buckets on progressively weaker
evidence. Every record carries the evidence that produced it as a `tier`:

| Tier | Evidence | Can retire as |
| --- | --- | --- |
| `geometry-hash` | data hash **and** world geometry hash agree, `N` per side | `renamed` |
| `geometry-only` | world geometry hash and box agree, data differs, 1:1, across data buckets | `respecified` |
| `residue-1-1` | the one base and one head left in a bucket, agreeing on `ifcType` and, where both carry `components`, on every sub-hash | `renamed`, `moved`, `reshaped` |
| `positional` | iterated mutual nearest neighbour on box centres, under `maxMoveDistance` | `renamed`, `moved`, `reshaped` |
| `unresolved` | nothing retired | reported as `duplicated`, `deduplicated`, `ambiguous` |

Three properties of this pass matter to the layer adapter.

**An abstention is an answer.** `duplicated`, `deduplicated` and `ambiguous`
groups leave the original `added` and `deleted` entries in place and mint no
identity claim. `identityMapFromContentMatches` emits a `{ base, here,
reason }` claim only for a 1:1 `renamed`, `moved`, `reshaped` or
`respecified`, with reason `content-match:<kind>`. That is the same vocabulary
as Layer PRs' `identity_map` (`layer-prs/04-identity.md`), so the hand-over in
row 8 needs no translation. The conservative layer for an unresolved group is a
tombstone for each base candidate plus an addition for each head candidate:
correct content, with the identity left unrecorded. Corpus `r10` is that case:
one element split into two reports one `duplicated` group and no claim.

**Tier is an acceptance policy input.** `geometry-hash` and `geometry-only`
are corroborated by an agreeing geometry hash; `residue-1-1` rests on the data
hash, `ifcType` and (when supplied) component sub-hashes alone, and is where the guide locates
the pass's whole false-positive budget. Which tiers an ingest accepts without
review is a policy for `05-layer-adapter.md` to state. The engine makes it
expressible and does not choose it.

**A pure re-GUID empties `counts` rather than filling `unchanged`.** A retired
match removes its two entries from `entries`, `byKey` and `counts`. Corpus
`r07` regenerates every `GlobalId`: keyed, 40 added and 40 deleted; with
content matching, `{ added: 0, modified: 0, deleted: 0, unchanged: 0 }` and 40
`renamed` matches, each minting a claim. So "this delivery changed nothing" is
not `counts.unchanged === total`. In engine terms it is: no `added`,
`modified` or `deleted` entry, no `unresolved` record, and every retiring
match a `renamed`. A `moved`, `reshaped` or `respecified` match is a change
that has been paired, not an absence of change. Under §3.4's proposal, the
object layer answers the same question by comparing entries, and the two
answers should agree. If they disagree, either an FNV collision or a gap in
§3.9 is the cause.

### Remembering an accepted match

A claim is only useful if the next comparison honours it. `keyAliases` (head
key → base key) applies accepted claims *before* the keyed pass indexes
anything, so an aliased pair is classified by key and never re-enters content
matching. A stale or colliding alias is dropped rather than applied, and
`appliedKeyAliases` reports what took effect. For plain files, the identity-map
and lineage sidecars pin the content digest of **both** revisions the claims
were verified against and refuse to be replayed against a different pair. That
is the property the layer adapter needs from `identity_map`: a claim is bound
to the pair of deliveries it was made about.

## 3.6 Geometry, and the granularity question 02 deferred

02 §2.8 deferred "whether a tier is one node or several, and how it relates to
the geometry pass's existing hashes" to this document. Here is what the
geometry pass actually provides, then the question in its sharper form.

`ifc_lite_geometry::geom_hash` produces one `u64` per meshed entity:

- **In world coordinates**, reconstructed as `local + rtc_offset`, so two files
  that chose different relative-to-centre offsets agree, and so a *moved*
  element hashes differently.
- **Quantized** to a grid of `DEFAULT_GEOM_HASH_TOLERANCE` (1 mm), clamped to
  a floor where the plane arithmetic would overflow on a georeferenced model.
- **Over the surface, not the triangles**: the set of distinct quantized
  vertices and the total area per supporting plane. Triangle order, winding
  and a re-cut over the same corners do not move it. A tessellation that
  *introduces* vertices does.

Beside it, the same pass emits an unquantized world `aabb` and, only where the
mesh is provably one closed, orientable, single-component solid, a `volume`.
Geometry-less products get a `p:`-prefixed composed-placement fingerprint
instead (`apps/viewer/src/lib/compare/geometryCapability.ts`), which the
engine's capability check deliberately does not count as mesh geometry.

Three facts follow, and each constrains the `geometry` node:

1. **Placement and shape are fused.** The hash cannot separate "moved" from
   "reshaped"; the content pass separates them with the `aabb`, and only for
   matched pairs. 02 §2.3's vocabulary has `placement` and `geometry:<tier>` as
   separate components. Hashing the engine's value into one node would give a
   node that changes on every move, which puts placement inside geometry.
2. **The hash is per occurrence.** Being world-space, one type's mapped
   representation placed N times yields N different hashes. Deduplication of
   shared geometry, the property 02 §2.4 gets "for free" for property sets,
   does not arise from this hash at all.
3. **The hash is 64-bit and not collision-resistant.** A `geometry` node whose
   only field is this value inherits that: its BLAKE3 address would be
   collision-resistant over a field that is not. Index §6.1's requirement that
   an attacker-supplied IFC must not be able to forge a node id would not hold
   for geometry.

**`geometry:<tier>` is two different things today.** In `@ifc-lite/merge`,
`geometry:<tier>` is derived from an IFCX `usd::` attribute
(`packages/merge/src/component-state.ts`). That is the authored geometry
representation's namespace, not a tessellation level. In the engine there is
no tier at all: one world-space hash per entity. 02 §2.3 inherits the merge
spelling, so "tier" in this spec set should mean the representation
namespace.

**Open, and the options as they stand.** None is decided here:

- **(a) Leaf over the engine's hash.** Cheapest, and inherits all three
  limits above. It would at least make the object layer see corpus `r02`.
- **(b) Local-frame geometry plus a separate `placement` node.** Hash the
  representation in its own coordinate system, digest with BLAKE3, and carry
  the object placement as its own node. This restores deduplication and
  separates move from reshape. It needs a new hashing pass. The engine's world
  hash stays as it is, because the viewer's Compare depends on it.
- **(c) Representation items as nodes.** One node per representation item, or
  per authored `usd::` attribute for IFCX, with the element folding them.
  Finest localisation and largest node count. Its cost has not been measured.

(b) is the option that keeps the three properties 02 §2.4 claims for the rest
of the graph. Choosing it is a row 5 decision, with the geometry pipeline's
owners, and is not decided here.

## 3.7 Split, merge and successors

These two passes describe changes that no pairing can express. One wall becomes
three; a chair is swapped for another family in the same place. Both are
additive (§3.2), and both report evidence as a named profile rather than a
score:

- **Split / merge.** `verified` (containment plus complete volumes agreeing
  within tolerance), `extent` (containment plus per-axis coverage, volume
  missing and nothing refuted), `displaced` (a moved cluster matched by volume
  and congruent extents, unique both ways). A failed volume test refutes the
  claim; it does not fall back to a weaker profile.
- **Successors.** `footprint` (heavy box overlap, unique both ways) or
  `position` (same class family and container name path, mutual nearest with a
  ×2 margin). These are suggestions. Identity is minted only from claims a
  caller passes in as accepted.

For the layer adapter, these are **not** `identity_map` entries.
`identity_map` is 1:1 by construction, and a split is 1:k. The engine's
`lineageFromDiff` turns committed matches, split/merge claims and *accepted*
successors into `{ base[], head[], relation, reason, shares? }` records, and
`rekeyByLineage` carries keyed external data across under a stated policy.
Whether a delta layer records lineage, and in which part of the provenance
manifest, is `05-layer-adapter.md`'s question. The content of the layer does
not depend on the answer, because each split piece is an addition and the whole
is a tombstone either way.

## 3.8 The Rust port and its parity contract

**Byte-exactness is the contract, not equal verdicts.** `@ifc-lite/merge`
consumes `stableHash` for its component snapshots, so a Rust fingerprint that
differed from the TypeScript one by a single byte would surface as spurious
merge conflicts rather than as a failing test. `rust/diff/src/lib.rs` records
the three places the obvious Rust is wrong: UTF-16 code-unit order is not
codepoint order, ECMAScript number formatting is not Rust's `Display`, and
`JSON.stringify` preserves key order where `stableSerialize` sorts.

**The old engine is an oracle, never a fallback.** The pre-cutover TypeScript
engine lives in `packages/diff/test/oracle/`, outside `src`, excluded from the
published `dist` by an artifact inventory test, and never selected at runtime.
It exists to produce expectations:

```
packages/diff/test/oracle/*.ts          the preserved TypeScript algorithms
        │  run, never transcribed
        ▼
scripts/diff-parity-vectors.mjs         → rust/diff/tests/fingerprint_vectors.json
scripts/diff-core-vectors.mjs           → rust/diff/tests/core_vectors.json
scripts/diff-content-vectors.mjs        → rust/diff/tests/content_vectors.json
        │  consumed by
        ▼
rust/diff/tests/*_parity.rs             the Rust engine against the vectors
packages/diff/src/wasm-*.test.ts        the built WASM facade against the oracle
```

CI runs each generator with `--check` (`.github/workflows/test.yml`), so a
stale corpus fails rather than being silently re-blessed. A regenerated vector
file that differs is a behaviour change in one engine or the other, and needs
an explanation before it is committed.

**The oracle is not a pure historical snapshot.** Three statements were
corrected after the cutover and copied into the oracle from accepted `main`:
identity and lineage deduplication use structural JSON tuples (#8088, #8130),
and largest-share migration requires nonempty, finite, nonnegative evidence
(#8084, #8131). Parity is against the corrected oracle.

**What ifc-git must not inherit.** The UTF-16 ordering exists to reproduce V8
byte for byte, and is correct only for that compatibility format. 02 §2.5
already says the node encoding sorts NFC-normalized UTF-8 bytes. The two orders
disagree above the BMP, so `rust/git` reuses the engine's projection and must
not reuse its ordering or its hashes.

## 3.9 What the engine does not see

Stated as limits of the input, because the engine compares exactly what it is
given:

- **Relationships, beyond three projections.** Containment reaches it as a name
  path (`container`), type assignment by name and class, and materials and
  classifications as resolved name bags. Aggregation, voiding, connections and
  every other `IfcRel*` are not fingerprinted. A changed `IfcRelVoidsElement`
  is invisible unless it moves the host's geometry.
- **Placement, separately from geometry.** Only through the world geometry
  hash, or a `p:` fingerprint for geometry-less products (§3.6).
- **Owner history.** Not hashed, on purpose. Authorship is evidence about a
  change, not part of the content that changed, and is `04-authorship.md`'s
  subject.
- **Array holes, in the object layer.** The engine counts absent indices as
  content (`SparseCollection`). `rust/git`'s adapter refuses a projection with
  holes (`AdapterError::Hole`) rather than collide it with the dense one, and
  that is correct until index §6.1's encoding question is answered.

The object layer currently addresses less than the engine compares:
`rust/git`'s adapter converts `DataFingerprintInput` only, so it has neither the
geometry the engine sees nor the containment the engine reports. §3.4's
proposal, that the object layer decides "changed", depends on closing that gap
first. The order that follows from it:

1. A `geometry` node, with §3.6's option decided.
2. A `placement` node, if (b) is chosen.
3. Relationship nodes, after 02 §2.8's equivalence policy is decided.

Until then, the engine's verdict is the more complete of the two, and an
ingest should not claim "no new version" on an entry comparison alone.

## 3.10 Decisions this document raises

None of these blocks the engine, which is shipped. Each belongs to a later
row:

| Question | Where it is decided |
| --- | --- |
| Does the object layer, rather than the engine's FNV verdict, decide whether a delivery changed? (§3.4) | row 5, with the commit object |
| Geometry node granularity: (a), (b) or (c)? (§3.6) | row 5, with the geometry pipeline's owners |
| Which content-match tiers an ingest accepts without review (§3.5) | `05-layer-adapter.md` (row 8) |
| Whether, and where, a delta layer records 1:k lineage (§3.7) | `05-layer-adapter.md` (row 8) |
