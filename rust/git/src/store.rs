// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The object store, and refs with compare-and-swap.
//!
//! Both are traits with an in-memory implementation. The platform supplies a
//! durable one; a filesystem one follows for the CLI. One shared conformance
//! expectation is what stops "works for my backend" divergence — the pattern
//! `packages/source-fixture/src/conformance/` already uses for providers.

use std::collections::HashMap;

use crate::address::Address;

/// Why a store operation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// Asked for an object the store does not hold.
    NotFound(Address),
    /// The bytes under an address do not hash to it. A store that cannot
    /// detect this is not content-addressed, it is a map.
    Corrupt { expected: Address, actual: Address },
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NotFound(address) => write!(f, "object {address} not found"),
            StoreError::Corrupt { expected, actual } => {
                write!(f, "object {expected} hashes to {actual}")
            }
        }
    }
}

impl std::error::Error for StoreError {}

/// An append-only, content-addressed object store.
///
/// Writes are idempotent by construction: the address IS the content, so
/// storing the same bytes twice is a no-op rather than a conflict. That is what
/// makes a retried ingestion safe without an idempotency key at this layer.
pub trait ObjectStore {
    /// Store canonical bytes, returning their address. Storing twice is a
    /// no-op.
    fn put(&mut self, bytes: &[u8]) -> Address;

    /// Read an object back, verifying it hashes to the address asked for.
    fn get(&self, address: &Address) -> Result<&[u8], StoreError>;

    /// Is the object present? Cheaper than [`ObjectStore::get`] when the bytes
    /// are not wanted — the question a tree asks about its chunks.
    fn contains(&self, address: &Address) -> bool;

    /// How many distinct objects are held. Deduplication makes this smaller
    /// than the number of `put` calls, which is the point.
    fn len(&self) -> usize;

    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// In-memory store, for tests and for a single-process run.
#[derive(Debug, Default)]
pub struct MemoryObjectStore {
    objects: HashMap<Address, Vec<u8>>,
}

impl MemoryObjectStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ObjectStore for MemoryObjectStore {
    fn put(&mut self, bytes: &[u8]) -> Address {
        let address = Address::of(bytes);
        // `entry` rather than `insert`: identical content must not rewrite the
        // stored bytes, so a corrupt write cannot overwrite a good one.
        self.objects.entry(address).or_insert_with(|| bytes.to_vec());
        address
    }

    fn get(&self, address: &Address) -> Result<&[u8], StoreError> {
        let bytes = self
            .objects
            .get(address)
            .ok_or(StoreError::NotFound(*address))?;
        let actual = Address::of(bytes);
        if actual != *address {
            return Err(StoreError::Corrupt { expected: *address, actual });
        }
        Ok(bytes)
    }

    fn contains(&self, address: &Address) -> bool {
        self.objects.contains_key(address)
    }

    fn len(&self) -> usize {
        self.objects.len()
    }
}

/// What a ref points at, and what kind of ref it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefTarget {
    pub commit: Address,
    pub kind: RefKind,
}

/// A branch may move; a tag may not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefKind {
    Branch,
    Tag,
}

/// Why a ref update was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefError {
    /// The ref does not point where the caller believed. This is the whole of
    /// the concurrency control: two deliveries built on one parent mean the
    /// second is refused and must be rebased.
    StaleParent {
        name: String,
        expected: Option<Address>,
        actual: Option<Address>,
    },
    /// A tag is immutable once set.
    TagImmutable(String),
    /// Asked about a ref that does not exist.
    NoSuchRef(String),
}

impl std::fmt::Display for RefError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RefError::StaleParent { name, expected, actual } => {
                let show = |a: &Option<Address>| {
                    a.map(|x| x.tagged()).unwrap_or_else(|| "<unset>".to_owned())
                };
                write!(
                    f,
                    "ref {name:?} expected {} but holds {}",
                    show(expected),
                    show(actual)
                )
            }
            RefError::TagImmutable(name) => write!(f, "tag {name:?} may not move"),
            RefError::NoSuchRef(name) => write!(f, "no such ref {name:?}"),
        }
    }
}

impl std::error::Error for RefError {}

/// Mutable named pointers at immutable commits.
pub trait RefStore {
    /// Where a ref points, or `None` if it does not exist.
    fn get(&self, name: &str) -> Option<&RefTarget>;

    /// Move a ref, but only if it currently points where the caller expects.
    ///
    /// `expected` is `None` to create a ref that must not already exist. This
    /// is the compare-and-swap that makes concurrent ingestion safe, and the
    /// reason a commit records the parent it was computed against.
    fn compare_and_set(
        &mut self,
        name: &str,
        expected: Option<Address>,
        target: RefTarget,
    ) -> Result<(), RefError>;

    /// Every ref, for a listing. Order is unspecified; callers that display
    /// them sort.
    fn list(&self) -> Vec<(&str, &RefTarget)>;
}

/// In-memory refs, for tests and for a single-process run.
#[derive(Debug, Default)]
pub struct MemoryRefStore {
    refs: HashMap<String, RefTarget>,
}

impl MemoryRefStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl RefStore for MemoryRefStore {
    fn get(&self, name: &str) -> Option<&RefTarget> {
        self.refs.get(name)
    }

    fn compare_and_set(
        &mut self,
        name: &str,
        expected: Option<Address>,
        target: RefTarget,
    ) -> Result<(), RefError> {
        let current = self.refs.get(name);
        if let Some(existing) = current {
            if existing.kind == RefKind::Tag {
                return Err(RefError::TagImmutable(name.to_owned()));
            }
        }
        let actual = current.map(|t| t.commit);
        if actual != expected {
            return Err(RefError::StaleParent {
                name: name.to_owned(),
                expected,
                actual,
            });
        }
        self.refs.insert(name.to_owned(), target);
        Ok(())
    }

    fn list(&self) -> Vec<(&str, &RefTarget)> {
        self.refs.iter().map(|(k, v)| (k.as_str(), v)).collect()
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
