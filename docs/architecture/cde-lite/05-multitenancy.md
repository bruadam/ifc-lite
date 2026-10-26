# 05: PRD — Multi-Tenancy, Isolation and Storage

Part of the [cde-lite research set](index.md). PRD, not a specification.

## 1. Problem

A CDE is multi-party by definition: an appointing party, a lead appointed party,
and several task teams from different companies, all working on one project and
none of them willing to see each other's work in progress. Multi-tenancy here is
not a billing convenience — it is the **core access-control requirement**.

## 2. Is the tenant an organisation or a project?

The decision that shapes everything else, and the reason `index.md` §6 lists it
first.

| Model | Attraction | Why it fails or costs |
| --- | --- | --- |
| **Tenant = project** | Clean isolation; a project is the natural data boundary; trivial residency per project | A company on 40 projects has 40 identities, 40 user directories, 40 sets of credentials. Users cannot see their work across projects. Breaks SSO |
| **Tenant = organisation** | Matches identity, billing and SSO reality; one directory per company; users see their portfolio | Projects span tenants, so a project is **not** inside a tenant — the hard part moves into authorisation, and isolation is no longer structural |

**Recommendation: tenant = organisation, with projects as cross-tenant shared
workspaces.** It matches how construction actually works, and the alternative
breaks SSO, which is non-negotiable for any organisation large enough to pay.

The cost must be stated honestly, because it is the main security risk in this
whole set: **isolation stops being structural and becomes a property of
authorisation logic.** With tenant = project you can enforce separation in the
storage layer. With tenant = organisation, every query must be correctly scoped
by project membership *and* by task-team visibility, and a single missing
predicate leaks one company's work in progress to another.

Mitigation, and it should be treated as mandatory rather than good practice:

- Scoping belongs in **one** enforced layer — a query builder or row-level
  security policy that cannot be bypassed — never re-implemented per endpoint.
- The default for any new query is **deny**; visibility is granted explicitly.
- Cross-tenant visibility tests are a standing part of the suite, asserting the
  negative: that an account in org A gets 404 rather than 403 for org B's WIP,
  because 403 confirms existence.

## 3. The three-level model

```
Organisation (tenant)  — identity, SSO, billing, residency
  └── Account          — a person or a service, belongs to exactly one org
Project                — cross-tenant workspace
  ├── Participant      — (org, role) admitted to the project
  ├── Task team        — a visibility boundary for work in progress
  └── Container        — belongs to a project, originated by a task team
```

The **task team is the WIP visibility boundary**, which is the structure 19650
actually requires and the one most file-based CDEs approximate with folder
permissions.

## 4. Roles and scopes

Map roles onto 19650 functions rather than inventing a parallel vocabulary,
because the standard's roles are what appear in the project's information
protocol:

| Role | May |
| --- | --- |
| **Appointing party** | See Shared and Published; authorise Published; configure requirements |
| **Lead appointed party** | All of the above, plus admit participants and configure gates |
| **Task team member** | Create and share containers for their own task team; see their own WIP |
| **Task team lead** | Plus transition their team's containers WIP → Shared |
| **Viewer** | Read what their organisation is entitled to; no transitions |
| **Service account** | A scoped subset, for CI and automation; never interactive |

Scopes are the API projection of these roles (`04` §5), expressed as
`project:read`, `container:create`, `transition:publish` and so on. A client
discovers its scopes rather than probing endpoints.

**Authorisation is not a role check.** Publishing requires a role *and* the
gates in `03` §3 passing. Keeping those separate matters: roles answer "may this
account act?", gates answer "is this container fit to advance?", and conflating
them produces a system where a sufficiently senior role can publish anything.

## 5. Storage, and a hazard worth refusing

Content addressing (`03`) makes deduplication nearly free: identical content has
one address, so it is stored once. Across tenants, that saving is substantial —
the same federated reference model is uploaded by every consultant on a project.

**It is also an existence oracle, and it should be refused by default.** If the
store is keyed purely by digest, then an account can learn whether given content
already exists by observing whether an upload deduplicates — timing, billed
bytes, or a dedup indicator. That lets one organisation confirm it holds a
byte-identical copy of another's unpublished container. In a competitive tender
context that is a genuine leak, not a theoretical one.

Recommended layout: **namespace the store by tenant**, so dedup happens within
an organisation and never across. Within a project, deduplication across
participating organisations may be offered as an explicit, documented project
setting — because the participants have a shared confidentiality context — but
never as a silent default.

Accept the cost: more bytes stored. The saving is not worth an unreviewable
information channel between competitors.

## 6. The unresolved tension: append-only versus erasure

19650 wants nothing deleted (`02` §1). Data protection law sometimes requires
erasure of personal data. A content-addressed, append-only history makes real
erasure genuinely hard — a digest's whole purpose is that its content cannot
change.

Partial approaches, none of which fully resolves it:

- **Keep personal data out of content.** Authorship metadata lives in the
  database, not in hashed container bytes, so it can be redacted without
  breaking history. This helps, and it does not cover personal data *inside* a
  delivered IFC — which owner history routinely contains.
- **Crypto-shredding** — encrypt per subject and discard the key. Makes content
  unreadable while leaving the DAG intact. Operationally heavy.
- **Tombstones with legal basis recorded**, keeping the digest and discarding the
  bytes. Breaks reproducibility of archived versions, which is the audit
  property 19650 wanted.

**This is recorded as unresolved.** It should be decided before any deployment
holds personal data under a regime with erasure rights, and it is a design
constraint on the storage layer rather than a feature to add later.

## 7. Residency

Residency is a per-organisation attribute, but a cross-tenant project is the
problem case: two organisations with different residency requirements sharing
one project's containers. Options are to pin residency at the **project** level
and refuse participants whose policy conflicts, or to replicate — which
multiplies the §5 hazard. Pinning at project level, decided at creation and
immutable, is the tractable choice. Unexamined: whether that is acceptable to
organisations operating under conflicting regimes.

## 8. Self-hosting is the degenerate case

A single-tenant deployment is **one organisation, one project set, local
identity** — the same code with one tenant row, not a separate build. This is a
hard constraint on the design: no feature may exist only in a hosted
configuration, and no code path may assume more than one tenant exists.
`07-self-hosting.md` takes this up.

## 9. What was not researched here

- **ISO 19650-5**, the security-minded approach, which speaks directly to
  sensitive projects and access control. The reasoning above is from first
  principles and should be checked against it.
- **Delegated administration** — whether a lead appointed party can manage
  accounts belonging to another organisation. Probably not, which has
  consequences for onboarding that are not thought through.
- **Audit log tenancy.** A cross-tenant project's audit trail is visible to
  whom, exactly? Each participant seeing only their own entries defeats the
  purpose; everyone seeing everything leaks WIP activity patterns.
