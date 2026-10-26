# 07: PRD — Self-Hosting

Part of the [cde-lite research set](index.md). PRD, not a specification.

## 1. Problem and promise

Construction information is commercially sensitive and often contractually
bound to a jurisdiction. Many organisations cannot or will not put it on a
vendor's platform, and the ones who can still want an exit.

The promise: **a team of three can run cde-lite on one machine in an afternoon,
and a platform operator runs the same code for many organisations.** Per
`05-multitenancy.md` §8, single-tenant is one tenant row, not a separate build.

This is also the strategic hedge. A self-hostable MPL-2.0 CDE is a different
offer from every incumbent, and it is the reason an organisation would adopt a
smaller product.

## 2. Target shape

```
docker compose up          # app + Postgres + object storage
```

- **One service binary** containing API, gate evaluation, diff workers and the
  static viewer bundle. Not a microservice fleet.
- **Postgres** for metadata, state, audit, identity.
- **Object storage**: a local filesystem path by default, any S3-compatible
  endpoint when one exists.
- **No outbound network requirement.** No telemetry, no licence check, no
  hosted dependency. It must run air-gapped, because some projects are.

A single-node deployment should need Postgres, a disk, and a TLS terminator.

## 3. Open decision: embedded datastore as well?

| Option | For | Against |
| --- | --- | --- |
| **Postgres only** | One set of SQL semantics, one migration path, row-level security available, operationally boring | A container and a backup story that a three-person practice may not want |
| **Embedded single-file as well** | True single-binary install; trivial backup | Two SQL dialects, two migration paths, two sets of concurrency behaviour to test — the cost lands on every feature forever |

`index.md` §6 lists this as open. The honest lean is **Postgres only**, with the
compose file carrying the burden, because a second datastore taxes development
permanently to save an operator one container. Revisit only if adoption
evidence says the container is the actual barrier.

## 4. Storage layout

Content-addressed, namespaced by tenant (`05` §5 — the dedup hazard):

```
<root>/<tenant>/objects/<aa>/<bb>/<full-digest>
<root>/<tenant>/packs/<pack-digest>.{idx,pack}
```

Two-level fan-out keeps directory sizes sane on filesystems that care.
Loose-then-packed mirrors ifc-git's planned tiers, so the CDE does not invent a
second storage model (`03` §5).

**Backup ordering is a correctness property, not an operational detail.**
Objects are immutable and the database references them, so: back up objects
first, database second. Restore in the same order. The reverse yields a database
referring to objects that are not there — and because the reference is a digest,
the failure is loud rather than silent, which is the one mercy in it.

## 5. Upgrades

- **Forward-only migrations**, applied automatically at start, with the schema
  version recorded and refused if the binary is older than the schema.
- **No destructive migration without an explicit flag.** A CDE holds contractual
  records; a migration that drops data must be opted into.
- **Objects are never migrated.** Content addressing means an object written by
  v1 is readable by v9. Only metadata interpretation evolves.
- Version skew between the viewer bundle and the API is avoided by shipping them
  in one binary.

## 6. Security defaults

- **No default credentials.** First run creates the initial administrator
  interactively or from an injected secret; it never ships with a known one.
- **TLS terminated upstream** by default, with a documented reverse-proxy
  configuration rather than a half-implemented ACME client.
- **Secrets from environment or file references**, never in the database.
- **Local identity by default, OIDC when configured.** A self-hoster must not
  need an external identity provider to start, and must be able to attach one.
- **Audit on by default**, with retention configurable and deletion requiring
  intent (`05` §6).

## 7. Licence hygiene

- cde-lite is **MPL-2.0**, like the rest of the repository. Self-hosting is a
  licence property first and a feature second.
- **No AGPL dependency may enter the tree.** This bears directly on the obvious
  thing to learn from: **BIMserver is AGPL-3.0**, and its network clause would
  reach a hosted cde-lite. Study its design; copy none of its code. The same
  discipline the ifc-git set applies to git (GPL-2.0) and libgit2.
- Every dependency's licence is recorded at the point of introduction, which is
  already this repository's practice in its Rust manifests.

## 8. What an operator must be told plainly

- **Resource expectations** at stated model sizes, measured rather than guessed.
  Diffing large models is memory-hungry and it is better to publish a number
  than to let someone discover it.
- **What is not included**: no HA story in the first shape, no managed backups,
  no SLA. Single-node with good backups is the supported topology.
- **The compliance limit** from `02` §7: the software implements 19650
  structures and produces evidence; it does not make an organisation compliant.

## 9. Open questions

1. **Horizontal scale.** Diff workers parallelise naturally; the ref
   compare-and-swap does not. Where does the first bottleneck appear?
2. **Multi-region for a hosted deployment**, given `05` §7 pins residency at
   project level.
3. **Air-gapped viewer assets.** The viewer must carry fonts and WASM locally
   with no CDN assumption — probably already true, unverified.
4. **Who upgrades a self-hoster's Postgres?** Major-version upgrades are the
   most common way a self-hosted deployment breaks, and the compose file is an
   invitation to pin and forget.
