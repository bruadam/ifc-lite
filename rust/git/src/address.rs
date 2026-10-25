// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Content addresses, and the canonical writer every object is hashed through.
//!
//! An address is `blake3:<64 hex>`. The tagged spelling is the repo's existing
//! convention — `computeLayerId` and `computeStackHash` in
//! `packages/ifcx/src/canonical.ts` emit the same shape — so an address is
//! self-describing and a future algorithm change is visible rather than silent.
//!
//! BLAKE3 over SHA-256 for throughput at model scale, and over the faster
//! non-cryptographic options because a content address must be
//! collision-resistant: an attacker-supplied IFC must not be able to forge a
//! node id that collides with one already in the store.

use std::fmt;

/// Algorithm tag carried by every address this crate mints.
pub const ADDRESS_ALGORITHM: &str = "blake3";

/// A content address: the digest of an object's canonical encoding.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Address([u8; 32]);

impl Address {
    /// Hash a canonical byte stream.
    pub fn of(bytes: &[u8]) -> Self {
        Address(*blake3::hash(bytes).as_bytes())
    }

    /// The raw digest.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// `blake3:<64 hex>`, the form that goes on the wire and into a manifest.
    pub fn tagged(&self) -> String {
        let mut out = String::with_capacity(ADDRESS_ALGORITHM.len() + 1 + 64);
        out.push_str(ADDRESS_ALGORITHM);
        out.push(':');
        for byte in self.0 {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }

    /// Parse a tagged address. Rejects a different algorithm rather than
    /// guessing, so a format migration cannot read as a corrupt digest.
    pub fn parse(tagged: &str) -> Result<Self, AddressError> {
        let (algorithm, hex) = tagged
            .split_once(':')
            .ok_or(AddressError::Untagged)?;
        if algorithm != ADDRESS_ALGORITHM {
            return Err(AddressError::Algorithm(algorithm.to_owned()));
        }
        if hex.len() != 64 {
            return Err(AddressError::Length(hex.len()));
        }
        let mut bytes = [0u8; 32];
        for (index, pair) in hex.as_bytes().chunks_exact(2).enumerate() {
            let text = std::str::from_utf8(pair).map_err(|_| AddressError::NotHex)?;
            bytes[index] = u8::from_str_radix(text, 16).map_err(|_| AddressError::NotHex)?;
        }
        Ok(Address(bytes))
    }
}

impl fmt::Debug for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.tagged())
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.tagged())
    }
}

/// Why a tagged address could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddressError {
    /// No `<algorithm>:` prefix.
    Untagged,
    /// A tag this crate does not mint.
    Algorithm(String),
    /// Wrong number of hex digits.
    Length(usize),
    /// A digit outside `0-9a-f`.
    NotHex,
}

impl fmt::Display for AddressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AddressError::Untagged => write!(f, "address is missing an `<algorithm>:` prefix"),
            AddressError::Algorithm(found) => {
                write!(f, "address algorithm {found:?} is not {ADDRESS_ALGORITHM:?}")
            }
            AddressError::Length(found) => {
                write!(f, "address needs 64 hex digits, found {found}")
            }
            AddressError::NotHex => write!(f, "address contains a non-hex digit"),
        }
    }
}

impl std::error::Error for AddressError {}

/// The canonical byte writer.
///
/// Every object kind is encoded through this, so the framing rules live in one
/// place:
///
/// - **A fixed 6-byte header**: 4-byte ASCII magic, 1-byte kind tag, 1-byte
///   format version. A format change mints a new magic rather than reusing
///   this one, which is how `node-hash-v0` says a successor must announce
///   itself.
/// - **Counts precede members**, so a truncated stream cannot be mistaken for
///   a shorter valid one.
/// - **Strings are length-prefixed**, never terminated, so a string containing
///   any byte — a separator included — cannot be read as two fields. A
///   delimiter-based encoding has exactly this collision, and it is the defect
///   class tracked for the TypeScript side in #8088.
#[derive(Debug, Default)]
pub struct CanonicalWriter {
    buffer: Vec<u8>,
}

impl CanonicalWriter {
    /// Start an object: magic, kind tag, format version.
    pub fn new(magic: &[u8; 4], kind: u8, format_version: u8) -> Self {
        let mut buffer = Vec::with_capacity(64);
        buffer.extend_from_slice(magic);
        buffer.push(kind);
        buffer.push(format_version);
        CanonicalWriter { buffer }
    }

    /// A UTF-8 string, length-prefixed with its byte length.
    pub fn string(&mut self, value: &str) -> &mut Self {
        self.u32(value.len() as u32);
        self.buffer.extend_from_slice(value.as_bytes());
        self
    }

    /// An optional string. Absent and empty are **distinct**: absent writes a
    /// `0` tag and no payload, empty writes a `1` tag and a zero length.
    pub fn optional_string(&mut self, value: Option<&str>) -> &mut Self {
        match value {
            None => {
                self.buffer.push(0);
            }
            Some(text) => {
                self.buffer.push(1);
                self.string(text);
            }
        }
        self
    }

    /// A member count. Always written before the members it counts.
    pub fn u32(&mut self, value: u32) -> &mut Self {
        self.buffer.extend_from_slice(&value.to_le_bytes());
        self
    }

    /// A 64-bit integer, for timestamps.
    pub fn i64(&mut self, value: i64) -> &mut Self {
        self.buffer.extend_from_slice(&value.to_le_bytes());
        self
    }

    /// A child address, by its raw digest rather than its tagged string: the
    /// Merkle rule is over bytes, and the tag is presentation.
    pub fn address(&mut self, value: &Address) -> &mut Self {
        self.buffer.extend_from_slice(value.as_bytes());
        self
    }

    /// Finish, returning the object's address and its canonical bytes.
    pub fn finish(self) -> (Address, Vec<u8>) {
        (Address::of(&self.buffer), self.buffer)
    }
}

/// Sort key giving **UTF-16 code-unit order**.
///
/// `Vec<u16>` compares lexicographically on code units, which is exactly
/// JavaScript's string order — and deliberately not Rust's `Ord` on `&str`,
/// which compares UTF-8 bytes and therefore disagrees above the BMP (a
/// surrogate pair's units sort below `E000`, its codepoint above).
///
/// Why pay for that here, when this format has no JavaScript counterpart to
/// match: the spec set recommends promoting this encoding to `node-hash-v1.md`
/// under `@ifc-lite/provenance`, which is TypeScript. A format sorted by UTF-8
/// bytes could not be reimplemented there byte-identically, so the ordering is
/// chosen now to keep that door open. `rust/diff`'s `utf16` module carries the
/// full argument.
pub fn code_unit_key(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

#[cfg(test)]
#[path = "address_tests.rs"]
mod tests;
