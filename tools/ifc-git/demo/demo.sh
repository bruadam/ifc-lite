#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# ifc-git walkthrough: three repositories (architecture, structure,
# coordination), branches, pull requests, protected branches, Actions-style
# checks run by ifc-lite, a semantic merge conflict, a formal delivery, and a
# cross-project clash caught before it reaches the coordinated model.
#
#   tools/ifc-git/demo/demo.sh [output-dir]
#
# Needs the built CLI (pnpm build --filter=@ifc-lite/cli...) and its WASM.
# Every model, check and result below is real; nothing is mocked.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="${1:-$PWD/ifc-git-demo}"
CLI="${IFC_LITE:-$ROOT/packages/cli/dist/index.js}"
SAMPLE="$ROOT/apps/viewer/public/samples/building-architecture.ifc"
[ -f "$CLI" ] || { echo "ifc-lite CLI not built: $CLI" >&2; exit 1; }

ifc-lite() { node "$CLI" "$@" 2> >(grep -v -E '^\s*(Loading|Validating|Parsing|\[IFC-LITE\])' >&2); }
ifc-git() { node "$HERE/../bin.mjs" "$@"; }
export IFC_LITE="$CLI"

BOLD=$'\e[1m'; DIM=$'\e[2m'; CYAN=$'\e[36m'; RESET=$'\e[0m'
[ -t 1 ] || { BOLD=''; DIM=''; CYAN=''; RESET=''; }
act()  { printf '\n%s━━━ %s ━━━%s\n' "$BOLD" "$*" "$RESET"; }
say()  { printf '%s%s%s\n' "$DIM" "$*" "$RESET"; }
# Show the command, run it, and show a non-zero exit without stopping the story.
run()  { printf '%s$ %s%s\n' "$CYAN" "$*" "$RESET"; "$@"; local s=$?; [ $s -eq 0 ] || printf '%s(exit %d)%s\n' "$DIM" "$s" "$RESET"; return 0; }
as()   { export GIT_AUTHOR_NAME="$1" GIT_COMMITTER_NAME="$1" GIT_AUTHOR_EMAIL="$(echo "$1" | tr 'A-Z' 'a-z')@example.com" GIT_COMMITTER_EMAIL="$(echo "$1" | tr 'A-Z' 'a-z')@example.com"; }
quiet() { "$@" > /dev/null 2>&1; }

# The structural model: four columns, built once so their GlobalIds stay
# stable across revisions, plus optionally one beam.
COLUMNS=""
structure_model() {
  local out="$1" beam_start="${2:-}" beam_name="${3:-}" tmp
  tmp="$(mktemp -d)"
  if [ -z "$COLUMNS" ]; then
    COLUMNS="$OUT/.assets/columns.ifc"; mkdir -p "$OUT/.assets"
    local pc='{"Name":"Pset_ColumnCommon","Properties":[{"Name":"LoadBearing","NominalValue":true}]}'
    local i=0 parts=()
    for xy in 3.6,3.6 3.6,8.4 4.8,3.6 4.8,8.4; do
      i=$((i + 1))
      quiet ifc-lite create column --position "$xy,0" --height 2.6 --width 0.25 --depth 0.25 --name "C-$i" --pset "$pc" --out "$tmp/c$i.ifc"
      parts+=("$tmp/c$i.ifc")
    done
    quiet ifc-lite merge "${parts[@]}" --out "$COLUMNS"
  fi
  if [ -n "$beam_start" ]; then
    local pb='{"Name":"Pset_BeamCommon","Properties":[{"Name":"LoadBearing","NominalValue":true}]}'
    quiet ifc-lite create beam --start "$beam_start" --end 6,6,2.5 --width 0.3 --height 0.5 --name "$beam_name" --pset "$pb" --out "$tmp/beam.ifc"
    quiet ifc-lite merge "$COLUMNS" "$tmp/beam.ifc" --out "$out"
  else
    cp "$COLUMNS" "$out"
  fi
  rm -rf "$tmp"
}

new_repo() {
  local name="$1"
  mkdir -p "$OUT/$name" && cd "$OUT/$name" || exit 1
  git init -q -b main
  cp -R "$HERE/$name/." .
  printf '*.ifc binary\n*.ifczip binary\n' > .gitattributes
}

rm -rf "$OUT" && mkdir -p "$OUT"

act "0. A project of three repositories"
say "architecture/ and structure/ each own one discipline model. coordination/ federates"
say "pinned versions of both. Each has its own workflows and protected main branch."

as "Ana"
new_repo architecture
mkdir -p models && cp "$SAMPLE" models/house.ifc
quiet git add -A && quiet git commit -m "Initial architectural delivery"
run ifc-git push main
say "main is red: the inherited model has building element proxies without an ObjectType."

as "Dana"
new_repo structure
mkdir -p models && structure_model models/structure.ifc
quiet git add -A && quiet git commit -m "Initial structural delivery: four columns"
run ifc-git push main

as "Ana"
new_repo coordination
run ifc-git federation lock
quiet git add -A && quiet git commit -m "Federate architecture and structure"
run ifc-git push main

