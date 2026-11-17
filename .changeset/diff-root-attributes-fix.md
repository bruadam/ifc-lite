---
'@ifc-lite/cli': patch
---

`ifc-lite diff` (`--by-content`, and every path that fingerprints a file) now sees edits to an element's `Description` and `ObjectType`. The columnar parser leaves those entity-table columns empty for products, so both sides hashed an empty string and such an edit was reported as unchanged; the attributes are now read from the STEP record.
