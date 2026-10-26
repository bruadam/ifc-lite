# 04: PRD — The Improved Documents and Foundation Surface

Part of the [cde-lite research set](index.md). PRD, not a specification.

## 1. Problem

[`01-research-opencde.md`](01-research-opencde.md) catalogues seven places where
OpenCDE Documents API 1.0 stops short of what a CDE needs. The two that make
everything else impossible: **a version carries no content digest**, so
"unchanged" is unrepresentable; and **metadata has no vocabulary**, so the ISO
19650 fields that define a CDE have no interoperable meaning.

## 2. Goals and non-goals

**Goals.** Content-addressed versions. Typed, queryable 19650 metadata. List and
filter. Push notification. A machine-to-machine path. First-class project and
container structure. An explicit, gated lifecycle with a queryable audit trail.

**Non-goals.** Replacing BCF for issues. Modelling cost, schedule or
procurement. Being a general document-management product (`index.md` §5).
Breaking existing OpenCDE clients.

## 3. Two surfaces, one data model

| Surface | Purpose | Cost, stated |
| --- | --- | --- |
| **OpenCDE 1.0 compatible** | Existing desktop clients and CDE integrations keep working | Cannot express "unchanged"; a no-op re-upload will appear as a new version through this surface, and that is a documented limitation rather than a bug to fix |
| **Native** | Everything in §2 | A second set of semantics to keep honest |

Both project the same underlying containers, versions and audit records. The
native surface is the source of truth; the 1.0 surface is a projection that
loses information.

## 4. The core resources

### 4.1 Container version — with identity

The field `01` §3.1 found missing, and the one everything depends on:

```json
{
  "id": "cv_01JB...",
  "container_id": "c_01JB...",
  "digest": "blake3:9f2c...",
  "parent_digest": "blake3:4a71...",
  "revision": "P02.01",
  "suitability": { "code": "S3", "description": "Review and comment" },
  "state": "shared",
  "originator": { "organisation_id": "org_...", "account_id": "acc_..." },
  "created_at": "2026-10-26T09:12:44Z",
  "file": { "name": "...", "size_in_bytes": 4214880, "media_type": "application/x-step" },
  "change": {
    "against_parent": "cv_01JA...",
    "is_empty": false,
    "added": 12, "modified": 48, "deleted": 3,
    "components": ["attr:core", "pset:Pset_WallCommon", "geometry:tessellated"]
  },
  "checks": [
    { "kind": "ids", "status": "passed", "report_id": "rep_...", "specification": "ids_..." },
    { "kind": "naming", "status": "finding", "detail": "field 'volume' absent" }
  ]
}
```

Three design notes:

- **`digest` is the identity.** `revision` is a human label with a per-project
  grammar; it is not identity and must never be used as one.
- **`change.is_empty`** is the field that makes the product. A delivery whose
  diff is empty does not create a version; the API says so explicitly rather
  than returning a new `version_index`.
- **`checks` are attached to the version, not the transition**, so evidence
  survives independently of who later approved it.

### 4.2 Query, which 1.0 has none of

```http
GET /v1/projects/{project_id}/container-versions
      ?state=shared&suitability=S4&changed_since=2026-10-01
      &component=pset:Pset_WallCommon&page_size=100
```

Filterable on every typed field in §4.1 — the direct answer to `01` §3.3, where
the only query takes a list of IDs you must already know.

### 4.3 Lifecycle as transitions, not a writable field

```http
POST /v1/container-versions/{id}/transitions
{ "to_state": "published", "suitability": "A1", "authorised_by": "acc_...", "note": "..." }
```

The server evaluates the project's gates (`03` §3) and **refuses with the
failing checks** rather than accepting and flagging later. A state is never a
`PATCH`-able attribute; this is the difference between implementing 19650 and
storing a label (`02` §1).

### 4.4 Push notification

```http
POST /v1/projects/{project_id}/subscriptions
{ "events": ["version.created","transition.completed","check.failed"],
  "delivery": { "kind": "webhook", "url": "https://...", "secret_ref": "..." } }
```

Polling with `If-None-Match` remains available for parity with 1.0, but it stops
being the only mechanism (`01` §3.4).

### 4.5 Machine-to-machine transfer

The browser-redirect flow is kept for interactive clients, because its design
rationale is sound — it lets a CDE keep its own permissions and metadata forms.
Alongside it, a service account with scoped credentials can upload directly,
which is what `01` §3.5 found impossible and what CI and scheduled validation
need.

## 5. Identity and scopes

`01` §1 found `{ id, name? }` to be the entire Foundation identity model.
Replace it with a response carrying **tenant, project memberships, roles and
scopes**, so a client can discover what it may do before attempting it rather
than by trial and error. Scope vocabulary and the role model are
`05-multitenancy.md` §4's subject.

## 6. Cross-cutting requirements

- **Idempotency** on every mutating endpoint, keyed by client-supplied token.
  Re-uploading after a timeout must not create a second version — and with
  content addressing, the digest makes that detectable even without the token.
- **Pagination** everywhere, cursor-based. No unbounded list.
- **Problem details** for errors, with a stable machine-readable code. `01`
  found error semantics thin; a CDE's clients are automated and need to branch
  on failure kind.
- **Audit on read, not only on write.** Who downloaded which Published version
  is an audit question in contractual contexts.
- **Rate limits per tenant**, surfaced in headers.

## 7. Open questions

1. **Is `change` computed synchronously?** Diffing a large model takes real
   time, so a version may be created before its diff exists, which makes
   `is_empty` temporarily unknown — and that leaks into the state machine. An
   async `change.status: pending` is probably unavoidable and is ugly.
2. **What is the unit of subscription?** Project is coarse, container is chatty.
3. **Should the 1.0 surface advertise its own lossiness?** There is no field in
   the 1.0 wire format in which to say "this version is byte-different but
   semantically identical". Perhaps the metadata bag, perhaps nowhere.
4. **Does the native surface deserve its own media type and versioning
   discipline from day one?** Cheap now, expensive to retrofit.
