// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{code_unit_key, Address, AddressError, CanonicalWriter, ADDRESS_ALGORITHM};

#[test]
fn tagged_form_round_trips() {
    let address = Address::of(b"hello");
    let tagged = address.tagged();
    assert!(tagged.starts_with("blake3:"));
    assert_eq!(tagged.len(), "blake3:".len() + 64);
    assert_eq!(Address::parse(&tagged).expect("round trip"), address);
}

#[test]
fn equal_bytes_give_equal_addresses() {
    assert_eq!(Address::of(b"a"), Address::of(b"a"));
    assert_ne!(Address::of(b"a"), Address::of(b"b"));
}

#[test]
fn a_different_algorithm_is_refused_rather_than_guessed() {
    // A format migration must read as a migration, not as corruption.
    let err = Address::parse(&format!("sha256:{}", "0".repeat(64))).expect_err("must refuse");
    assert_eq!(err, AddressError::Algorithm("sha256".to_owned()));
}

#[test]
fn malformed_addresses_are_refused() {
    assert_eq!(Address::parse("nocolon").unwrap_err(), AddressError::Untagged);
    assert_eq!(
        Address::parse("blake3:abc").unwrap_err(),
        AddressError::Length(3)
    );
    assert_eq!(
        Address::parse(&format!("blake3:{}", "z".repeat(64))).unwrap_err(),
        AddressError::NotHex
    );
}

#[test]
fn algorithm_tag_is_the_one_we_mint() {
    assert_eq!(ADDRESS_ALGORITHM, "blake3");
    assert!(Address::of(b"x").tagged().starts_with(ADDRESS_ALGORITHM));
}

#[test]
fn header_participates_in_the_address() {
    // A kind tag is hashed, so two objects with identical payloads but
    // different kinds cannot collide. If this ever passed, every kind would
    // share an address space.
    let (left, _) = CanonicalWriter::new(b"IGN1", 1, 0).finish();
    let (right, _) = CanonicalWriter::new(b"IGN1", 2, 0).finish();
    assert_ne!(left, right);

    let (other_magic, _) = CanonicalWriter::new(b"IGT1", 1, 0).finish();
    assert_ne!(left, other_magic, "magic must participate too");
}

#[test]
fn length_prefixing_stops_field_confusion() {
    // Two strings concatenated must not encode like one longer string. A
    // delimiter-based encoding has exactly this collision.
    let mut a = CanonicalWriter::new(b"IGN1", 1, 0);
    a.string("ab").string("c");
    let mut b = CanonicalWriter::new(b"IGN1", 1, 0);
    b.string("a").string("bc");
    assert_ne!(a.finish().0, b.finish().0);
}

#[test]
fn absent_and_empty_strings_are_distinguishable() {
    let mut absent = CanonicalWriter::new(b"IGN1", 1, 0);
    absent.optional_string(None);
    let mut empty = CanonicalWriter::new(b"IGN1", 1, 0);
    empty.optional_string(Some(""));
    assert_ne!(
        absent.finish().0,
        empty.finish().0,
        "an absent value must not hash like an empty one"
    );
}

#[test]
fn code_unit_key_is_utf16_order_not_rust_order() {
    // The reason this helper exists. In JavaScript "\u{E000}" > "\u{10000}";
    // under Rust's own `Ord` on `&str` the comparison flips, because a
    // surrogate pair's code units sort below E000 while its codepoint sorts
    // above. Verified against V8:
    //   node -e 'console.log("" < "\u{10000}")'  ->  false
    let private_use = "\u{E000}";
    let astral = "\u{10000}";
    assert!(code_unit_key(private_use) > code_unit_key(astral));
    assert!(private_use < astral, "Rust's own order disagrees");
}

#[test]
fn code_unit_key_orders_ascii_conventionally() {
    assert!(code_unit_key("A") < code_unit_key("a"));
    assert!(code_unit_key("ab") < code_unit_key("abc"));
    assert_eq!(code_unit_key("abc"), code_unit_key("abc"));
}
