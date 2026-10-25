// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_diff::input::{
    DataFingerprintInput, PropertyEntryInput, PropertySetInput, PropertyValue, TypeAssignmentInput,
};
use ifc_lite_diff::JsString;

use super::{entity_nodes, AdapterError};
use crate::address::Address;
use crate::node::{Node, NodeKind};

fn js(value: &str) -> JsString {
    value.into()
}

fn wall() -> DataFingerprintInput {
    DataFingerprintInput {
        ifc_type: js("IfcWall"),
        name: Some(js("W-01")),
        ..DataFingerprintInput::default()
    }
}

fn pset(name: &str, members: &[(&str, PropertyValue)]) -> PropertySetInput {
    PropertySetInput {
        name: js(name),
        properties: members
            .iter()
            .map(|(n, v)| PropertyEntryInput { name: js(n), value: v.clone() })
            .collect(),
    }
}

fn component(nodes: &super::EntityNodes, key: &str) -> Option<Address> {
    match nodes.nodes.last().expect("element is last") {
        Node::Element { components, .. } => {
            components.iter().find(|c| c.key == key).map(|c| c.node)
        }
        other => panic!("expected an element node last, got {other:?}"),
    }
}

/// The headline invariant: a key reaches the tree entry and nothing else.
#[test]
fn the_key_does_not_reach_any_node() {
    let input = wall();
    let first = entity_nodes("ORIGINAL-GUID", &input).expect("converts");
    let second = entity_nodes("REGENERATED-GUID", &input).expect("converts");

    assert_eq!(
        first.nodes.iter().map(Node::address).collect::<Vec<_>>(),
        second.nodes.iter().map(Node::address).collect::<Vec<_>>(),
        "a re-GUID must not move a single node address"
    );
    assert_eq!(first.entry.node, second.entry.node);
    assert_ne!(first.entry.key, second.entry.key, "only the entry key differs");
}

#[test]
fn an_element_node_is_produced_last_with_its_components() {
    let mut input = wall();
    input.property_sets = vec![pset("Pset_WallCommon", &[("IsExternal", PropertyValue::Bool(true))])];
    let converted = entity_nodes("K", &input).expect("converts");

    assert_eq!(
        converted.nodes.last().expect("non-empty").kind(),
        NodeKind::Element
    );
    assert!(component(&converted, "attr:core").is_some());
    assert!(component(&converted, "pset:Pset_WallCommon").is_some());
    assert_eq!(converted.entry.ifc_type, "IfcWall");
    assert_eq!(converted.entry.key, "K");
}

/// Change localisation, through the adapter rather than hand-built nodes.
#[test]
fn editing_one_property_moves_that_pset_and_the_element_only() {
    let untouched = pset("Pset_Other", &[("X", PropertyValue::Number(1.0))]);
    let mut before = wall();
    before.property_sets = vec![
        pset("Pset_WallCommon", &[("FireRating", PropertyValue::String(js("EI60")))]),
        untouched.clone(),
    ];
    let mut after = wall();
    after.property_sets = vec![
        pset("Pset_WallCommon", &[("FireRating", PropertyValue::String(js("EI90")))]),
        untouched,
    ];

    let a = entity_nodes("K", &before).expect("converts");
    let b = entity_nodes("K", &after).expect("converts");

    assert_ne!(
        component(&a, "pset:Pset_WallCommon"),
        component(&b, "pset:Pset_WallCommon"),
        "the edited set moved"
    );
    assert_eq!(
        component(&a, "pset:Pset_Other"),
        component(&b, "pset:Pset_Other"),
        "the untouched set did not"
    );
    assert_eq!(
        component(&a, "attr:core"),
        component(&b, "attr:core"),
        "attributes did not"
    );
    assert_ne!(a.entry.node, b.entry.node, "the element moved, since it folds the child");
}

#[test]
fn an_absent_name_bag_produces_no_component() {
    let converted = entity_nodes("K", &wall()).expect("converts");
    assert!(component(&converted, "material").is_none());
    assert!(component(&converted, "classification").is_none());
    assert!(component(&converted, "type-assignment").is_none());
}

#[test]
fn an_empty_name_bag_hashes_like_an_absent_one() {
    // Absent and empty are one case, matching the diff engine: an
    // unconditional key would have moved every material-less entity.
    let mut empty = wall();
    empty.materials = Vec::new();
    assert_eq!(
        entity_nodes("K", &wall()).expect("converts").entry.node,
        entity_nodes("K", &empty).expect("converts").entry.node
    );
}

