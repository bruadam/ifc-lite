// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Graph-based version control for IFC.
//!
//! Spec set: `docs/architecture/ifc-git/`. This crate is the object layer —
//! nodes, trees, commits, an object store and refs. The diff that computes a
//! commit lives in `ifc-lite-diff`; the ingestion that calls both is above.
//!
//! # Three decisions, and where each one lives
//!
//! **1. The versioned object is the IFC graph, not the file.** History is a DAG
//! of graph states. [`node`] holds the vertices.
//!
//! **2. Identity is content and structural position, not `GlobalId`.** A node's
//! address is the digest of its content plus its children's addresses, and the
//! entity key lives in the [`tree`] that points at the node. So a from-scratch
//! re-export that regenerates every `GlobalId` rewrites tree keys and leaves
//! every node address untouched.
//!
//! This is also the one place this crate departs from `node-hash-v0` in
//! `packages/provenance`, which folds the entity `key` into the `element` node
//! and therefore cannot deliver it. See [`node`] for the detail and the spec
//! set's index §6.1 for the open question of where the encoding should finally
//! live.
//!
//! **3. A change belongs to the node that carries it.** Edit one property
//! inside one property set and the property-set node's address moves; the
//! owning element's address moves because it encodes that child address; and
//! nothing else moves. The element is *marked* at `pset:<Name>`, not blamed.
//! A set shared by many occurrences is therefore one node change plus N
//! markers.
//!
//! # Evidence, not assertion
//!
//! `tools/ifc-git-corpus` derives a ten-revision chain from a committed model
//! and measures each step. Its re-export revision regenerates all 116
//! `GlobalId`s: paired by key that is 39 added and 39 deleted, and under
//! content-derived identity it is nothing at all. That gap is why this crate
//! addresses content rather than keys.
//!
//! # What is not here yet
//!
//! The verb surface (`status`, `commit`, `branch`, `diff <a> <b>`, `log`,
//! `pull`, `push`), a durable store, and rebase. [`adapter`] converts one
//! entity's content projection; geometry and relationship nodes are not
//! produced yet, because `DataFingerprintInput` carries neither.
//!
//! Also not settled: the equivalence policy for coincident duplicates. A
//! [`node::Node::Relationship`] names its endpoints by node address, so two
//! occurrences identical in every component share one endpoint even though
//! the source names them by distinct `GlobalId`s. That is information dropped
//! in projection, and the spec set holds the policy **open**
//! (`02-graph-object-model.md` §2.8); it also makes the no-empty-commit rule
//! in [`commit`] conditional (§2.7).

pub mod adapter;
pub mod address;
pub mod commit;
pub mod node;
pub mod store;
pub mod tree;

pub use address::{Address, AddressError, ADDRESS_ALGORITHM};
pub use commit::{AuthorStatus, Commit, CommitError, DiffSummary, Identity};
pub use adapter::{entity_nodes, AdapterError, EntityNodes};
pub use node::{Component, Field, FieldValue, Node, NodeKind, Role, SetKind};
pub use store::{
    MemoryObjectStore, MemoryRefStore, ObjectStore, RefError, RefKind, RefStore, RefTarget,
    StoreError,
};
pub use tree::{build_tree, Tree, TreeChunk, TreeEntry};
