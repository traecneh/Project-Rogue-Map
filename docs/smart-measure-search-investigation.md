# Smart Measure search investigation — 2026-09-08

Terrain correction after this investigation: gray mountain ID `277`, confirmed at
Overworld `(1355, 3539)`, is now blocked alongside `0`, `1`, `53`, and `60`.
All 12 reference distances were rechecked with full-grid breadth-first search.
`sample-5` now has a shortest distance of 989 steps and `sample-6` has 587; the
other references are unchanged. Historical measurements below use the earlier
four-ID terrain rule. The checked-in route fixtures use the corrected terrain.

## Implemented follow-up

The recommended hybrid strategy is now implemented. The original investigation
below is retained as context; its statement about unchanged production code refers
to that earlier investigation, before this follow-up.

- Offline generation creates 32×32 clusters. Every contiguous walkable boundary
  opening has crossings at its endpoints and at most eight tiles apart. Exact
  eight-way local distances connect portals only when they are reachable within
  that cluster. This preserves narrow openings and separate local regions.
- Short legs (at most 256 tiles Chebyshev distance) use tile A*, falling back
  after 40,000 discovered tiles or 500 ms. Direct valid walks need neither search
  nor hierarchy data. Long or difficult legs search the portal graph, then use
  exact local A* and obstacle-checked shortcuts to produce the actual tile route.
- Hierarchical search and refinement share a four-second budget, excluding
  downloading/decoding data. Work yields approximately every eight milliseconds
  at checkpoints so cancellation can be processed. A* retains its own cooperative
  checkpoints. No timer increase was needed to complete the benchmark routes.
- Overworld hierarchy: 107,863 portals, 1,459,942 directed edges, 2,961,641 download
  bytes (9,622,584 decoded). Underground: 10,331 portals, 95,612 edges, 237,864
  download bytes (656,348 decoded). Each is loaded only when needed, cached in the
  worker and checksum-bound to its walking grid. Grids remain unchanged.

All 12 original routes complete. Across their independently established shortest
distances, eight match exactly, three add one step and the difficult long route
adds three: 3,518 versus 3,515. Maximum inflation in this sample is 0.22%; this is
a measured result, not a general optimality guarantee. Full-grid breadth-first
search supplied reference lengths for the four routes previously stopped by the
node limit. The remaining eight references came from exact A*.

Local Edge browser checks measured the cached difficult route at 47 ms and the
town route at 69 ms, with map animation frames continuing. These exclude the first
hierarchy download and vary by hardware/browser. Initial Node measurements were
about 111 ms and 32 ms respectively; do not compare those timings across runtimes.

Validation includes every returned tile and diagonal corner, 60 synthetic cluster
fixtures, ten further Underground regions compared with exact A*, multiple
waypoints, Undo/Clear/floor cancellation, desktop/mobile controls, lazy loading,
failed/corrupt hierarchy downloads and successful retry. CI and regenerated-data
freshness checks pass. Reproduce the fixed-route benchmark with:

```powershell
node tools/benchmark_smart_measure.mjs --compare
node --test tests/smart_measure.test.mjs
python tools/generate_navigation.py --check
```

## Recommendation

Investigate hierarchical routing for long segments, retaining tile-level A* for
short segments and local refinement. A lightweight terrain graph completed the
hard routes quickly, but its route selection is too crude to ship. Implement a
proper cluster/portal abstraction with accurate local edge costs before using it
as the default. Keep tile IDs 0, 1, 53 and 60 blocked, the existing one-step
diagonal cost, and the prohibition on cutting blocked corners.

Weighted A* at 1.25 is a smaller potential improvement. It reduced search effort
with modest measured route inflation, but did not improve completion in this
sample. Pure greedy search completed the sample but sometimes produced excessive
detours. Neither alone is the recommended long-term solution.

The production application's search and cutoffs were not modified during this
investigation. Prototypes and raw results are in ignored `output/playwright/`.

## Method

- Used the committed navigation grids and current movement rules.
- Tested 12 fixed routes: mountain/water examples, a town-to-town route, the
  previously failing long route, Grell Underground, and seven deterministic
  sampled pairs in the main Overworld walking component (seed 349867).
- The sample deliberately includes difficult long routes; it does not establish
  population-wide success rates. Underground coverage is limited to one route.
- Current A*, weighted variants, greedy search and guided A* used the same
  400,000-discovered-node / 4-second limits and periodic yielding.
- Weighted and greedy experiments retained closed nodes without reopening them.
  Observed path-length differences are measurements, not claimed quality bounds.
