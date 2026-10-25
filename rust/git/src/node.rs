// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Nodes: the vertices of the versioned IFC graph.
//!
//! A node exists where a change should be **attributable on its own**;
//! everything else is a field of its owner. See
//! `docs/architecture/ifc-git/02-graph-object-model.md` §2.2.
//!
//! # The one thing this does differently from node-hash v0
//!
//! v0 encodes the `element` node as "header, `key` (string — the entity's
//! stable identity, typically `GlobalId`), `ifcType`, `componentCount`, then
//! components sorted by `componentKey`". The key is **inside the hashed byte
//! stream**, so a from-scratch re-export that regenerates every `GlobalId`
//! changes every element address, and therefore every tree and commit — the
//! exact case GUID-agnostic identity exists to prevent.
//!
//! Here the key is **not** hashed. A node address is its content; the key lives
//! in the [`crate::tree`] that points at it. That is git's arrangement — a blob
//! is content, a tree maps names to blobs, two identical files share one blob —
//! and it makes a re-GUID a change of tree keys and no change of node
//! addresses. Measured end to end by `tools/ifc-git-corpus`: 116 regenerated
//! `GlobalId`s, 39 added and 39 deleted when paired by key, nothing at all once
//! identity is content-derived.

use crate::address::{code_unit_key, Address, CanonicalWriter};

/// Magic announcing this node format. A wire-format change mints a new one.
pub const NODE_MAGIC: &[u8; 4] = b"IGN1";
/// Format version within [`NODE_MAGIC`].
pub const NODE_FORMAT_VERSION: u8 = 0;

/// What a node is.
///
/// Tags are stable and may not be renumbered: a tag is part of the hashed
/// header, so changing one rewrites every address of that kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum NodeKind {
    /// One element's folded components. Composite.
    Element = 1,
    /// A named set of properties. Shared by many occurrences through
    /// `IfcRelDefinesByProperties`, which is why it is a node: one edit must be
    /// one change, not N.
    PropertySet = 2,
    /// A named set of quantities. Same argument.
    QuantitySet = 3,
    /// A named IFC relationship. Its identity is its endpoints.
    Relationship = 4,
    /// Tessellated or parametric geometry for one element, by tier.
    Geometry = 5,
    /// A resolved name bag: materials or classification references.
    NameBag = 6,
}

/// One scalar field of a node, as a name/value pair.
///
/// Values are already normalised to text by the caller. Numbers in particular
/// must be rendered before they reach here, because a float's text form is a
/// decision (ECMAScript rendering, in this repo's case) and not one this
/// module should make silently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub name: String,
    pub value: Option<String>,
}

/// One component of an element: a key and the address of the node carrying it.
///
/// The key vocabulary is shared with `@ifc-lite/diff` and `@ifc-lite/merge` —
/// `attr:core`, `pset:<Name>`, `qset:<Name>`, `type-assignment`, `material`,
/// `classification`, `placement`, `geometry:<tier>`, `child:<name>` — so diff
/// keys and op keys have one spelling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Component {
    pub key: String,
    pub node: Address,
}

/// A node, before it is addressed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    /// A fold of component addresses. **Carries no key** — see the module docs.
    Element {
        /// Exact IFC EXPRESS PascalCase class, e.g. `IfcWallStandardCase`.
        ifc_type: String,
        components: Vec<Component>,
    },
    /// A named set of scalar members.
    Set {
        kind: SetKind,
        name: String,
        members: Vec<Field>,
    },
    /// A relationship: a class and its roles, each role a set of targets.
    Relationship {
        ifc_type: String,
        roles: Vec<Role>,
    },
    /// Geometry for one tier, addressed by the digest the geometry pass already
    /// produces rather than re-hashed here.
    Geometry { tier: String, digest: String },
    /// A bag of resolved names: materials, classification references.
    NameBag { kind: String, names: Vec<String> },
}