act "1. A branch, a pull request, a review"
cd "$OUT/architecture" || exit 1
as "Ana"
run git switch -q -c fix/proxy-object-types
run ifc-lite mutate models/house.ifc --type IfcBuildingElementProxy --set ObjectType=SiteFurniture --out models/house.ifc
quiet git commit -am "Declare ObjectType on building element proxies"
run ifc-git pr open fix/proxy-object-types --title "Declare proxy ObjectTypes" --author Ana
run ifc-git pr merge 1 --by Ana
say "Checks are green, but main requires one approval, and an author cannot approve their own change."
run ifc-git pr approve 1 --by Ben
run ifc-git pr merge 1 --by Ben
run git switch -q main

act "2. main is protected"
as "Ben"
ifc-lite mutate models/house.ifc --type IfcSlab --set Name=Slab --out models/house.ifc > /dev/null
quiet git commit -am "Quick fix straight on main"
run ifc-git push main
quiet git reset -q --hard origin/main 2>/dev/null || quiet git reset -q --hard HEAD~1

act "3. Concurrent work, and a semantic conflict"
say "Three people branch from the same main and edit the same IFC file."
as "Alice"; run git switch -q -c alice/fire-rating main
run ifc-lite mutate models/house.ifc --type IfcWall --set Pset_WallCommon.FireRating=EI60 --out models/house.ifc
quiet git commit -am "Fire rating EI60 on all walls"
as "Bob"; run git switch -q -c bob/acoustics main
run ifc-lite mutate models/house.ifc --id 353 --set Pset_WallCommon.AcousticRating=Rw45 --out models/house.ifc
quiet git commit -am "Acoustic rating on the plumbing wall"
as "Carol"; run git switch -q -c carol/roof-name main
run ifc-lite mutate models/house.ifc --type IfcRoof --set Name=Pitched-roof --out models/house.ifc
quiet git commit -am "Rename the roof"
run git switch -q main
run ifc-git pr open alice/fire-rating --title "Fire ratings" --author Alice
run ifc-git pr open bob/acoustics --title "Plumbing wall acoustics" --author Bob
run ifc-git pr open carol/roof-name --title "Roof name" --author Carol
run ifc-git pr approve 2 --by Ben
run ifc-git pr merge 2 --by Ben
say "main moved. Bob's and Carol's pull requests were re-synced against it:"
run ifc-git pr show 3
run ifc-git pr show 4
say "Bob and Alice both edited Pset_WallCommon on the plumbing wall: a real conflict."
say "Carol renamed the roof, an element Alice did not touch: compatible, but the two"
say "deliveries are still two different files, so one side has to be taken."
as "Bob"
run ifc-git pr resolve 3 --take base --by Bob
run git switch -q bob/acoustics
run ifc-lite mutate models/house.ifc --id 353 --set Pset_WallCommon.AcousticRating=Rw45 --out models/house.ifc
quiet git commit -am "Re-apply the acoustic rating on top of the fire ratings"
run ifc-git push bob/acoustics
run ifc-git pr approve 3 --by Ben
run ifc-git pr merge 3 --by Ben
run git switch -q main

act "4. A formal delivery on a release branch"
run git branch release/building-permit main
run ifc-git push release/building-permit
run git tag -a delivery/building-permit -m "Building permit submission" release/building-permit

act "5. Structure adds a beam: green on its own, red in coordination"
cd "$OUT/structure" || exit 1
as "Dana"
run git switch -q -c feature/transfer-beam
structure_model models/structure.ifc 1,6,2.5 "B-12 transfer beam"
quiet git commit -am "Add transfer beam B-12"
run ifc-git pr open feature/transfer-beam --title "Transfer beam B-12" --author Dana
run ifc-git pr approve 1 --by Erik
run ifc-git pr merge 1 --by Erik
run git switch -q main

cd "$OUT/coordination" || exit 1
say "Both disciplines moved their main branch. The coordination bot proposes new pins:"
run ifc-git federation update
say "The architectural bump federates cleanly with the pinned structure: approve and merge it."
run ifc-git pr approve 1 --by Ana
run ifc-git pr merge 1 --by Ana
say "The structural bump does not: beam B-12 passes through the architect's outer wall."
run ifc-git pr show 2
run ifc-git pr approve 2 --by Ana
run ifc-git pr merge 2 --by Ana
say "Blocked by coordination/federated-clash. The BCF file for Dana is a run artifact:"
run sh -c 'ls -t .git/ifc-git/artifacts/*/federated-clash/clashes.bcfzip | head -1'

cd "$OUT/structure" || exit 1
as "Dana"
run git switch -q -c fix/beam-bearing
structure_model models/structure.ifc 3.3,6,2.5 "B-12 transfer beam (bears on wall)"
quiet git commit -am "B-12 bears on the outer wall instead of passing through it"
run ifc-git pr open fix/beam-bearing --title "B-12 bears on the wall" --author Dana
run ifc-git pr approve 2 --by Erik
run ifc-git pr merge 2 --by Erik
run git switch -q main

cd "$OUT/coordination" || exit 1
run ifc-git federation update
run ifc-git pr approve 3 --by Ana
run ifc-git pr merge 3 --by Ana

act "6. Where everything stands"
cd "$OUT/architecture" || exit 1
run ifc-git log main -n 12
run ifc-git status
cd "$OUT/coordination" && run ifc-git status
say ""
say "Repositories: $OUT/{architecture,structure,coordination}"
say "Forge state, runs and artifacts (BCF, delivery reports): <repo>/.git/ifc-git/"
