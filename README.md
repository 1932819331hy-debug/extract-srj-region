# @tscircuit/extract-srj-region

Extract a rectangular region from Simple Route JSON (SRJ) while preserving the
information a local autorouter or DRC repair solver needs at the region
boundary.

## Install

This package uses tscircuit's source-distributed GitHub package convention:

```sh
bun add https://github.com/tscircuit/extract-srj-region
```

## API

```ts
import {
  extractSrjRegion,
  type ExtractSrjRegionBounds,
  type SimpleRouteJson,
} from "@tscircuit/extract-srj-region"

const bounds: ExtractSrjRegionBounds = {
  minX: -6,
  maxX: 6,
  minY: -6,
  maxY: 6,
}

const region = extractSrjRegion(srj, bounds)
```

When a smaller center is the only editable area, protect it while allowing the
extractor to discard a boundary-only obstacle that would otherwise assign an
artificial cut terminal to the wrong net:

```ts
const region = extractSrjRegion(srj, outerBounds, {
  protectedBounds: editableBounds,
})
```

`protectedBounds` must be contained by `outerBounds`. Omitting the option is
the conservative default: every original obstacle intersecting the crop is
retained.

```ts
function extractSrjRegion(
  srj: SimpleRouteJson,
  bounds: ExtractSrjRegionBounds,
  options?: { protectedBounds?: ExtractSrjRegionBounds },
): SimpleRouteJson
```

## Extraction contract

- The function is deterministic and does not mutate `srj` or `bounds`.
- Bounds are axis-aligned, finite, and inclusive. Invalid or inverted bounds
  throw an error.
- The returned SRJ uses the requested rectangle as its `bounds` while
  retaining the input's routing rules and layer configuration.
- Obstacles are selected by geometric intersection, not center containment, so
  an obstacle that crosses the rectangle edge is not accidentally omitted.
- If `protectedBounds` is provided, an electrically connected obstacle whose
  center is outside the crop may be omitted only when it contains an artificial
  cut terminal for a different net and does not intersect the protected area.
  Same-net obstacles, unconnected keepouts, and all obstacles intersecting the
  protected area are retained.
- Routed wire geometry is clipped at the rectangle edge. Vias and other
  point-like route entries are retained when their centers are within the
  inclusive bounds.
- Every routed crossing of the rectangle edge becomes a deterministic boundary
  terminal on the corresponding connection. This preserves connectivity to
  immutable routing outside the extracted region.
- Fragment connections retain canonical net aliases, while trace IDs, endpoint
  IDs, and merged provenance aliases are excluded from root-net aliases. A
  trace's `connectsTo` list is rebuilt from only the endpoints actually retained
  by its fragment.
- Connections and routing constraints are pruned so they do not reference
  removed geometry or connection names.
- Optional SRJ metadata is preserved unless clipping makes it invalid.
- Legacy `oval` obstacles are accepted at runtime even though newer SRJ types
  model autorouting obstacles as rectangles. Rotated rectangle and oval
  intersection tests use their actual geometry.
- Board outlines are clipped to the requested rectangle. The returned ring is
  closed when the intersection has at least three vertices. If a concave board
  intersects the rectangle in multiple disconnected pieces, `outline` is
  omitted because Simple Route JSON can represent only one outline ring.
- The large `sourceCircuitJson` and `sourceKicadPcb` payloads sometimes embedded
  by datasets are intentionally omitted. Compact provenance such as an ID,
  source name, URL, or hash is preserved.

A trace keeps its original `pcb_trace_id` when clipping yields one connected
fragment, so crop-local DRC metadata can still resolve it. A trace that leaves
and re-enters the crop receives deterministic fragment IDs. Every fragment has
one local connection. A boundary cut is represented by a single-layer
connection point and a trace-width rectangular anchor obstacle connected to
both the local connection and its root net. If different nets would otherwise
share an anchor or the same coordinate hash rounded to 0.01 mm, a deterministic
wire stub of at most 0.9 mm is added along the crop edge. The stub changes only
boundary geometry and keeps the fragment nets distinct. Atomic `jumper` and
`through_obstacle` tokens cannot accept such a wire stub; extraction throws
instead of emitting ambiguous connectivity if two atomic boundary terminals
collide.

`jumper` and `through_obstacle` route entries are atomic. If one crosses the
rectangle, the complete token is retained conservatively; only its local
connection terminals are placed at the rectangle intersections. Consumers
that require every emitted primitive to be physically contained by `bounds`
should reject such regions before calling a local solver.

## Development

```sh
bun install
bun test
bun run typecheck
bun run format:check
```

This repository intentionally has no transpilation step. Consumers install the
TypeScript source directly from GitHub.

## License

MIT
