// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{
    MemoryObjectStore, MemoryRefStore, ObjectStore, RefError, RefKind, RefStore, RefTarget,
    StoreError,
};
use crate::address::Address;

fn branch(commit: Address) -> RefTarget {
    RefTarget { commit, kind: RefKind::Branch }
}

#[test]
fn put_returns_the_content_address() {
    let mut store = MemoryObjectStore::new();
    let address = store.put(b"canonical bytes");
    assert_eq!(address, Address::of(b"canonical bytes"));
    assert_eq!(store.get(&address).expect("stored"), b"canonical bytes");
}

#[test]
fn storing_the_same_bytes_twice_is_a_no_op() {
    // This is what makes a retried ingestion safe without an idempotency key
    // at this layer: the address IS the content.
    let mut store = MemoryObjectStore::new();
    let first = store.put(b"same");
    let second = store.put(b"same");
    assert_eq!(first, second);
    assert_eq!(store.len(), 1);
}

#[test]
fn distinct_content_is_stored_separately() {
    let mut store = MemoryObjectStore::new();
    store.put(b"a");
    store.put(b"b");
    assert_eq!(store.len(), 2);
}

#[test]
fn a_missing_object_is_reported_rather_than_defaulted() {
    let store = MemoryObjectStore::new();
    let absent = Address::of(b"never stored");
    assert_eq!(store.get(&absent), Err(StoreError::NotFound(absent)));
    assert!(!store.contains(&absent));
}

#[test]
fn contains_agrees_with_get() {
    let mut store = MemoryObjectStore::new();
    let address = store.put(b"x");
    assert!(store.contains(&address));
    assert!(store.get(&address).is_ok());
}

#[test]
fn an_empty_store_reports_empty() {
    let store = MemoryObjectStore::new();
    assert!(store.is_empty());
    assert_eq!(store.len(), 0);
}

#[test]
fn creating_a_ref_requires_that_it_not_exist() {
    let mut refs = MemoryRefStore::new();
    let first = Address::of(b"c1");
    assert_eq!(refs.compare_and_set("main", None, branch(first)), Ok(()));
    assert_eq!(refs.get("main").map(|t| t.commit), Some(first));

    // A second create must fail: `None` means "must not already exist".
    let err = refs
        .compare_and_set("main", None, branch(Address::of(b"c2")))
        .expect_err("must refuse");
    assert!(matches!(err, RefError::StaleParent { .. }));
}

/// The whole of the concurrency control: two deliveries built on one parent
/// mean the second is refused and has to rebase.
#[test]
fn a_stale_parent_is_refused() {
    let mut refs = MemoryRefStore::new();
    let base = Address::of(b"base");
    refs.compare_and_set("main", None, branch(base)).expect("create");

    let first = Address::of(b"first delivery");
    refs.compare_and_set("main", Some(base), branch(first)).expect("fast-forward");

    // A second delivery that was computed against `base` no longer applies.
    let second = Address::of(b"second delivery");
    match refs.compare_and_set("main", Some(base), branch(second)) {
        Err(RefError::StaleParent { name, expected, actual }) => {
            assert_eq!(name, "main");
            assert_eq!(expected, Some(base));
            assert_eq!(actual, Some(first));
        }
        other => panic!("expected a stale-parent refusal, got {other:?}"),
    }

    // The ref did not move.
    assert_eq!(refs.get("main").map(|t| t.commit), Some(first));
}

#[test]
fn a_rebased_delivery_then_succeeds() {
    let mut refs = MemoryRefStore::new();
    let base = Address::of(b"base");
    let first = Address::of(b"first");
    let second = Address::of(b"second, recomputed");
    refs.compare_and_set("main", None, branch(base)).expect("create");
    refs.compare_and_set("main", Some(base), branch(first)).expect("first");
    // Recomputed against the new head, it applies.
    assert_eq!(refs.compare_and_set("main", Some(first), branch(second)), Ok(()));
    assert_eq!(refs.get("main").map(|t| t.commit), Some(second));
}

#[test]
fn a_tag_may_not_move() {
    let mut refs = MemoryRefStore::new();
    let pinned = Address::of(b"milestone");
    refs.compare_and_set(
        "udbud",
        None,
        RefTarget { commit: pinned, kind: RefKind::Tag },
    )
    .expect("create tag");

    let err = refs
        .compare_and_set("udbud", Some(pinned), branch(Address::of(b"later")))
        .expect_err("a tag is immutable");
    assert_eq!(err, RefError::TagImmutable("udbud".to_owned()));
    assert_eq!(refs.get("udbud").map(|t| t.commit), Some(pinned));
}

#[test]
fn an_absent_ref_reads_as_none_rather_than_erroring() {
    let refs = MemoryRefStore::new();
    assert!(refs.get("nope").is_none());
}

#[test]
fn listing_returns_every_ref() {
    let mut refs = MemoryRefStore::new();
    refs.compare_and_set("main", None, branch(Address::of(b"m"))).expect("main");
    refs.compare_and_set("delivery/sync-v53", None, branch(Address::of(b"d")))
        .expect("delivery");
    let mut names: Vec<&str> = refs.list().into_iter().map(|(name, _)| name).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["delivery/sync-v53", "main"]);
}

#[test]
fn branches_are_independent() {
    let mut refs = MemoryRefStore::new();
    let main = Address::of(b"main head");
    let delivery = Address::of(b"delivery head");
    refs.compare_and_set("main", None, branch(main)).expect("main");
    refs.compare_and_set("delivery/sync-v53", None, branch(delivery)).expect("delivery");

    // Moving one must not disturb the other.
    let moved = Address::of(b"moved");
    refs.compare_and_set("delivery/sync-v53", Some(delivery), branch(moved))
        .expect("move delivery");
    assert_eq!(refs.get("main").map(|t| t.commit), Some(main));
    assert_eq!(refs.get("delivery/sync-v53").map(|t| t.commit), Some(moved));
}
