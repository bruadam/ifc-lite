# cde-lite: A Self-Hostable, Diff-Native CDE on ifc-lite

**Research and PRD set: Draft v0.1, exploratory. Owner: Bruno Adam.**

> **Status: research, not a proposal.** Nothing here is implemented, nothing is
> scheduled, and none of it has been offered upstream. This set exists to think
> the problem through before any code is written, and to record *why* each
> choice was made so a later reader can disagree with the reasoning rather than
> guess at it.

## 1. North star

A **Common Data Environment** that treats an IFC delivery as a *graph with a
history*, not a file with a viewer bolted on.

Every CDE in the market stores information containers as opaque blobs and
answers "what is the latest revision?" None of them answer the question
delivery teams actually ask:

> *What changed between the revision I approved and the one you just shared, at
> element level, and who is answerable for it?*

They cannot, because they diff bytes. A re-export from an authoring tool
regenerates `GlobalId`s and rewrites the header clock, so a byte-level view
reports a total rewrite where nothing semantic changed. Measured on the
[ifc-git revision corpus](../ifc-git/index.md): **+39 / −39 when paired by
`GlobalId`, 0 / 0 / 0 once identity is content-derived.**

That gap is the entire product thesis. cde-lite is the CDE whose unit of
review is the **change**, not the file.

Three commitments follow:

1. **Diff-native.** Acceptance, approval and audit attach to semantic change
   sets. A re-export that changed nothing creates no revision at all.
2. **ISO 19650 by construction.** Container states, suitability and revision
   codes, and the audit trail are first-class in the data model and the API —
   not metadata conventions layered on by each deployment.
3. **Self-hostable, single-tenant as a degenerate case of multi-tenant.** One
   codebase. A team of three runs it on one box; a platform operator runs it
   for many organisations. No feature exists only in the hosted build.

## 2. Why this is worth building at all

The honest case against is strong and is recorded in §9. The case for rests on
one asymmetry: **the hard part of a CDE is not the IFC part, and the IFC part is
where ifc-lite is already years ahead.**

A CDE's table stakes — storage, permissions, transmittals, markups, forms,
mobile — are commodity work that incumbents do at scale. But all of them stop at
the file boundary. ifc-lite already has, in-tree:

| Capability | Package |
| --- | --- |
| IFC parse, geometry, 3D viewer | `parser`, `geometry`, `renderer`, `viewer` |
| Semantic diff, element and component level | `diff`, `ifcdiff`, `model-match` |
| Graph version control (in design) | [`ifc-git`](../ifc-git/index.md), `rust/git` |
| IDS validation, every facet and constraint type | `ids`, `ids-authoring` |
| BCF 2.1 topics, comments, viewpoints | `bcf`, `bcf-api` |
| OpenCDE Foundation and Documents API clients | `opencde-foundation`, `documents-api` |
| Collaboration sync with roles and audit log | `collab`, `collab-server` |
| CDE connectors | the `source-*` packages |

Nothing in that list is the *CDE*. Everything in it is the part a CDE cannot do.

## 3. The posture change this requires

**Today ifc-lite is a sophisticated *client* of other people's CDEs.** Every
OpenCDE package in the table above consumes a remote API. cde-lite inverts
that: it becomes a *provider*.

That inversion is where the cost lives, and naming it early is the point of this
section. Being a provider means owning: a tenancy and identity model, a
container registry with state transitions, an approval workflow, an immutable
audit trail, retention and legal hold, and an operational surface with uptime
obligations. None of that is IFC work.

**The strategy that keeps this tractable is to be compatible rather than
competitive.** cde-lite should speak the OpenCDE APIs as a server, so it
interoperates with the CDEs the `source-*` connectors already talk to. The goal
is to be the diff and acceptance brain that can *also* stand alone — not to win
a feature war over markups and mobile apps.

## 4. Reading map

| Document | Subject |
| --- | --- |
| [`01-research-opencde.md`](01-research-opencde.md) | What the Foundation and Documents APIs actually specify, their measured limitations, and what "improved" has to mean |
| [`02-iso19650.md`](02-iso19650.md) | Container states, suitability and revision codes, audit requirements, and how they map onto a data model |
| [`03-version-control.md`](03-version-control.md) | ifc-git applied: 19650 states as protected refs, acceptance as a merge gate |
| [`04-api-design.md`](04-api-design.md) | PRD for the improved Documents and Foundation surface |
| [`05-multitenancy.md`](05-multitenancy.md) | Tenancy model, isolation tiers, content-addressed storage and its cross-tenant hazard, residency |
| [`06-viewer-ux.md`](06-viewer-ux.md) | PRD for the viewer-centric interface |
| [`07-self-hosting.md`](07-self-hosting.md) | PRD for deployment: one binary, one compose file, no SaaS dependency |

## 5. Scope

**In scope:** information containers and their lifecycle; semantic change
review and acceptance; IDS validation as an acceptance gate; BCF topics anchored
to elements and viewpoints; OpenCDE server endpoints; multi-tenant identity and
access; self-hosted deployment; audit trail.

**Explicitly out of scope**, so the surface stays finishable:

- **Document management for non-model containers** beyond store-version-approve.
  No drawing-register workflows, no transmittal paperwork, no RFI or submittal
  modules. A CDE-lite that tries to be a document-control product loses.
