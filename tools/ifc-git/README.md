# ifc-git: Git workflows for IFC models, checked by ifc-lite

A local forge for IFC deliveries: branches, pull requests, protected branches,
and a lightweight GitHub-Actions-style runner whose steps are ifc-lite checks
(validation, IDS, rule sets, clash detection, delivery recipes, semantic diff).
Several repositories can be federated into one coordinated model, with pinned
versions and bot pull requests when a discipline publishes a new delivery.

It is a working prototype of the workflows the
[ifc-git spec set](../../docs/architecture/ifc-git/index.md) and
[Layer PRs](../../docs/architecture/layer-prs/index.md) describe, built on plain
git and the shipped ifc-lite CLI. It does not change either spec; see
[Limits](#limits) for where it stops.

```sh
node tools/ifc-git/bin.mjs help
tools/ifc-git/demo/demo.sh /tmp/ifc-git-demo   # the full walkthrough, real models and checks
node --test tools/ifc-git/*.test.mjs            # needs the built CLI for the integration tests
```

Prerequisite: a built CLI (`pnpm build --filter=@ifc-lite/cli...` plus its WASM:
`pnpm build:wasm`, or `node scripts/fetch-prebuilt-wasm.mjs`). Set `IFC_LITE` to
use another `ifc-lite` executable or CLI entry point.

## The model

| GitHub | ifc-git |
| --- | --- |
| Repository | A git repository holding one discipline's IFC deliveries, with `.ifc-git/` config |
| Commit | A delivery: the IFC files as delivered, byte for byte |
| `git push` | `ifc-git push <branch>`: publish to the forge, run `on: push` workflows, re-sync affected pull requests |
| Pull request | `ifc-git pr open`: merge preview, element-level changes per model, `on: pull_request` workflows |
| Diff | The ifc-lite diff engine: added / modified / deleted elements and the components that changed (`pset:Pset_WallCommon`, `attr:core`, …), GUID-agnostic |
| Merge conflict | Semantic: both sides changed the same component of the same element, or one deleted what the other changed |
| Branch protection | `.ifc-git/protection.yml`: pull requests only, required checks, required approvals, stale approvals dismissed |
| Actions | `.ifc-git/workflows/*.yml`: triggers, jobs, `needs`, `if`, `strategy.matrix`, `uses: ifc-lite/<check>`, `run:` |
| Checks / artifacts | Recorded per commit; BCF files and HTML delivery reports kept per run |
| Organization with several repos | A coordination repository federating pinned commits of each discipline |
| Dependabot | `ifc-git federation update`: one pull request per project whose delivery moved |
| Release / tag | A `release/**` branch with its own protection and delivery workflow, plus an ordinary git tag |

Forge state (pushed tips, pull requests, runs, checks, artifacts) lives under
`.git/ifc-git/`, the way a hosted forge keeps it server side. Configuration lives
in the repository under `.ifc-git/`, and is always read from a commit:
workflows from the commit being checked, protection from the base branch tip, so
a pull request cannot relax the rules that gate it.

## Commands

```
init                                  .gitattributes (*.ifc binary) and starter .ifc-git/ config
push <branch> [--force]               publish; runs on:push workflows
run [--ref <branch>]                  run on:workflow_dispatch workflows
status                                branches, protection, checks, open pull requests
log [<rev>] [-n N]                    history with a semantic summary of every IFC change
checks [<rev>]                        check results recorded for a commit
pr open <head> [--base main] --title "…" [--author NAME]
pr list | show <n> | sync <n> | status <n>
pr approve <n> --by NAME              authors cannot approve their own pull request
pr merge <n> --by NAME [--waive <check>="<reason>"]
pr resolve <n> --take head|base --by NAME
pr close <n> --by NAME [--reason "…"]
federation lock                       pin every project's published tip
federation update [--base main]       open a pull request per moved project
```

Exit codes: 0 ok, 1 error, 2 rejected (push refused, merge blocked), 3 checks failed.

## Workflows

```yaml
name: Model checks
on:
  push:
    branches: [main, 'feature/**']      # glob filters, `!` negates
    paths: ['**/*.ifc', 'specs/**']
  pull_request:
    branches: [main]                    # the base branch
jobs:
  validate:
    strategy:
      matrix:
        model: ${{ project.models }}    # one variant per delivered model
    steps:
      - uses: ifc-lite/validate
        with: { model: '${{ matrix.model }}' }
  ids:
    needs: validate
    steps:
      - uses: ifc-lite/ids
        with: { model: models/house.ifc, ids: specs/architecture.ids }
  notify:
    needs: ids
    if: ${{ failure() }}
    steps:
      - run: echo "IDS failed on ${{ branch }}"   # `ifc-lite` is on PATH in run steps
```

Each job runs in its own throwaway worktree of the commit (the merge preview for
a pull request). A job's check name is `<workflow-file>/<job-id>`; that is what
`required_checks` lists. An empty matrix skips the job instead of passing it.

Expression context: `event`, `branch`, `sha`, `changed.files`, `changed.ifc`,
`project.*` (from `.ifc-git/project.yml`), `pr.*`, `matrix.*`,
`steps.<id>.outputs.*`, `needs.<job>.result`, `env.*`. Functions: `success()`,
`failure()`, `always()`, `contains()`, `startsWith()`, `endsWith()`, `join()`,
`length()`, `fromJSON()`. Expressions are parsed, never `eval`ed. `run:` steps
write outputs as `key=value` lines to `$IFC_GIT_OUTPUT` and can save files to
`$IFC_GIT_ARTIFACTS`.

### Built-in actions

| Action | ifc-lite command | Fails when | Inputs |
| --- | --- | --- | --- |
| `ifc-lite/validate` | `validate` | any structural error | `model` (one or a list) |
| `ifc-lite/ids` | `ids` | any specification fails | `model`, `ids` |
| `ifc-lite/check` | `check` | a rule fails at the `fail-on` severity | `model`, `rules`, `fail-on` |
| `ifc-lite/clash` | `clash` | more than `max-clashes` (default 0) | `model`, `a`, `b`, `matrix`, `mode`, `tolerance`, `clearance`, `bcf` |
| `ifc-lite/delivery` | `delivery` | the recipe verdict is not `pass`; keeps the HTML report | `recipe` |
| `ifc-lite/diff` | `diff --by-content --changes` | `fail-on-deleted` and something was deleted | `model`, `against`, `geometry` |
| `ifc-lite/federate` | `merge` | the merge fails | `model`, `from-lock`, `out`, `unit-reconciliation` |

A check that could not run (an unreadable model, a clash rule matching no
elements) is reported as an **error**, never as a pass.

## Several projects

A coordination repository lists the discipline repositories in
`.ifc-git/federation.yml` and pins one commit of each in
`.ifc-git/federation.lock.json` (`ifc-git federation lock`, then commit). Its
workflows use `ifc-lite/federate` with `from-lock: true` to materialize exactly
the pinned models, verified by blob id, and run clash detection or IDS on the
federation. `ifc-git federation update` opens one pull request per project
whose published tip moved, showing what changed in that delivery element by
element; a newer bump closes the one it supersedes.

## Limits

- **No IFC file is merged.** Two branches that both changed one model cannot be
  combined byte-wise; the analysis says whether their edits are compatible and
  which elements collide, and `pr resolve` takes one side's file (recording what
  the other side's changes were). Combining disjoint edits into one file is a
  component-level merge, the Layer PRs merge engine's job once deliveries become
  layers (ifc-git spec §8 row 8). Until then, the practical rule is the one most
  projects follow anyway: one model per discipline, owned by one team, and
  coordination by federation.
- **Diffs are data-scope by default.** A geometry-only move shows no change
  unless the diff runs with `geometry: true`; clash detection always uses
  geometry.
- **Local only.** The forge is per repository and per machine. There are no
  accounts: `--by` and `--author` are taken as given. A hosted version is what
  the Layer PRs registry (`docs/architecture/layer-prs/10-registry.md`) describes.
