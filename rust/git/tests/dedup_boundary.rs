// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Where content-addressed deduplication stops being free, measured.
//!
//! Content-only node addresses mean two entities with identical content share
//! one address. A review of the spec set (PR #8039) raised the consequence for
//! relationships: a `relationship` node names its endpoints by node address,
//! so if two distinct occurrences dedupe, a relationship naming one names both
//! — and the spec claimed cardinality and identity survive, which is true at
//! the tree layer and needed proving at the node layer.
//!
//! These tests draw the boundary exactly, because prose was not going to
//! settle it:
//!
//! 1. Two occurrences differing **only in placement** do not dedupe, so the
//!    ordinary case has no ambiguity at all.
//! 2. Dedup requires identity in **every** component, placement included —
//!    genuinely coincident duplicates, which is a modelling defect.
//! 3. Two relationships over coincident duplicates do collapse to one node.
//! 4. The **tree still carries both keys**, so cardinality is not lost. This is
//!    git's own arrangement: two identical files are two tree entries pointing
//!    at one blob.
//!
//! What remains genuinely unanswerable is "which of two indistinguishable
//! coincident openings does this void target" — a question with no observable
//! answer, since the two differ in nothing a model records. The limit that does
//! bite: a consumer reconstructing from nodes alone, bypassing the tree, would
//! see one occurrence where there are two. Reconstruction goes through the
//! tree, because that is where keys live.

use ifc_lite_git::address::Address;
use ifc_lite_git::tree::{build_tree, TreeEntry};
use ifc_lite_git::{Component, Field, Node, Role, SetKind};

/// A placement component at a given X offset.
fn placement_at(x: &str) -> Address {
    Node::Set {
        kind: SetKind::Property,
        name: "placement".to_owned(),
        members: vec![Field { name: "X".to_owned(), value: Some(x.to_owned()) }],
    }
    .address()
}

/// An opening whose only component is its placement.
fn opening_at(x: &str) -> Node {
    Node::Element {
        ifc_type: "IfcOpeningElement".to_owned(),
        components: vec![Component { key: "placement".to_owned(), node: placement_at(x) }],
    }
}

fn voids(target: Address) -> Node {
    Node::Relationship {
        ifc_type: "IfcRelVoidsElement".to_owned(),
        roles: vec![Role {
            name: "RelatedOpeningElement".to_owned(),
            targets: vec![target],
        }],
    }
}

#[test]
fn occurrences_differing_only_in_placement_do_not_dedupe() {
    // The ordinary case: two openings in one wall are at different positions,
    // so they carry different placement components and never collide. This is
    // why the dedup concern is narrow rather than general.
    let first = opening_at("0");
    let second = opening_at("1000");
    assert_ne!(first.address(), second.address());

    // And so their voids stay distinct too.
    assert_ne!(
        voids(first.address()).address(),
        voids(second.address()).address()
    );
}

#[test]
fn dedup_requires_identity_in_every_component() {
    // Adding any distinguishing component separates them again, so an adapter
    // that projects placement — which the component vocabulary provides for —
    // cannot produce an accidental collapse.
    let bare = Node::Element {
        ifc_type: "IfcOpeningElement".to_owned(),
        components: vec![Component { key: "placement".to_owned(), node: placement_at("0") }],
    };
    let with_pset = Node::Element {
        ifc_type: "IfcOpeningElement".to_owned(),
        components: vec![
            Component { key: "placement".to_owned(), node: placement_at("0") },
            Component {
                key: "pset:Pset_OpeningElementCommon".to_owned(),
                node: Address::of(b"anything"),
            },
        ],
    };
    assert_ne!(bare.address(), with_pset.address());
}

#[test]
fn coincident_duplicates_share_one_node_address() {
    // The residual case, and it is a modelling defect: two openings identical
    // in every recorded component, including placement.
    let first = opening_at("0");
    let second = opening_at("0");
    assert_eq!(first.address(), second.address());
}