- **Authoring.** cde-lite reviews and accepts; it does not edit models. The
  `layer-prs` work covers in-ifc-lite editing and is a different spec set.
- **Scheduling, cost, procurement.** Not information management.
- **Mobile and offline-first.** A responsive viewer is in scope; native apps
  are not.
- **Being a certification authority.** We implement 19650 *structures*; we do
  not issue compliance claims on anyone's behalf (§9).

## 6. Open decisions

These are the questions this research set exists to answer, and none should be
treated as settled by the documents that follow.

1. **Is the tenant an organisation or a project?** Construction projects span
   companies, so the answer shapes identity, billing and access control. See
   `05-multitenancy.md` §2, which argues for organisation with cross-tenant
   project membership, and states what that costs.
2. **Does cross-tenant content-addressed deduplication ship?** It is nearly
   free and it leaks existence of content across tenants. `05` §5 recommends
   refusing it by default and says why the saving is tempting.
3. **How much of the OpenCDE wire format do we preserve?** Strict compatibility
   buys interop with existing clients and inherits the limitations catalogued in
   `01`. The proposal in `04` is a versioned second surface alongside a
   conformant 1.0 one — but carrying two is a real cost.
4. **Postgres only, or embedded single-file as well?** Self-hosting argues for
   the second; operational sanity argues for the first. `07` §3.
5. **Does acceptance require ifc-git maturity first?** Stated plainly: yes, and
   it is the main sequencing risk (§9).
6. **Can cde-lite claim "nothing changed" at all?** Not unconditionally, and
   this is not cde-lite's decision to make. ifc-git's occurrence-equivalence
   policy is open (`../ifc-git/02-graph-object-model.md` §2.8), and until it is
   decided the diff-is-empty test is silent on a real change in any model
   containing coincident duplicates — see `03-version-control.md` §2, which is
   the feature this whole research set is built on.

## 7. Relationship to the spec sets that already exist

| Spec set | Versions | Boundary with cde-lite |
| --- | --- | --- |
| [ifc-git](../ifc-git/index.md) | Whole delivered IFC files, as commits computed from diffs | cde-lite *consumes* ifc-git. It is the storage and history engine; cde-lite is the organisational layer — tenants, projects, states, approvals |
| [Layer PRs](../layer-prs/index.md) | Edits made *inside* ifc-lite, as IFCX overlay deltas | Different direction: authoring, not delivery acceptance. A cde-lite container could hold a layer-PR result, but the two do not overlap |
| `commit-history` | File revisions read from a commit service | Closest existing neighbour; cde-lite would supersede the parts of it that duplicate a container registry |

The analogy worth holding: **ifc-git is to cde-lite what git is to a code
forge.** It also carries the analogy's warning — a forge's value is workflow and
network effects, not the version-control plumbing underneath. Most of the work
here is the forge, and the forge is the part that is hard to get right.

## 8. Delivery shape

Deliberately not a schedule. Each row is a slice that is independently useful,
so the thing can stop at any row and still have earned its keep.

| # | Slice | Earns its keep by |
| --- | --- | --- |
| 1 | This research set | Deciding the open questions in §6 before code |
| 2 | Container registry + states + audit, single tenant, no UI | Being a 19650-conformant store with an API |
| 3 | ifc-git storage behind it | Revisions that are diffs, not blobs |
| 4 | Viewer-centric change review | The differentiated surface |
| 5 | IDS acceptance gate | Machine-checked delivery requirements |
| 6 | OpenCDE server endpoints | Interop with existing CDE clients |
| 7 | Multi-tenancy | Hosting for more than one organisation |
| 8 | BCF anchored to change sets | Issues that point at elements, not screenshots |

Rows 2 and 3 are the ones that must be right. Everything after is additive.

## 9. Risks, stated rather than discovered later

- **The differentiator is gated on someone else's open decision.** The
  no-revision-for-a-no-op-re-export behaviour is the product thesis, and it is
  conditional on ifc-git's occurrence-equivalence policy being resolved. That is
  a maintainer decision in another spec set. A research set may depend on an
  open question; a roadmap may not, and this one does.
- **Sequencing.** ifc-git decided its digest on 2026-10-26; storage and refs are
  not built. Building a CDE on an immature versioning core multiplies risk
  instead of adding it. Row 3 above should not start before ifc-git's object
  store and refs are real.
- **Focus.** A CDE is a product with operations, security obligations and
  on-call. ifc-lite is a library collection. This changes what the project *is*,
  and the review bandwidth of a small maintainer team is already the binding
  constraint on delivery.
- **Breadth competition.** If cde-lite is judged as a general CDE it loses:
  incumbents have markups, forms, transmittals, mobile, SSO directories and
  years of workflow accretion. The only defensible position is depth on change.
- **Compliance expectation.** Implementing ISO 19650 structures invites the
  reading that a deployment *is* 19650-compliant. Compliance is a property of an
  organisation's processes, not of software. `02` §7 states the limit explicitly
  and it must stay stated in any user-facing material.
- **Licence hygiene.** BIMserver — the most natural thing to learn from — is
  AGPL-3.0, and its network clause would reach a hosted cde-lite. Designs and
  concepts are free to study; **no code may be copied into this MPL-2.0 tree.**
  The same discipline the ifc-git set applies to git and libgit2.
