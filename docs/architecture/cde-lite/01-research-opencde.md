# 01: What OpenCDE Specifies, and Where It Stops

Part of the [cde-lite research set](index.md). Research, not a proposal.

The buildingSMART OpenCDE family is the only vendor-neutral CDE interface that
exists, and that alone makes it the starting point. This document records what
it actually specifies, where it stops, and which of those stopping points
cde-lite has to move. **It is not a criticism of the specifications' authors:**
Documents API 1.0 was scoped to solve one problem — letting a desktop
application pick and push files through a CDE's own UI — and it solves that
problem. The limitations below are all consequences of that scope being
narrower than a CDE.

Evidence throughout is this repository's own conformant clients, because they
are a faithful transcription of the wire format: `packages/documents-api/src/types.ts`
and `packages/opencde-foundation/src/types.ts`.

## 1. Foundation API: what it gives you

Three things, and they are genuinely useful:

- **Version discovery** — `GET /foundation/versions`, returning `api_id`,
  `version_id`, optional `api_base_url`. This is how a client finds the BCF and
  Documents endpoints without being configured per vendor.
- **Auth discovery and OAuth2** — an `/auth` document, token exchange, and
  **dynamic client registration**, so a desktop tool can obtain credentials
  without a human registering an app with every CDE vendor. This is the single
  best idea in the family.
- **Identity** — `GET /current-user`.

### Where it stops

`FoundationCurrentUser` is, in full: `{ id, name? }`
(`opencde-foundation/src/types.ts:38-41`).

That is the whole identity model. There is **no tenant, no organisation, no
project membership, no role, and no scope vocabulary** for CDE operations. A
client cannot ask "which projects may I see?" or "may I publish?" — there is no
endpoint and no claim that would answer.

For a single-user desktop integration that is sufficient. For a multi-tenant
platform it is the absence of the entire access-control model, and cde-lite
cannot inherit it.

## 2. Documents API 1.0: the data model

A `DocumentVersion` is, in full (`documents-api/src/types.ts:60-68`):

```
links, version_number, version_index, creation_date,
title, file_description { name, size_in_bytes }, document_id
```

Metadata is a separate call returning a list of
`{ name, value: string[], data_type }`, where `data_type` is one of
`string | boolean | date-time | date | integer32 | integer64 | number | url`.

## 3. The seven places it stops

Each of these is a consequence of the original scope, and each is load-bearing
for cde-lite.

### 3.1 A version carries no content identity

There is **no hash, no checksum, no digest** on `DocumentVersion`. Identity is
`document_id` plus `version_index` — positional, assigned by the server.

Two consequences, and the second is the one that matters:

- A client cannot verify that the bytes it downloaded are the bytes the server
  meant to serve.
- **A client cannot tell whether a new version changed anything.** Re-upload the
  same file and you get `version_index: n+1`, indistinguishable from a real
  change. The API makes "nothing changed" unrepresentable.

This is precisely the problem ifc-git exists to solve, and it cannot be solved
on the client side: the information was never in the protocol.

### 3.2 Metadata is an untyped bag with no vocabulary

`data_type` types the *value* (`string`, `date`, `number`) but nothing types the
*name*. There is no registry of field names, so `status`, `Status`,
`suitability`, and `S2` are all equally valid spellings of the same ISO 19650
concept — and none of them is specified.

So the fields that make a CDE a CDE — **status/suitability code, revision code,
classification, originator, authorised-by** — exist only as convention per
deployment, with no interoperable meaning. A client cannot filter on them,
because it cannot know what they are called.

### 3.3 You must already know what you are looking for

`queryDocumentVersions` (`documents-api/src/client.ts:114`) is
`POST /document-versions` with a body of `{ document_ids: [...] }`.

There is **no list, no search, no filter**. You cannot enumerate a project's
containers, or ask for everything shared since Tuesday, or everything at status
S4. The API answers questions about documents you can already name.

### 3.4 Change detection is polling

The only mechanism is re-`POST`ing the ID list with `If-None-Match` and
handling `304` (`client.ts:140`). There are **no webhooks, no subscriptions, no
event stream**.

At CDE scale this is the wrong shape in two directions at once: latency is
bounded below by the poll interval, and cost scales with (clients × documents ×
frequency) rather than with the rate of actual change.

