# 03: ifc-git Applied — States as Refs, Acceptance as a Gate

Part of the [cde-lite research set](index.md). Research, not a proposal.

## 1. The mapping that makes this cheap

[ifc-git](../ifc-git/index.md) already maps delivery onto git concepts:
an organisation is a project, a repository is a model file stream, and a commit
is computed from the **diff against its parent** rather than from file bytes.

ISO 19650's container states then land on git's existing machinery almost
exactly, which is the reason this is worth doing at all:

| ISO 19650 | ifc-git | Why it fits |
| --- | --- | --- |
| Work in progress | A task team's branch | Private to the originator, rewritable, no audit obligation |
| Shared | A ref with a suitability code | Visible to the delivery team, immutable once issued |
| Published | A **protected** ref, advanced only through a gate | Requires authorisation; the gate is the review |
| Archived | Ancestor commits, still reachable | Nothing is deleted; history *is* the archive |

The appeal is that three 19650 properties stop being features to build and
become consequences of the storage model:

- **Append-only audit** — a commit DAG is append-only by construction.
- **Nothing is deleted** — superseded versions remain reachable ancestors.
- **Tamper evidence** — a content-addressed commit cannot be altered without
  changing its address and every descendant's.

## 2. What a "revision" is, and the thing no other CDE can do

In a file-based CDE, uploading a file produces a revision. In cde-lite,
**a delivery produces a revision only if the diff against its parent is
non-empty.**

ifc-git already specifies this: no empty commits, and the test is the diff
rather than the tree address. The consequence for a CDE is the headline
behaviour of the whole product:

> A contractor re-exports from their authoring tool with no changes. Every
> `GlobalId` is regenerated and the header timestamp moves, so the file is
> byte-different. cde-lite records **no new revision**, because nothing
> semantic changed — and says so, with the measurement.

Measured on the ifc-git corpus: a re-export reads as **+39 / −39** when entities
are paired by `GlobalId`, and **0 / 0 / 0** once identity is content-derived.
Every mainstream CDE would record that as a new revision requiring review.

This single behaviour is worth more to a reviewer's time than any feature in the
rest of this research set.

## 3. Acceptance as a merge gate

The code-forge analogy earns its keep here. Advancing the Published ref is a
**pull request**, and the gate has required checks:

1. **IDS validation passes** against the project's exchange information
   requirements (`02` §6). Mechanical, reproducible, evidence-producing.
2. **Container naming conforms**, or a non-conformance is explicitly accepted
   by the authoriser.
3. **The change set has been reviewed** — not the file. Reviewers see added,
   modified and deleted elements grouped by component key (`attr:core`,
   `pset:<Name>`, `geometry:<tier>`), which is the vocabulary ifc-git's diff
   already emits.
4. **Authorisation is recorded** with actor, time, suitability code transition,
   and the check results as attached evidence.

Compare-and-swap on the ref gives the concurrency property for free: two
authorisers advancing Published simultaneously cannot both win, and the loser is
told why rather than silently overwriting.

## 4. Where the analogy stops, and must be seen to stop

Four places. Each has bitten someone who pushed the git metaphor too far.

- **Merge is advisory, not automatic.** ifc-git is explicit that merge is
  advisory while rebase is real. Two task teams editing the same elements is a
  **coordination problem between organisations**, not a textual conflict a
  three-way merge can resolve. cde-lite must present overlap as a coordination
  finding for humans, never auto-resolve geometry.
- **Authorship is evidence, not identity.** Per the ifc-git authorship work,
  `OwningUser` is ownership and origin evidence while `LastModifyingUser` is
  modification evidence, and **neither is a commit author on its own**. Owner
  history records only the *last* modifier, so a container touched by two
  parties retains no trace of the first. Commit-level responsibility is a policy
  over that evidence; in a CDE, the authenticated uploading account is better
  evidence than anything in the file.
- **Rewriting shared history is not available.** A task team may rewrite its
  own WIP branch. Once a container is Shared it is referenced by other teams'
  coordination, and once Published it is contractual. Force-push has no
  CDE equivalent above WIP.
- **A repository is a model stream, not a project.** A real project has many
  containers from many originators. The organisational layer sits *above*
  ifc-git and is cde-lite's actual subject.

## 5. What cde-lite needs from ifc-git that does not exist yet

Stated plainly because it is the sequencing risk in `index.md` §9:

| Needed | ifc-git status (2026-10-26) |
| --- | --- |
| Object store, loose and packed tiers | `07-storage.md` planned, not written |
| Refs with compare-and-swap | Designed; `MemoryRefStore` only, no persistence |
| Commit, branch, log operations | Designed, not implemented |
| Digest and canonical encoding | **Decided** — BLAKE3, specified in `rust/git` |
| Node and tree model | Implemented on an external branch |
| Diff as the commit computer | In-tree and byte-exact (#8042) |

So the foundation is real where it matters most (diff, nodes, digest) and absent
exactly where a CDE depends on it (persistence, refs, operations). **Nothing in
this document can be built before ifc-git has a persistent object store and
refs**, and attempting it would mean inventing a second storage layer that then
has to be retired.

## 6. Open questions

1. **Granularity of a repository.** One per container, one per model stream, or
   one per project? Per-container is simplest and loses cross-container
   coordination history; per-project is the opposite. Undecided.
2. **Do non-model containers enter ifc-git at all?** A PDF has no graph. It
   probably belongs in content-addressed blob storage with the same version and
   state metadata but no diff — which means two version models in one registry,
   and that needs designing rather than assuming.
3. **Does Shared get a ref per suitability code?** `refs/shared/S2` and
   `refs/shared/S4` is tempting and may multiply refs faster than it clarifies
   anything.
4. **Retention versus append-only.** 19650 wants nothing deleted; data
   protection law sometimes requires exactly that. A content-addressed
   append-only store makes real erasure genuinely hard, and this tension is
   unresolved here — see `05-multitenancy.md` §6.