#[test]
fn relationships_over_coincident_duplicates_collapse() {
    // Stated so the consequence is visible rather than surprising.
    let first = opening_at("0");
    let second = opening_at("0");
    assert_eq!(
        voids(first.address()).address(),
        voids(second.address()).address(),
        "identical relationships over identical endpoints are one node"
    );
}

/// The resolution: cardinality lives in the tree, not in the node layer.
#[test]
fn the_tree_preserves_cardinality_that_the_node_layer_collapses() {
    let first = opening_at("0");
    let second = opening_at("0");
    let void_a = voids(first.address());
    let void_b = voids(second.address());

    let (tree, chunks) = build_tree(vec![
        TreeEntry {
            key: "OPENING-A".to_owned(),
            node: first.address(),
            ifc_type: "IfcOpeningElement".to_owned(),
        },
        TreeEntry {
            key: "OPENING-B".to_owned(),
            node: second.address(),
            ifc_type: "IfcOpeningElement".to_owned(),
        },
        TreeEntry {
            key: "VOID-A".to_owned(),
            node: void_a.address(),
            ifc_type: "IfcRelVoidsElement".to_owned(),
        },
        TreeEntry {
            key: "VOID-B".to_owned(),
            node: void_b.address(),
            ifc_type: "IfcRelVoidsElement".to_owned(),
        },
    ]);

    // Four named things.
    assert_eq!(tree.entry_count, 4, "the tree names every occurrence");

    // Referencing two distinct nodes, because the duplicates deduplicated.
    let distinct: std::collections::HashSet<Address> = chunks
        .iter()
        .flat_map(|chunk| chunk.entries.iter().map(|entry| entry.node))
        .collect();
    assert_eq!(
        distinct.len(),
        2,
        "two openings and two voids collapse to two nodes"
    );

    // This is exactly git's arrangement for two identical files, and it is why
    // the spec's cardinality claim holds at the layer that makes it.
}

/// Deleting one of two coincident duplicates is a change, and the emptiness
/// test must see it.
///
/// Raised in review: if "the diff is empty" were evaluated over the set of
/// *distinct* node addresses, this case would read as no change — the surviving
/// duplicate still carries the same address, so the distinct set is identical.
/// The test has to be over the tree's `key -> node` entries, where multiplicity
/// is visible, which is what a keyed diff produces and what `DiffSummary`
/// counts.
#[test]
fn deleting_one_coincident_duplicate_is_not_an_empty_diff() {
    use ifc_lite_git::{AuthorStatus, Commit, CommitError, DiffSummary, Identity};

    let shared = opening_at("0").address();
    let entry = |key: &str| TreeEntry {
        key: key.to_owned(),
        node: shared,
        ifc_type: "IfcOpeningElement".to_owned(),
    };

    let (before, _) = build_tree(vec![entry("OPENING-A"), entry("OPENING-B")]);
    let (after, _) = build_tree(vec![entry("OPENING-A")]);

    // The set of DISTINCT node addresses is identical across the two versions:
    // one address, before and after. Judging emptiness on that would be wrong.
    assert_eq!(before.entry_count, 2);
    assert_eq!(after.entry_count, 1);
    assert_ne!(before.address(), after.address());

    // A keyed diff sees the deletion, so the commit is accepted.
    let deletion = Commit {
        tree: after.address(),
        parents: vec![Address::of(b"parent")],
        blob: None,
        author: Identity::default(),
        author_status: AuthorStatus::Unresolved,
        committer: Identity { name: Some("sync".to_owned()), ..Identity::default() },
        intent: "remove a duplicate opening".to_owned(),
        created_at: 0,
        software: "test".to_owned(),
        diff: DiffSummary { added: 0, modified: 0, deleted: 1, unchanged: 1 },
    };
    assert_eq!(deletion.validate(), Ok(()));

    // And the same tree pair with an empty summary is still refused, so the
    // guard is the summary rather than the tree pair.
    let mut empty = deletion.clone();
    empty.diff = DiffSummary { added: 0, modified: 0, deleted: 0, unchanged: 2 };
    assert_eq!(empty.validate(), Err(CommitError::Empty));
}
