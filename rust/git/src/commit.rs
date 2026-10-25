// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Commits: one accepted version, immutable and content-addressed.
//!
//! Two rules carry more weight here than in git, and both come from the fact
//! that re-exporting an unchanged IFC produces different bytes:
//!
//! - **No empty commits.** An unchanged re-export produces no commit at all.
//!   git refuses empty commits by default; here it matters more, because an
//!   unchanged re-export is the *common* case, not an edge one. The caller is
//!   expected to record the source revision as pointing at the existing
//!   commit, so a scheduled sync is idempotent without inventing history.
//! - **Author is not committer.** The author is responsible for the content and
//!   is resolved from the file; the committer performed the upload. An
//!   unresolved author stays **empty** rather than being filled in with the
//!   uploader — the repo's existing rule, stated at
//!   `packages/collab/src/snapshot/from-ifcx.ts`: "Absent reads as unknown;
//!   invented gets trusted."

use crate::address::{sort_key, Address, CanonicalWriter};

/// Magic announcing the commit format.
pub const COMMIT_MAGIC: &[u8; 4] = b"IGM1";
/// Format version within [`COMMIT_MAGIC`].
pub const COMMIT_FORMAT_VERSION: u8 = 0;

/// How confidently an author was resolved.
///
/// Mirrors the ladder in the spec set: a person matched in the file or a
/// confirmed alias is `Verified`; an organisation plus a responsibility rule is
/// `Inferred`; anything else is `Unresolved` and leaves the author empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AuthorStatus {
    Unresolved = 0,
    Inferred = 1,
    Verified = 2,
}

/// Who someone is, as far as a commit records it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Identity {
    pub name: Option<String>,
    pub organization: Option<String>,
    /// Stable account or member key, where one exists. Pseudonymous by
    /// intention: an author name read out of an IFC is personal data, so
    /// history should refer to a key and an alias table rather than embed the
    /// spelling it found.
    pub key: Option<String>,
}

/// Change counts against `parents[0]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DiffSummary {
    pub added: u32,
    pub modified: u32,
    pub deleted: u32,
    pub unchanged: u32,
}

impl DiffSummary {
    /// Did anything change? A commit whose summary is empty must not be
    /// written — see [`CommitError::Empty`].
    pub fn is_empty(&self) -> bool {
        self.added == 0 && self.modified == 0 && self.deleted == 0
    }
}

/// A commit, before it is addressed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commit {
    /// Address of this version's [`crate::tree::Tree`].
    pub tree: Address,
    /// `parents[0]` is the mainline parent. Empty for the first commit. More
    /// than one means a merge, which only overlay repositories produce.
    pub parents: Vec<Address>,
    /// Address of the delivered bytes, kept so a version is reproducible and a
    /// signature over the original delivery stays checkable.
    pub blob: Option<Address>,
    /// Responsible for the content. Empty when `author_status` is
    /// `Unresolved` — never the uploader.
    pub author: Identity,
    pub author_status: AuthorStatus,
    /// Who or what performed the upload.
    pub committer: Identity,
    /// Why this version exists.
    pub intent: String,
    /// Seconds since the Unix epoch. No clock is read here: `SystemTime::now`
    /// is unavailable on `wasm32-unknown-unknown`, which is the same reason
    /// `rust/export`'s STEP writer takes a timestamp rather than reading one.
    pub created_at: i64,
    /// What computed this commit, for provenance.
    pub software: String,
    pub diff: DiffSummary,
}

/// Why a commit was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitError {
    /// Nothing changed against the parent. The caller should point the source
    /// revision at the existing commit instead.
    Empty,
    /// A commit must say why it exists.
    MissingIntent,
    /// `author_status` claims a resolution the `author` does not carry.
    AuthorStatusWithoutAuthor,
    /// An author was supplied while claiming it was unresolved, which would let
    /// a guessed attribution in through the back door.
    UnresolvedWithAuthor,
}

impl std::fmt::Display for CommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommitError::Empty => write!(
                f,
                "refusing an empty commit: nothing changed against the parent"
            ),
            CommitError::MissingIntent => write!(f, "a commit needs a non-empty intent"),
            CommitError::AuthorStatusWithoutAuthor => write!(
                f,
                "author_status claims a resolution but the author is empty"
            ),
            CommitError::UnresolvedWithAuthor => write!(
                f,
                "author_status is Unresolved but an author was supplied"
            ),
        }
    }
}

impl std::error::Error for CommitError {}

impl Commit {
    /// Check the rules a commit has to satisfy before it can be written.
    ///
    /// Separate from [`Commit::encode`] on purpose: encoding is a pure
    /// function of the record, and a caller that has already validated should
    /// not pay for it twice or be able to skip it by accident.
    pub fn validate(&self) -> Result<(), CommitError> {
        if self.intent.trim().is_empty() {
            return Err(CommitError::MissingIntent);
        }
        // An empty diff is only refusable against a parent. A first commit
        // legitimately has nothing to compare with.
        if !self.parents.is_empty() && self.diff.is_empty() {
            return Err(CommitError::Empty);
        }
        let has_author = self.author.name.is_some()
            || self.author.organization.is_some()
            || self.author.key.is_some();
        match self.author_status {
            AuthorStatus::Unresolved if has_author => Err(CommitError::UnresolvedWithAuthor),
            AuthorStatus::Inferred | AuthorStatus::Verified if !has_author => {
                Err(CommitError::AuthorStatusWithoutAuthor)
            }
            _ => Ok(()),
        }
    }

    /// Canonical bytes and address. Does not validate — call
    /// [`Commit::validate`] first.
    pub fn encode(&self) -> (Address, Vec<u8>) {
        let mut w = CanonicalWriter::new(COMMIT_MAGIC, 0, COMMIT_FORMAT_VERSION);
        w.address(&self.tree);
        // Parent ORDER is content: `parents[0]` is the mainline. Not sorted.
        w.u32(self.parents.len() as u32);
        for parent in &self.parents {
            w.address(parent);
        }
        match &self.blob {
            None => {
                w.u32(0);
            }
            Some(blob) => {
                w.u32(1);
                w.address(blob);
            }
        }
        encode_identity(&mut w, &self.author);
        w.u32(self.author_status as u32);
        encode_identity(&mut w, &self.committer);
        w.string(&self.intent);
        w.i64(self.created_at);
        w.string(&self.software);
        w.u32(self.diff.added);
        w.u32(self.diff.modified);
        w.u32(self.diff.deleted);
        w.u32(self.diff.unchanged);
        w.finish()
    }

    pub fn address(&self) -> Address {
        self.encode().0
    }
}

fn encode_identity(w: &mut CanonicalWriter, identity: &Identity) {
    w.optional_string(identity.name.as_deref());
    w.optional_string(identity.organization.as_deref());
    w.optional_string(identity.key.as_deref());
}

/// Sort key for an identity, where a listing needs a stable order.
pub fn identity_key(identity: &Identity) -> Vec<u8> {
    sort_key(
        identity
            .key
            .as_deref()
            .or(identity.name.as_deref())
            .unwrap_or(""),
    )
}

#[cfg(test)]
#[path = "commit_tests.rs"]
mod tests;
