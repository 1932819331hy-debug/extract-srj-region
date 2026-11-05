import assert from "node:assert/strict"
import { test } from "node:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { extractSrjRegion } from "../lib/extract-srj-region"

type Connection = SimpleRouteJson["connections"][number]
type Point = Connection["pointsToConnect"][number]
type Trace = NonNullable<SimpleRouteJson["traces"]>[number]

const crop = { minX: -2, maxX: 2, minY: -2, maxY: 2 }
const a: Point = { x: 0, y: 0, layer: "top", pointId: "A" }
const b: Point = { x: 1, y: 0, layer: "top", pointId: "B" }
const c: Point = { x: 0, y: 1, layer: "top", pointId: "C" }
const wire = (x: number, y: number) => ({
  route_type: "wire" as const,
  x,
  y,
  layer: "top",
  width: 0.2,
})
const trace = (id: string, route: Trace["route"]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: id,
  connection_name: "net",
  route,
})
const input = (points: Point[], traces: Trace[]): SimpleRouteJson => ({
  layerCount: 2,
  minTraceWidth: 0.15,
  bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
  obstacles: [],
  connections: [{ name: "net", pointsToConnect: points }],
  traces,
})
const ids = (connection: Connection) =>
  connection.pointsToConnect.map((point) => point.pointId)

// Returning only A/B drops the unfinished A/B-to-C routing obligation.
test("keeps an unrouted terminal connected to the surviving local net", () => {
  const srj = input([a, b, c], [trace("ab", [wire(0, 0), wire(1, 0)])])
  const before = structuredClone(srj)
  const result = extractSrjRegion(srj, crop)
  assert.equal(result.connections.length, 1)
  assert.deepEqual(ids(result.connections[0]!), ["A", "B", "C"])
  assert.equal(result.connections[0]!.rootConnectionName, "net")
  assert.deepEqual(result.traces![0]!.route, srj.traces![0]!.route)
  assert.deepEqual(result.traces![0]!.connectsTo, ["A", "B"])
  assert.deepEqual(srj, before)
  assert.deepEqual(extractSrjRegion(srj, crop), result)
})

test("keeps local points connected to cut terminals and excludes remote points", () => {
  const outside: Point = { x: 4, y: 0, layer: "top", pointId: "remote" }
  const srj = input([a, outside, c], [trace("cut", [wire(0, 0), wire(4, 0)])])
  const result = extractSrjRegion(srj, crop)
  const connection = result.connections[0]!
  assert.deepEqual(ids(connection), ["A", "net__region_cut_0__end_point", "C"])
  assert.deepEqual(connection.pointsToConnect[1], {
    x: 2,
    y: 0,
    layer: "top",
    pointId: "net__region_cut_0__end_point",
  })
  assert.deepEqual(result.traces![0]!.connectsTo, [
    "A",
    "net__region_cut_0__end_point",
  ])
  assert.equal(result.obstacles.length, 1)
})

test("does not append a point already retained by a later trace", () => {
  const d: Point = { x: 1, y: 1, layer: "top", pointId: "D" }
  const srj = input(
    [a, b, c, d],
    [
      trace("ab", [wire(0, 0), wire(1, 0)]),
      trace("bc", [wire(1, 0), wire(0, 1)]),
    ],
  )
  const result = extractSrjRegion(srj, crop)
  assert.deepEqual(result.connections.map(ids), [
    ["A", "B", "D"],
    ["B", "C"],
  ])
  assert.deepEqual(
    result.traces!.map((item) => item.route),
    srj.traces!.map((item) => item.route),
  )
})

test("retains a remaining terminal once when its trace splits into fragments", () => {
  const end: Point = { x: 0, y: 1.5, layer: "top", pointId: "end" }
  const srj = input(
    [a, end, c],
    [trace("split", [wire(0, 0), wire(4, 0), wire(4, 1.5), wire(0, 1.5)])],
  )
  const result = extractSrjRegion(srj, crop)
  assert.equal(result.connections.length, 2)
  assert.equal(result.traces!.length, 2)
  assert.deepEqual(ids(result.connections[0]!), [
    "A",
    "net__region_split_0__end_point",
    "C",
  ])
  assert.deepEqual(ids(result.connections[1]!), [
    "net__region_split_1__start_point",
    "end",
  ])
  assert.equal(
    result.connections.flatMap(ids).filter((id) => id === "C").length,
    1,
  )
})

test("preserves distinct coincident terminal identities and their metadata", () => {
  const other: Point = { ...a, pointId: "other", pcb_port_id: "port_other" }
  const lower: Point = { ...a, layer: "bottom", pointId: "lower" }
  const srj = input([a, b, other, lower], [trace("ab", [wire(0, 0), wire(1, 0)])])
  const result = extractSrjRegion(srj, crop)
  assert.deepEqual(ids(result.connections[0]!), ["A", "B", "other", "lower"])
  assert.deepEqual(result.connections[0]!.pointsToConnect[2], other)
  assert.deepEqual(result.connections[0]!.pointsToConnect[3], lower)
  assert.notEqual(result.connections[0]!.pointsToConnect[2], other)
  assert.deepEqual(result.traces![0]!.connectsTo, ["A", "B"])
})

test("does not require point identifiers to preserve an unrouted terminal", () => {
  const anonymous: Point = { x: 0, y: 1, layers: ["top", "bottom"] }
  const srj = input([a, b, anonymous], [trace("ab", [wire(0, 0), wire(1, 0)])])
  const result = extractSrjRegion(srj, crop)
  assert.deepEqual(result.connections[0]!.pointsToConnect, [a, b, anonymous])
})

test("keeps fully represented and connection-only inputs unchanged", () => {
  const routed = extractSrjRegion(
    input([a, b], [trace("ab", [wire(0, 0), wire(1, 0)])]),
    crop,
  )
  assert.deepEqual(ids(routed.connections[0]!), ["A", "B"])
  const unrouted = extractSrjRegion(input([a, b, c], []), crop)
  assert.deepEqual(unrouted.connections, [
    { name: "net", pointsToConnect: [a, b, c] },
  ])
})

test("keeps constraint replacements pointing to the enriched local connection", () => {
  const srj = input([a, b, c], [trace("ab", [wire(0, 0), wire(1, 0)])])
  srj.connections.push({
    name: "other",
    pointsToConnect: [{ ...c, pointId: "other" }],
  })
  srj.buses = [
    { busId: "bus", connectionNames: ["net", "other"], maxLengthSkew: 0.5 },
  ]
  const result = extractSrjRegion(srj, crop)
  assert.deepEqual(result.buses![0]!.connectionNames, [
    "net__region_ab_0",
    "other",
  ])
  assert.deepEqual(ids(result.connections[0]!), ["A", "B", "C"])
})
