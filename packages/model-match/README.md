# @ifc-lite/model-match

Shared, headless revision matching for the CLI and viewer. `matchModels` ranks
candidates using normalized delivery names, IFC header signals, GlobalId overlap,
and the existing diff engine's content matches. Results carry reasons and measured
evidence. A result never creates model lineage or accepts element identity.

```ts
import { matchModels } from '@ifc-lite/model-match';
const result = await matchModels(
  { id: 'new', label: 'Structure', fileName: 'Structure_R03.ifc', fingerprints: [] },
  [{ id: 'old', label: 'Structure', fileName: 'Structure_R02.ifc', fingerprints: [], origin: 'loaded' }],
);
console.log(result.results);
```

`normalizeModelName` removes trailing delivery suffixes and recognizes ISO 19650
containers. Thresholds, exclusions, candidate limits, content matching and time
budgets are configurable. Missing, sampled, cancelled or timed-out evidence cannot
produce a `likely-revision` verdict. Digest equality can establish `identical`.

Validation covers renamed deliveries, reassigned GlobalIds, model splits,
discipline differences, missing evidence and cancellation. Default thresholds are
heuristics, not calibrated probabilities; calibration against a corpus of real
consecutive project deliveries remains a release prerequisite.