#[test]
fn a_material_bag_produces_a_component_whose_order_is_irrelevant() {
    let mut forward = wall();
    forward.materials = vec![js("steel"), js("concrete")];
    let mut reverse = wall();
    reverse.materials = vec![js("concrete"), js("steel")];
    assert_eq!(
        entity_nodes("K", &forward).expect("converts").entry.node,
        entity_nodes("K", &reverse).expect("converts").entry.node
    );
}

#[test]
fn a_type_assignment_is_identified_by_class_and_name() {
    let mut input = wall();
    input.type_assignments = vec![TypeAssignmentInput {
        name: Some(js("WT-200")),
        type_name: Some(js("IfcWallType")),
    }];
    let converted = entity_nodes("K", &input).expect("converts");
    assert!(component(&converted, "type-assignment").is_some());

    // Renaming the assigned type moves the component; the input carries no
    // GlobalId at all, which is the structural half of "never by GlobalId".
    let mut renamed = input.clone();
    renamed.type_assignments[0].name = Some(js("WT-300"));
    assert_ne!(
        component(&converted, "type-assignment"),
        component(&entity_nodes("K", &renamed).expect("converts"), "type-assignment")
    );
}

#[test]
fn numbers_are_carried_not_rendered() {
    let make = |value: f64| {
        let mut input = wall();
        input.property_sets = vec![pset("P", &[("V", PropertyValue::Number(value))])];
        entity_nodes("K", &input).expect("converts").entry.node
    };
    assert_eq!(make(0.1), make(0.1));
    assert_ne!(make(0.1), make(0.2));
    // A value no short decimal renders exactly still round-trips, because the
    // encoder writes bits rather than text.
    assert_ne!(make(1.0 / 3.0), make(0.333_333_333_333_333_3_f64 + f64::EPSILON));
}

#[test]
fn non_finite_numbers_become_distinct_tokens() {
    let make = |value: PropertyValue| {
        let mut input = wall();
        input.property_sets = vec![pset("P", &[("V", value)])];
        entity_nodes("K", &input).expect("converts").entry.node
    };
    let nan = make(PropertyValue::Number(f64::NAN));
    let pos = make(PropertyValue::Number(f64::INFINITY));
    let neg = make(PropertyValue::Number(f64::NEG_INFINITY));
    let absent = make(PropertyValue::Null);

    // All four distinct. The one that matters is that none equals `absent`:
    // JSON maps every non-finite to `null`, which is also what an absent value
    // produces, and an equal hash is treated as content identity downstream.
    for (label, value) in [("NaN", nan), ("+inf", pos), ("-inf", neg)] {
        assert_ne!(value, absent, "{label} must not hash like an absent value");
    }
    assert_ne!(nan, pos);
    assert_ne!(pos, neg);
}

#[test]
fn absent_and_empty_text_are_distinguishable() {
    let make = |value: PropertyValue| {
        let mut input = wall();
        input.property_sets = vec![pset("P", &[("V", value)])];
        entity_nodes("K", &input).expect("converts").entry.node
    };
    assert_ne!(make(PropertyValue::Null), make(PropertyValue::String(js(""))));
}

/// An unpaired surrogate is refused, not coerced.
#[test]
fn a_malformed_string_is_refused_rather_than_collapsed() {
    // A lone high surrogate has no scalar form, so no `&str` and no NFC form.
    // The lossy conversion would map it to the replacement character and
    // collapse genuinely distinct names into one node.
    let lone = JsString::from_units(vec![0xD800]);
    assert!(lone.as_str().is_none(), "premise: this has no &str form");

    let mut input = wall();
    input.property_sets = vec![PropertySetInput { name: lone, properties: Vec::new() }];
    assert_eq!(
        entity_nodes("K", &input),
        Err(AdapterError::NotWellFormed { field: "pset name" })
    );
}

#[test]
fn a_malformed_attribute_is_refused_too() {
    let mut input = wall();
    input.name = Some(JsString::from_units(vec![0xDC00]));
    assert_eq!(
        entity_nodes("K", &input),
        Err(AdapterError::NotWellFormed { field: "name" })
    );
}

#[test]
fn conversion_is_deterministic() {
    let mut input = wall();
    input.property_sets = vec![pset("P", &[("A", PropertyValue::Number(1.0))])];
    input.materials = vec![js("steel")];
    let first = entity_nodes("K", &input).expect("converts");
    let second = entity_nodes("K", &input).expect("converts");
    assert_eq!(first, second);
}
