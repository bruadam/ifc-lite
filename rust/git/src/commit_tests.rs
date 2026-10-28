// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{AuthorStatus, Commit, CommitError, DiffSummary, Identity};
use crate::address::Address;
use crate::tree::{build_tree, TreeEntry};

fn person(name: &str) -> Identity {
    Identity {
        name: Some(name.to_owned()),
        organization: None,
        key: None,
    }
}

fn commit(parents: Vec<Address>, diff: DiffSummary) -> Commit {
    Commit {
        tree: Address::of(b"tree"),
        parents,
        blob: Some(Address::of(b"delivered bytes")),
        author: person("K07 lead"),
        author_status: AuthorStatus::Verified,
        committer: person("scheduled sync"),
        intent: "delivery v53".to_owned(),
        created_at: 1_770_022_800,
        software: "ifc-lite-git/23.6.0".to_owned(),
        diff,
    }
}

fn changed() -> DiffSummary {
    DiffSummary {
        added: 1,
        modified: 2,
        deleted: 0,
        unchanged: 100,
    }
}

fn unchanged() -> DiffSummary {
    DiffSummary {
        added: 0,
        modified: 0,
        deleted: 0,
        unchanged: 100,
    }
}

#[test]
fn a_well_formed_commit_validates() {
    assert_eq!(
        commit(vec![Address::of(b"parent")], changed()).validate(),
        Ok(())
    );
}

#[test]
fn an_empty_diff_against_a_parent_is_refused() {
    // The rule that makes a scheduled re-export idempotent. The caller points
    // the source revision at the existing commit instead.
    let c = commit(vec![Address::of(b"parent")], unchanged());
    assert_eq!(c.validate(), Err(CommitError::Empty));
}

#[test]
fn a_first_commit_may_have_an_empty_diff() {
    // There is nothing to compare an initial import against.
    let c = commit(Vec::new(), unchanged());
    assert_eq!(c.validate(), Ok(()));
}

#[test]
fn an_intent_is_required() {
    let mut c = commit(vec![Address::of(b"parent")], changed());
    c.intent = "   ".to_owned();
    assert_eq!(c.validate(), Err(CommitError::MissingIntent));
}

#[test]
fn an_unresolved_author_must_be_empty() {
    // The anti-fabrication rule: absent reads as unknown, invented gets
    // trusted. A status of Unresolved with a name filled in is the back door.
    let mut c = commit(vec![Address::of(b"parent")], changed());
    c.author_status = AuthorStatus::Unresolved;
    assert_eq!(c.validate(), Err(CommitError::UnresolvedWithAuthor));

    c.author = Identity::default();
    assert_eq!(
        c.validate(),
        Ok(()),
        "empty author with Unresolved is the valid shape"
    );
}

#[test]
fn a_resolved_status_needs_an_author() {
    let mut c = commit(vec![Address::of(b"parent")], changed());
    c.author = Identity::default();
    for status in [AuthorStatus::Verified, AuthorStatus::Inferred] {
        c.author_status = status;
        assert_eq!(c.validate(), Err(CommitError::AuthorStatusWithoutAuthor));
    }
}

#[test]
fn author_and_committer_are_separate_fields() {
    // A commit must be able to say the content is one person's and the upload
    // another's, which is the normal case for a synced delivery.
    let mut c = commit(vec![Address::of(b"parent")], changed());
    let with_author_only = c.address();
    c.committer = person("someone else");
    assert_ne!(
        with_author_only,
        c.address(),
        "changing the committer must change the commit"
    );
}

#[test]
fn parent_order_is_content() {
    // parents[0] is the mainline parent, so a merge commit's parents are a
    // list and not a set.
    let a = Address::of(b"a");
    let b = Address::of(b"b");
    assert_ne!(
        commit(vec![a, b], changed()).address(),
        commit(vec![b, a], changed()).address()
    );
}

#[test]
fn every_recorded_field_participates_in_the_address() {
    let base = commit(vec![Address::of(b"parent")], changed());
    let baseline = base.address();

    let mut tree = base.clone();
    tree.tree = Address::of(b"other tree");
    assert_ne!(baseline, tree.address(), "tree");

    let mut intent = base.clone();
    intent.intent = "different".to_owned();
    assert_ne!(baseline, intent.address(), "intent");

    let mut created = base.clone();
    created.created_at += 1;
    assert_ne!(baseline, created.address(), "created_at");

    let mut software = base.clone();
    software.software = "other".to_owned();
    assert_ne!(baseline, software.address(), "software");

    let mut status = base.clone();
    status.author_status = AuthorStatus::Inferred;
    assert_ne!(baseline, status.address(), "author_status");

    let mut summary = base.clone();
    summary.diff = DiffSummary {
        added: 9,
        ..changed()
    };
    assert_ne!(baseline, summary.address(), "diff summary");

    let mut blob = base.clone();
    blob.blob = None;
    assert_ne!(baseline, blob.address(), "blob");
}

#[test]
fn encoding_is_deterministic() {
    let c = commit(vec![Address::of(b"parent")], changed());
    assert_eq!(c.encode(), c.encode());
}

/// The clarification CodeRabbit earned on PR #8039: a re-GUID produces a
/// **different tree address** and an **empty diff**, so the emptiness test
/// cannot be tree equality — it has to be the diff. This pins that, because it
/// is the one place the two could be confused.
#[test]
fn a_reguid_yields_a_new_tree_and_is_still_refused_as_empty() {
    let node = Address::of(b"unchanged content");
    let before = build_tree(vec![TreeEntry {
        key: "ORIGINAL".to_owned(),
        node,
        ifc_type: "IfcWall".to_owned(),
    }])
    .0;
    let after = build_tree(vec![TreeEntry {
        key: "REGENERATED".to_owned(),
        node,
        ifc_type: "IfcWall".to_owned(),
    }])
    .0;

    assert_ne!(
        before.address(),
        after.address(),
        "the key moved, so the tree moved"
    );

    // And yet nothing changed, so no commit may be written.
    let mut attempt = commit(vec![Address::of(b"parent")], unchanged());
    attempt.tree = after.address();
    assert_eq!(
        attempt.validate(),
        Err(CommitError::Empty),
        "a different tree address must not be mistaken for a change"
    );
}

#[test]
fn diff_summary_emptiness_ignores_unchanged_count() {
    assert!(DiffSummary {
        added: 0,
        modified: 0,
        deleted: 0,
        unchanged: 9_999
    }
    .is_empty());
    assert!(!DiffSummary {
        added: 0,
        modified: 1,
        deleted: 0,
        unchanged: 0
    }
    .is_empty());
    assert!(!DiffSummary {
        added: 0,
        modified: 0,
        deleted: 1,
        unchanged: 0
    }
    .is_empty());
    assert!(!DiffSummary {
        added: 1,
        modified: 0,
        deleted: 0,
        unchanged: 0
    }
    .is_empty());
}
