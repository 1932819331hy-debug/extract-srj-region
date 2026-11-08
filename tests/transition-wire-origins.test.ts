import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { extractSrjRegion } from "../lib"

type Route = NonNullable<SimpleRouteJson["traces"]>[number]["route"]
type Wire = Extract<Route[number], { route_type: "wire" }>
const wire = (x: number, layer = "top", width = 0.2): Wire => ({
  route_type: "wire",
  x,
  y: 0,
  layer,
  width,
})
const via = {
  route_type: "via" as const,
  x: 0,
  y: 0,
  from_layer: "top",
  to_layer: "bottom",
  via_diameter: 0.4,
  via_hole_diameter: 0.2,
}
const crop = { minX: -1, maxX: 1, minY: -1, maxY: 1 }
const input = (route: Route): SimpleRouteJson => ({
  layerCount: 2,
  minTraceWidth: 0.2,
  bounds: { minX: -3, maxX: 3, minY: -2, maxY: 2 },
  obstacles: [],
  connections: [{ name: "net", pointsToConnect: [] }],
  traces: [
    {
      type: "pcb_trace",
      pcb_trace_id: "trace",
      connection_name: "net",
      route,
    },
  ],
})

// SRJ consumers, including capacity-autorouter's getObstaclesFromSrjTraces,
// read copper from adjacent same-layer wire points. Keep explicit origins
// after transitions so those consumers retain the segment and its width.
const wireSegments = (route: Route) =>
  route.flatMap((point, index) => {
    const next = route[index + 1]
    if (
      point.route_type !== "wire" ||
      next?.route_type !== "wire" ||
      point.layer !== next.layer
    ) {
      return []
    }
    return [
      {
        start: point.x,
        end: next.x,
        layer: point.layer,
        width: point.width,
      },
    ]
  })

const extractRoute = (route: Route) =>
  extractSrjRegion(input(route), crop).traces?.[0]?.route ?? []

test("preserves outgoing copper after an interior via", () => {
  const srj = input([
    wire(-2),
    wire(0),
    via,
    wire(0, "bottom"),
    wire(2, "bottom"),
  ])
  const original = structuredClone(srj)
  const result = extractSrjRegion(srj, crop)
  expect(wireSegments(result.traces?.[0]?.route ?? [])).toEqual([
    { start: -1, end: 0, layer: "top", width: 0.2 },
    { start: 0, end: 1, layer: "bottom", width: 0.2 },
  ])
  expect(
    (result.traces?.[0]?.route ?? []).filter((p) => p.route_type === "via"),
  ).toEqual([via])
  expect(result.connections[0]?.pointsToConnect).toMatchObject([
    { x: -1, y: 0, layer: "top" },
    { x: 1, y: 0, layer: "bottom" },
  ])
  expect(srj).toEqual(original)
  expect(extractSrjRegion(srj, crop)).toEqual(result)
})

test("preserves the outgoing width at a via before a narrower segment", () => {
  const route = extractRoute([
    wire(-2),
    wire(0),
    via,
    wire(0, "bottom", 0.4),
    wire(0.5, "bottom"),
    wire(2, "bottom"),
  ])
  expect(wireSegments(route)).toEqual([
    { start: -1, end: 0, layer: "top", width: 0.2 },
    { start: 0, end: 0.5, layer: "bottom", width: 0.4 },
    { start: 0.5, end: 1, layer: "bottom", width: 0.2 },
  ])
})

test("preserves outgoing copper after an interior through-obstacle token", () => {
  const through: Route[number] = {
    route_type: "through_obstacle",
    start: { x: -0.2, y: 0 },
    end: { x: 0.2, y: 0 },
    from_layer: "top",
    to_layer: "bottom",
    width: 0.2,
  }
  const route = extractRoute([
    wire(-2),
    wire(-0.2),
    through,
    wire(0.2, "bottom", 0.4),
    wire(2, "bottom"),
  ])
  expect(wireSegments(route)).toEqual([
    { start: -1, end: -0.2, layer: "top", width: 0.2 },
    { start: 0.2, end: 1, layer: "bottom", width: 0.4 },
  ])
  expect(route.filter((p) => p.route_type === "through_obstacle")).toEqual([
    through,
  ])
})

test("preserves outgoing copper after an interior jumper", () => {
  const jumper: Route[number] = {
    route_type: "jumper",
    start: { x: -0.2, y: 0 },
    end: { x: 0.2, y: 0 },
    footprint: "0603",
    layer: "top",
  }
  const route = extractRoute([
    wire(-2),
    wire(-0.2),
    jumper,
    wire(0.2, "top", 0.4),
    wire(2),
  ])
  expect(wireSegments(route)).toEqual([
    { start: -1, end: -0.2, layer: "top", width: 0.2 },
    { start: 0.2, end: 1, layer: "top", width: 0.4 },
  ])
  expect(route.filter((p) => p.route_type === "jumper")).toEqual([jumper])
})

test("preserves a wire that leaves a via on the crop entry edge", () => {
  const route = extractRoute([
    wire(-2),
    wire(-1),
    { ...via, x: -1 },
    wire(-1, "bottom", 0.4),
    wire(2, "bottom"),
  ])
  expect(wireSegments(route)).toEqual([
    { start: -1, end: 1, layer: "bottom", width: 0.4 },
  ])
})

test("does not invent an outgoing segment for a via on the crop exit edge", () => {
  const route = extractRoute([
    wire(-2),
    wire(1),
    { ...via, x: 1 },
    wire(1, "bottom"),
    wire(2, "bottom"),
  ])
  expect(wireSegments(route)).toEqual([
    { start: -1, end: 1, layer: "top", width: 0.2 },
  ])
  expect(route.at(-1)).toEqual({ ...via, x: 1 })
})

test("does not duplicate shared wire nodes when there is no transition", () => {
  const route = extractRoute([
    wire(-2),
    wire(0, "top", 0.4),
    wire(0.5),
    wire(2),
  ])
  expect(route).toEqual([wire(-1), wire(0, "top", 0.4), wire(0.5), wire(1)])
  expect(wireSegments(route)).toHaveLength(3)
})

test("leaves a fully contained transition route unchanged", () => {
  const route = [
    wire(-0.5),
    wire(0),
    via,
    wire(0, "bottom", 0.4),
    wire(0.5, "bottom"),
  ]
  expect(extractRoute(route)).toEqual(route)
})

test("keeps separate wire fragments around a crossing atomic token", () => {
  const jumper: Route[number] = {
    route_type: "jumper",
    start: { x: -2, y: 0 },
    end: { x: 0, y: 0 },
    footprint: "0603",
    layer: "top",
  }
  const result = extractSrjRegion(input([jumper, wire(0), wire(2)]), crop)
  expect(result.traces).toHaveLength(2)
  expect(result.traces?.[0]?.route ?? []).toEqual([jumper])
  expect(result.traces?.[1]?.route ?? []).toEqual([wire(0), wire(1)])
})