/// Which set kind a [`Node::Set`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetKind {
    Property,
    Quantity,
}

/// One relationship role and the nodes it points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Role {
    pub name: String,
    pub targets: Vec<Address>,
}

impl Node {
    /// The kind tag written into the header.
    pub fn kind(&self) -> NodeKind {
        match self {
            Node::Element { .. } => NodeKind::Element,
            Node::Set { kind: SetKind::Property, .. } => NodeKind::PropertySet,
            Node::Set { kind: SetKind::Quantity, .. } => NodeKind::QuantitySet,
            Node::Relationship { .. } => NodeKind::Relationship,
            Node::Geometry { .. } => NodeKind::Geometry,
            Node::NameBag { .. } => NodeKind::NameBag,
        }
    }

    /// Canonical bytes and the resulting address.
    ///
    /// Sets are sorted; lists whose order is content are not. Sorting is by
    /// UTF-16 code unit (see [`code_unit_key`]), so input order can never
    /// reach the hash and two machines agree.
    pub fn encode(&self) -> (Address, Vec<u8>) {
        let mut w = CanonicalWriter::new(NODE_MAGIC, self.kind() as u8, NODE_FORMAT_VERSION);
        match self {
            Node::Element { ifc_type, components } => {
                w.string(ifc_type);
                let mut sorted: Vec<&Component> = components.iter().collect();
                sorted.sort_by_key(|c| code_unit_key(&c.key));
                w.u32(sorted.len() as u32);
                for component in sorted {
                    w.string(&component.key);
                    w.address(&component.node);
                }
            }
            Node::Set { kind: _, name, members } => {
                w.string(name);
                let mut sorted: Vec<&Field> = members.iter().collect();
                // Name first, then value, so two members sharing a name are
                // still totally ordered and input order cannot leak in.
                sorted.sort_by(|a, b| {
                    code_unit_key(&a.name)
                        .cmp(&code_unit_key(&b.name))
                        .then_with(|| {
                            optional_key(a.value.as_deref()).cmp(&optional_key(b.value.as_deref()))
                        })
                });
                w.u32(sorted.len() as u32);
                for field in sorted {
                    w.string(&field.name);
                    w.optional_string(field.value.as_deref());
                }
            }
            Node::Relationship { ifc_type, roles } => {
                w.string(ifc_type);
                let mut sorted: Vec<&Role> = roles.iter().collect();
                sorted.sort_by_key(|r| code_unit_key(&r.name));
                w.u32(sorted.len() as u32);
                for role in sorted {
                    w.string(&role.name);
                    // A role's members are a set: sorted by digest, so the
                    // order the caller walked its references in is invisible.
                    let mut targets = role.targets.clone();
                    targets.sort();
                    w.u32(targets.len() as u32);
                    for target in &targets {
                        w.address(target);
                    }
                }
            }
            Node::Geometry { tier, digest } => {
                w.string(tier);
                w.string(digest);
            }
            Node::NameBag { kind, names } => {
                w.string(kind);
                // Duplicates are kept: cardinality is content.
                let mut sorted: Vec<&String> = names.iter().collect();
                sorted.sort_by_key(|n| code_unit_key(n));
                w.u32(sorted.len() as u32);
                for name in sorted {
                    w.string(name);
                }
            }
        }
        w.finish()
    }

    /// The node's content address.
    pub fn address(&self) -> Address {
        self.encode().0
    }
}

/// Sort key for an optional string that keeps absent and empty apart.
///
/// `None` sorts below every `Some`, including `Some("")`. Collapsing the two
/// would make a member's absence indistinguishable from an empty value in the
/// ordering, which the encoding is careful to distinguish in its bytes.
fn optional_key(value: Option<&str>) -> (u8, Vec<u16>) {
    match value {
        None => (0, Vec::new()),
        Some(text) => (1, code_unit_key(text)),
    }
}

#[cfg(test)]
#[path = "node_tests.rs"]
mod tests;