- The run-graph prototypes searched at most 112,322 graph nodes on Overworld;
  they do not yet have production cancellation/time-budget handling.
- Timings are single-run local Node measurements, not browser latency forecasts.
  Initial graph construction is reported separately. Route lengths and expansion
  counts are more reproducible than sub-millisecond timing comparisons.
- Every returned path was checked tile by tile for blocked terrain, diagonal
  corner cutting, and agreement between its geometry and reported steps.

## Results

| Strategy | Completed / 12 | Median extra steps vs A* | Largest extra steps vs A* |
|---|---:|---:|---:|
| Current A* | 8 | 0% | 0% |
| Weighted A*, 1.25 | 8 | 1.2% | 5.2% |
| Weighted A*, 1.5 | 8 | 3.3% | 10.9% |
| Weighted A*, 2 | 8 | 5.0% | 27.2% |
| Greedy best-first | 12 | 5.0% | 48.4% |
| Rough run graph | 12 | 52.3% | 261.9% |
| Run graph with wider local shortcut refinement | 12 | 20.5% | 237.6% |
| A* with run-graph lower-bound guidance | 8 | 0% | 0% |

Length comparisons use only the eight routes for which the current A* completed.
The optimal lengths of the remaining four were not established.

The town route (760,1050) → (1480,1880) illustrates the tradeoff:

| Strategy | Local elapsed time | Walking steps |
|---|---:|---:|
| Current A* | 1,723 ms | 1,132 |
| Weighted 1.25 | 1,192 ms | 1,191 |
| Weighted 1.5 | 927 ms | 1,255 |
| Weighted 2 | 699 ms | 1,440 |
| Greedy | 265 ms | 1,680 |
| Rough run graph | 22 ms | 2,710 |
| Refined run graph | 42 ms | 2,185 |
| Guided A* | 1,514 ms | 1,132 |

For (800,600) → (2222,3078), current A*, all three weighted variants and guided
A* reached the node cap. Greedy completed in 2,623 ms with 6,114 steps. The refined
run graph completed in 420 ms with 6,811 steps. These lengths are not compared to
an optimal baseline because one was not computed.

Run-graph construction took about 12 ms for Overworld and 2 ms for Underground,
using the existing row-run navigation files. The graph stores one node per
horizontal walkable stretch, with edges between overlapping stretches on adjacent
rows. Its midpoint-based costs and constrained local shortcuts explain why it
should not be mistaken for a finished HPA* implementation.

## Other candidates and implementation implications

- **Hierarchical A* / cluster portals:** search a small graph of actual passages,
  then solve the detailed route inside the selected regions. Preserve separate
  connected areas within each cluster so aggregation cannot invent a crossing.
  Precompute local portal-to-portal costs alongside navigation generation.
  Validate both route quality and completion against larger exact baselines.
- **Jump Point Search:** promising for removing equivalent expansions in open
  terrain while preserving optimal routes under its supported movement model.
  No JPS implementation was benchmarked here. Any selected variant must be
  validated for unit-cost diagonals and the no-corner-cutting rule.
- **Landmark heuristics:** precomputed distances can provide stronger A* guidance
  while retaining optimality with suitable lower bounds. Memory/download cost
  matters on two 4096-square floors. The simple row-graph lower-bound prototype
  was insufficient; this does not rule out proper landmark heuristics.
- **Bidirectional search:** another candidate, but meeting/termination rules and
  heuristic choice matter. It was researched, not implemented in this test.
- **Implementation tuning:** reducing heap/indexing costs or adjusting yield
  frequency can reduce elapsed time, but cannot by itself resolve searches that
  exhaust the fixed discovered-node allowance.

Any next production implementation should retain cancellation, lazy loading,
per-floor isolation, clear failure messages, and actual routed-step measurement.
Keep unreachable destinations distinct from search-budget exhaustion. Re-test
short routes, narrow passages, difficult detours, both floors and mobile memory.

## Sources

- Nathan Sturtevant, [Weighted A* Node Re-Opening](https://www.movingai.com/wastar.html).
- Daniel Harabor, [Jump Point Search](https://harablog.wordpress.com/2011/09/07/jump-point-search/).
- University of Alberta, [Pathfinding in Computer Games / HPA*](https://webdocs.cs.ualberta.ca/~games/pathfind/).
- Goldberg and Harrelson, [Computing the Shortest Path: A* Search Meets Graph Theory](https://www.microsoft.com/en-us/research/publication/computing-the-shortest-path-a-search-meets-graph-theory/).

Raw results: `search-strategy-results.json`, `run-graph-results.json`,
`run-graph-refined-results.json`, and `guided-results.json` in `output/playwright/`.
