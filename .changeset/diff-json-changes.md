---
'@ifc-lite/cli': minor
---

`ifc-lite diff --by-content --json --changes` adds a `changes` array to the JSON report: one record per added, modified or deleted entity, with its key, state, IFC class, change kinds and changed component keys. The default JSON document is unchanged.