### 3.5 Both flows require a human in a browser

`POST /select-documents` returns a `select_documents_url` for the client to open
in a browser, with a `callback` URL to come back to
(`types.ts:26-41`). Upload works the same way.

This is a deliberate and clever decision — it lets each CDE keep its own
permissions, folder structure and metadata forms without the API having to model
any of them. It is also **fatal to automation**: there is no machine-to-machine
path for a CI job, a scheduled validation run, or a server-side ingest. Every
transfer needs an interactive session.

### 3.6 Project structure is an opaque string

Hierarchy appears once, as `server_context`: a CDE-controlled, client-opaque
value used to resume the UI in the right place (`types.ts:35, 71`).

There is no first-class project, volume, folder or container-breakdown concept.
The structural backbone of ISO 19650 is, protocol-wise, an opaque token.

### 3.7 No lifecycle at all

There is no state, no transition, no approval, no authorisation, no retention,
no legal hold, no deletion semantics, and no audit endpoint. The API moves bytes
and versions; the CDE's actual job — moving containers through WIP → Shared →
Published with gates — is entirely outside it.

## 4. The link-driven style, and its real cost

Most Documents API methods take a **server-provided URL** rather than building
one, which is why this repository's client signature is
`downloadDocumentVersion(documentVersionDownloadUrl)` rather than
`download(documentId, versionIndex)`. The `links` object on every
`DocumentVersion` carries `document_version`,
`document_version_metadata`, `document_version_download`, `document_versions`,
and an optional `document_details` browser URL.

The benefit is real: servers can reshape their URL space, shard, or sign
individual links without breaking clients.

The costs are also real, and worth naming because cde-lite must decide whether
to pay them:

- **Clients cannot be stateless.** To act on a version you must first have
  fetched the object that carried its links. There is no addressable identity to
  persist and resume from, which makes long-lived references awkward.
- **Nothing is cacheable by construction**, because URLs are opaque and may be
  short-lived.
- **Testing and mocking get harder** — a fake server must produce a coherent
  link graph, not just answer routes.

## 5. What "improved" therefore has to mean

Ranked by how much each unlocks, not by effort:

1. **Content-addressed versions.** A digest on every version, so "unchanged" is
   representable and verifiable. Everything diff-native depends on this one.
2. **A typed metadata vocabulary** with ISO 19650 fields as first-class, named,
   queryable properties rather than convention.
3. **Query and list endpoints** with filtering on those fields.
4. **Push change notification** — webhooks or a stream — with polling retained
   as a fallback.
5. **A machine-to-machine path** for selection and upload, with the
   browser-redirect flow kept for interactive clients rather than replaced.
6. **First-class project and container structure**, replacing `server_context`.
7. **An explicit lifecycle**: states, transitions, gates, and an audit trail
   that is queryable rather than implied.
8. **An identity model with tenants, projects, roles and scopes.**

Items 1-3 and 7 are where the differentiation lives. Items 4-6 are table
stakes that happen to be missing.

## 6. The compatibility question this forces

Every improvement above is a departure. Two surfaces are therefore unavoidable,
and pretending otherwise would be the easy mistake:

- A **conformant OpenCDE 1.0 surface**, so existing desktop clients and the CDEs
  this repository's `source-*` connectors already talk to keep working.
- A **native surface** that assumes content addressing, typed metadata and a
  lifecycle.

`04-api-design.md` proposes exactly that, under one data model, and states the
cost: two surfaces mean two sets of semantics to keep honest, and the 1.0 one
will keep misrepresenting unchanged re-uploads as new versions because its wire
format cannot say otherwise. That is a limitation to document, not to fix.

## 7. What was not researched here

- **BCF API 2.1/3.0** beyond noting it shares the Foundation layer. The topic
  model matters for `06-viewer-ux.md`, and its own limitations are unexamined.
- **The OpenCDE Information Delivery Specification touchpoints** — whether IDS
  validation has any standardised place in these APIs. Suspected not; unverified.
- **Any specification revision after Documents API 1.0.** The evidence base here
  is the 1.0 swagger as transcribed in this repository, and a successor may have
  addressed some of §3. That should be checked before any of this is acted on.
