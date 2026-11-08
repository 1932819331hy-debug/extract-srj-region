import { describe, expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { extractSrjRegion } from "../lib"

const crop = { minX: -1, maxX: 1, minY: -1, maxY: 1 }

const createSrj = (
  overrides: Partial<SimpleRouteJson> = {},
): SimpleRouteJson => ({
  layerCount: 2,
  minTraceWidth: 0.15,
  bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
  obstacles: [],
  connections: [],
  ...overrides,
})

const getWirePoints = (trace: NonNullable<SimpleRouteJson["traces"]>[number]) =>
  trace.route.flatMap((token) =>
    token.route_type === "wire" ? [{ x: token.x, y: token.y }] : [],
  )

describe("extractSrjRegion", () => {
  test("validates bounds, does not mutate inputs, and drops embedded source blobs", () => {
    const srj = createSrj({
      obstacles: [
        {
          obstacleId: "pad",
          type: "rect",
          layers: ["top"],
          center: { x: 0, y: 0 },
          width: 1,
          height: 1,
          connectedTo: [],
        },
      ],
    }) as SimpleRouteJson & {
      sourceCircuitJson: unknown[]
      sourceKicadPcb: string
      sourceName: string
      customMetadata: { nested: number[] }
    }
    srj.sourceCircuitJson = [{ type: "pcb_trace" }]
    srj.sourceKicadPcb = "(kicad_pcb ...)"
    srj.sourceName = "source-board"
    srj.customMetadata = { nested: [1, 2, 3] }
    const originalJson = JSON.stringify(srj)
    const originalBounds = { ...crop }

    const result = extractSrjRegion(srj, crop) as SimpleRouteJson &
      Record<string, unknown>

    expect(JSON.stringify(srj)).toBe(originalJson)
    expect(crop).toEqual(originalBounds)
    expect(result.bounds).toEqual(crop)
    expect(result.sourceName).toBe("source-board")
    expect(result.customMetadata).toEqual({ nested: [1, 2, 3] })
    expect(result.customMetadata).not.toBe(srj.customMetadata)
    expect(result).not.toHaveProperty("sourceCircuitJson")
    expect(result).not.toHaveProperty("sourceKicadPcb")

    expect(() => extractSrjRegion(srj, { ...crop, minX: Number.NaN })).toThrow(
      "finite",
    )
    expect(() => extractSrjRegion(srj, { ...crop, minX: 2 })).toThrow(
      "inverted",
    )
  })

  test("clips a crossing wire and creates deterministic boundary terminals", () => {
    const srj = createSrj({
      connections: [
        {
          name: "net_a",
          rootConnectionName: "root_a",
          pointsToConnect: [
            {
              x: -5,
              y: 0,
              layer: "top",
              pointId: "left_port",
              pcb_port_id: "pcb_port_left",
            },
            {
              x: 5,
              y: 0,
              layer: "top",
              pointId: "right_port",
              pcb_port_id: "pcb_port_right",
            },
          ],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "trace_a",
          connection_name: "net_a",
          route: [
            {
              route_type: "wire",
              x: -5,
              y: 0,
              layer: "top",
              width: 0.2,
              start_pcb_port_id: "pcb_port_left",
            },
            {
              route_type: "wire",
              x: 5,
              y: 0,
              layer: "top",
              width: 0.2,
              end_pcb_port_id: "pcb_port_right",
            },
          ],
        },
      ],
    })

    const first = extractSrjRegion(srj, crop)
    const second = extractSrjRegion(srj, crop)

    expect(first).toEqual(second)
    expect(first.traces).toHaveLength(1)
    expect(first.traces?.[0]?.pcb_trace_id).toBe("trace_a")
    const firstTrace = first.traces?.[0]
    if (!firstTrace) throw new Error("Expected one clipped trace")
    expect(getWirePoints(firstTrace)).toEqual([
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ])
    expect(first.connections).toHaveLength(1)
    expect(first.connections[0]?.name).toBe("net_a__region_trace_a_0")
    expect(first.connections[0]?.__rootConnectionNames).toEqual([
      "net_a",
      "root_a",
    ])
    expect(first.connections[0]?.pointsToConnect).toEqual([
      {
        x: -1,
        y: 0,
        layer: "top",
        pointId: "net_a__region_trace_a_0__start_point",
      },
      {
        x: 1,
        y: 0,
        layer: "top",
        pointId: "net_a__region_trace_a_0__end_point",
      },
    ])
    expect(
      first.obstacles.map((obstacle) => ({
        id: obstacle.obstacleId,
        center: obstacle.center,
        connectedTo: obstacle.connectedTo,
      })),
    ).toEqual([
      {
        id: "trace_a__boundary_start",
        center: { x: -1, y: 0 },
        connectedTo: ["net_a__region_trace_a_0", "net_a", "root_a"],
      },
      {
        id: "trace_a__boundary_end",
        center: { x: 1, y: 0 },
        connectedTo: ["net_a__region_trace_a_0", "net_a", "root_a"],
      },
    ])
    expect(first.traces?.[0]?.connectsTo).toEqual([
      "net_a__region_trace_a_0__start_point",
      "net_a__region_trace_a_0__end_point",
    ])
  })

  test("clips variable-width segments using the source wire point width", () => {
    const srj = createSrj({
      connections: [{ name: "variable", pointsToConnect: [] }],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "variable_trace",
          connection_name: "variable",
          route: [
            {
              route_type: "wire",
              x: -2,
              y: 0,
              layer: "top",
              width: 0.1,
            },
            {
              route_type: "wire",
              x: 2,
              y: 0,
              layer: "top",
              width: 0.4,
            },
          ],
        },
      ],
    })

    const result = extractSrjRegion(srj, crop)
    const wireWidths = result.traces?.[0]?.route.flatMap((token) =>
      token.route_type === "wire" ? [token.width] : [],
    )

    expect(wireWidths).toEqual([0.1, 0.1])
    expect(
      result.obstacles
        .filter((obstacle) => obstacle.obstacleId?.includes("__boundary_"))
        .map((obstacle) => obstacle.width),
    ).toEqual([0.1, 0.1])
  })

  test("does not alias distinct nets clipped at the same boundary coordinates", () => {
    const srj = createSrj({
      connections: [
        { name: "net_a", pointsToConnect: [] },
        { name: "net_b", pointsToConnect: [] },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "trace_a",
          connection_name: "net_a",
          connectsTo: ["shared_provenance_alias"],
          route: [
            { route_type: "wire", x: -2, y: 0, layer: "top", width: 0.2 },
            { route_type: "wire", x: 2, y: 0, layer: "top", width: 0.2 },
          ],
        },
        {
          type: "pcb_trace",
          pcb_trace_id: "trace_b",
          connection_name: "net_b",
          connectsTo: ["shared_provenance_alias"],
          route: [
            { route_type: "wire", x: -2, y: 0, layer: "top", width: 0.2 },
            { route_type: "wire", x: 2, y: 0, layer: "top", width: 0.2 },
          ],
        },
      ],
    })

    const result = extractSrjRegion(srj, crop)
    const [connectionA, connectionB] = result.connections
    if (!connectionA || !connectionB) {
      throw new Error("Expected two clipped connections")
    }
    const coordinateLayerHashes = (connection: typeof connectionA) =>
      connection.pointsToConnect.map((point) => {
        const layers = "layers" in point ? point.layers.join("-") : point.layer
        return `${Math.round(point.x * 100)},${Math.round(point.y * 100)}:${layers}`
      })

    expect(connectionA.__rootConnectionNames).toEqual(["net_a"])
    expect(connectionB.__rootConnectionNames).toEqual(["net_b"])
    expect(result.traces?.[0]?.connectsTo).not.toContain(
      "shared_provenance_alias",
    )
    expect(result.traces?.[1]?.connectsTo).not.toContain(
      "shared_provenance_alias",
    )
    expect(
      coordinateLayerHashes(connectionA).filter((hash) =>
        coordinateLayerHashes(connectionB).includes(hash),
      ),
    ).toEqual([])
  })

  test("disambiguates near boundary points with the same rounded connectivity hash", () => {
    const srj = createSrj({
      connections: [
        { name: "narrow_a", pointsToConnect: [] },
        { name: "narrow_b", pointsToConnect: [] },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "narrow_trace_a",
          connection_name: "narrow_a",
          route: [
            {
              route_type: "wire",
              x: -2,
              y: 0.001,
              layer: "top",
              width: 0.001,
            },
            {
              route_type: "wire",
              x: 2,
              y: 0.001,
              layer: "top",
              width: 0.001,
            },
          ],
        },
        {
          type: "pcb_trace",
          pcb_trace_id: "narrow_trace_b",
          connection_name: "narrow_b",
          route: [
            {
              route_type: "wire",
              x: -2,
              y: 0.004,
              layer: "top",
              width: 0.001,
            },
            {
              route_type: "wire",
              x: 2,
              y: 0.004,
              layer: "top",
              width: 0.001,
            },
          ],
        },
      ],
    })

    const result = extractSrjRegion(srj, crop)
    const [traceA, traceB] = result.traces ?? []
    if (!traceA || !traceB) throw new Error("Expected two narrow traces")
    const hashes = result.connections.map((connection) =>
      connection.pointsToConnect.map(
        (point) =>
          `${Math.round(point.x * 100)},${Math.round(point.y * 100)}:${
            "layers" in point ? point.layers.join("-") : point.layer
          }`,
      ),
    )

    expect(hashes[0]?.filter((hash) => hashes[1]?.includes(hash))).toEqual([])
    expect(getWirePoints(traceA)).toContainEqual({
      x: -1,
      y: 0.001,
    })
    expect(getWirePoints(traceB)[0]?.y).not.toBe(0.004)
  })

  test("suppresses only unrelated cut-swallowing obstacles outside protected bounds", () => {
    const obstacles: SimpleRouteJson["obstacles"] = [
      {
        obstacleId: "unrelated_pad",
        type: "rect",
        layers: ["top"],
        center: { x: -1.1, y: 0 },
        width: 0.4,
        height: 0.4,
        connectedTo: ["net_b"],
      },
      {
        obstacleId: "same_net_pad",
        type: "rect",
        layers: ["top"],
        center: { x: -1.1, y: 0 },
        width: 0.4,
        height: 0.4,
        connectedTo: ["net_a"],
      },
      {
        obstacleId: "unconnected_keepout",
        type: "rect",
        layers: ["top"],
        center: { x: -1.1, y: 0 },
        width: 0.4,
        height: 0.4,
        connectedTo: [],
      },
      {
        obstacleId: "protected_deep_pad",
        type: "rect",
        layers: ["top"],
        center: { x: -1.1, y: 0 },
        width: 1,
        height: 1,
        connectedTo: ["net_c"],
      },
    ]
    const srj = createSrj({
      obstacles,
      connections: [{ name: "net_a", pointsToConnect: [] }],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "trace_a",
          connection_name: "net_a",
          route: [
            { route_type: "wire", x: -2, y: 0, layer: "top", width: 0.2 },
            { route_type: "wire", x: 0, y: 0, layer: "top", width: 0.2 },
          ],
        },
      ],
    })
    const protectedBounds = { minX: -0.75, maxX: 0.75, minY: -0.75, maxY: 0.75 }

    const safeDefault = extractSrjRegion(srj, crop)
    const protectedResult = extractSrjRegion(srj, crop, { protectedBounds })

    expect(
      safeDefault.obstacles
        .map((obstacle) => obstacle.obstacleId)
        .filter((id) => id && !id.includes("__boundary_")),
    ).toEqual(obstacles.map((obstacle) => obstacle.obstacleId))
    expect(
      protectedResult.obstacles
        .map((obstacle) => obstacle.obstacleId)
        .filter((id) => id && !id.includes("__boundary_")),
    ).toEqual(["same_net_pad", "unconnected_keepout", "protected_deep_pad"])
    expect(() =>
      extractSrjRegion(srj, crop, {
        protectedBounds: { ...protectedBounds, minX: -2 },
      }),
    ).toThrow("contained")
  })

  test("disambiguates shared connection aliases with trace endpoint IDs", () => {
    const srj = createSrj({
      connections: [
        {
          name: "candidate_a",
          rootConnectionName: "shared_root",
          nominalTraceWidth: 0.4,
          pointsToConnect: [
            { x: -5, y: 0, layer: "top", pointId: "a_start" },
            { x: 5, y: 0, layer: "top", pointId: "a_end" },
          ],
        },
        {
          name: "candidate_b",
          rootConnectionName: "shared_root",
          nominalTraceWidth: 0.2,
          pointsToConnect: [
            {
              x: -0.5,
              y: 0,
              layer: "top",
              pointId: "b_start",
              pcb_port_id: "pcb_port_b_start",
            },
            {
              x: 0.5,
              y: 0,
              layer: "top",
              pointId: "b_end",
              pcb_port_id: "pcb_port_b_end",
            },
          ],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "shared_trace",
          connection_name: "shared_root",
          connectsTo: ["pcb_port_b_start", "pcb_port_b_end"],
          route: [
            {
              route_type: "wire",
              x: -0.5,
              y: 0,
              layer: "top",
              width: 0.2,
            },
            {
              route_type: "wire",
              x: 0.5,
              y: 0,
              layer: "top",
              width: 0.2,
            },
          ],
        },
      ],
    })

    const result = extractSrjRegion(srj, crop)
    const localConnection = result.connections.find((connection) =>
      connection.name.startsWith("shared_root__region_"),
    )

    expect(localConnection?.nominalTraceWidth).toBe(0.2)
    expect(localConnection?.pointsToConnect).toEqual(
      srj.connections[1]?.pointsToConnect,
    )
    expect(localConnection?.__rootConnectionNames).toEqual(["shared_root"])
    expect(result.traces?.[0]?.connectsTo).toEqual([
      "b_start",
      "pcb_port_b_start",
      "b_end",
      "pcb_port_b_end",
    ])
  })

  test("preserves an unchanged trace, via metadata, and original endpoints", () => {
    const srj = createSrj({
      connections: [
        {
          name: "layer_change",
          pointsToConnect: [
            {
              x: -0.5,
              y: 0,
              layer: "top",
              pointId: "start",
              pcb_port_id: "port_start",
            },
            {
              x: 0.5,
              y: 0,
              layers: ["top", "bottom"],
              pointId: "end",
              pcb_port_id: "port_end",
            },
          ],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "inside_trace",
          connection_name: "layer_change",
          route: [
            {
              route_type: "wire",
              x: -0.5,
              y: 0,
              layer: "top",
              width: 0.15,
            },
            {
              route_type: "via",
              x: 0,
              y: 0,
              from_layer: "top",
              to_layer: "bottom",
              via_diameter: 0.42,
              via_hole_diameter: 0.18,
            },
            {
              route_type: "wire",
              x: 0.5,
              y: 0,
              layer: "bottom",
              width: 0.15,
            },
          ],
        },
      ],
    })

    const result = extractSrjRegion(srj, crop)

    expect(result.traces?.[0]?.pcb_trace_id).toBe("inside_trace")
    expect(result.traces?.[0]?.route).toEqual(srj.traces?.[0]?.route)
    expect(result.connections[0]?.pointsToConnect).toEqual(
      srj.connections[0]?.pointsToConnect,
    )
    expect(result.connections[0]?.pointsToConnect).not.toBe(
      srj.connections[0]?.pointsToConnect,
    )
  })

  test("keeps an interior via while clipping its incoming and outgoing layers", () => {
    const srj = createSrj({
      connections: [
        {
          name: "via_net",
          pointsToConnect: [
            { x: -2, y: 0, layer: "top" },
            { x: 2, y: 0, layer: "bottom" },
          ],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "via_trace",
          connection_name: "via_net",
          route: [
            {
              route_type: "wire",
              x: -2,
              y: 0,
              layer: "top",
              width: 0.16,
            },
            {
              route_type: "via",
              x: 0,
              y: 0,
              from_layer: "top",
              to_layer: "bottom",
              via_diameter: 0.4,
              via_hole_diameter: 0.2,
            },
            {
              route_type: "wire",
              x: 2,
              y: 0,
              layer: "bottom",
              width: 0.16,
            },
          ],
        },
      ],
    })

    const result = extractSrjRegion(srj, crop)
    const route = result.traces?.[0]?.route ?? []

    expect(route.map((token) => token.route_type)).toEqual([
      "wire",
      "wire",
      "via",
      "wire",
      "wire",
    ])
    // Both ends of the outgoing wire must be explicit after the via so
    // adjacent-wire consumers retain its copper on the bottom layer.
    expect(route.filter((token) => token.route_type === "wire")).toEqual([
      { route_type: "wire", x: -1, y: 0, layer: "top", width: 0.16 },
      { route_type: "wire", x: 0, y: 0, layer: "top", width: 0.16 },
      { route_type: "wire", x: 0, y: 0, layer: "bottom", width: 0.16 },
      { route_type: "wire", x: 1, y: 0, layer: "bottom", width: 0.16 },
    ])
    expect(route.find((token) => token.route_type === "via")).toEqual({
      route_type: "via",
      x: 0,
      y: 0,
      from_layer: "top",
      to_layer: "bottom",
      via_diameter: 0.4,
      via_hole_diameter: 0.2,
    })
    expect(result.connections[0]?.pointsToConnect).toMatchObject([
      { x: -1, y: 0, layer: "top" },
      { x: 1, y: 0, layer: "bottom" },
    ])
  })

  test("drops a via outside the crop without joining fragments across layers", () => {
    const srj = createSrj({
      connections: [
        {
          name: "outside_via",
          pointsToConnect: [
            { x: -2, y: 0, layer: "top" },
            { x: 4, y: 0, layer: "bottom" },
          ],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "outside_via_trace",
          connection_name: "outside_via",
          route: [
            {
              route_type: "wire",
              x: -2,
              y: 0,
              layer: "top",
              width: 0.15,
            },
            {
              route_type: "via",
              x: 2,
              y: 0,
              from_layer: "top",
              to_layer: "bottom",
              via_diameter: 0.4,
            },
            {
              route_type: "wire",
              x: 4,
              y: 0,
              layer: "bottom",
              width: 0.15,
            },
          ],
        },
      ],
    })

    const result = extractSrjRegion(srj, crop)

    expect(result.traces).toHaveLength(1)
    expect(
      result.traces?.[0]?.route.some((token) => token.route_type === "via"),
    ).toBe(false)
    expect(
      result.traces?.[0]?.route.every(
        (token) => token.route_type !== "wire" || token.layer === "top",
      ),
    ).toBe(true)
  })

  test("splits a trace that leaves and re-enters the crop", () => {
    const srj = createSrj({
      obstacles: [
        {
          obstacleId: "trace_connected_pad",
          type: "rect",
          layers: ["top"],
          center: { x: 0, y: 0.25 },
          width: 0.2,
          height: 0.2,
          connectedTo: ["reentry_trace"],
        },
      ],
      connections: [
        {
          name: "reentry",
          pointsToConnect: [
            { x: -2, y: 0, layer: "top" },
            { x: -2, y: 0.5, layer: "top" },
          ],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "reentry_trace",
          connection_name: "reentry",
          route: [
            { route_type: "wire", x: -2, y: 0, layer: "top", width: 0.1 },
            { route_type: "wire", x: 0, y: 0, layer: "top", width: 0.1 },
            { route_type: "wire", x: 2, y: 0, layer: "top", width: 0.1 },
            { route_type: "wire", x: 2, y: 2, layer: "top", width: 0.1 },
            { route_type: "wire", x: 0, y: 0.5, layer: "top", width: 0.1 },
            {
              route_type: "wire",
              x: -2,
              y: 0.5,
              layer: "top",
              width: 0.1,
            },
          ],
        },
      ],
    })

    const result = extractSrjRegion(srj, crop)

    expect(result.traces).toHaveLength(2)
    expect(result.traces?.map((trace) => trace.pcb_trace_id)).toEqual([
      "reentry_trace__region_0",
      "reentry_trace__region_1",
    ])
    expect(result.connections).toHaveLength(2)
    expect(
      result.connections.every(
        (connection) => connection.pointsToConnect.length === 2,
      ),
    ).toBe(true)
    expect(
      result.connections.every((connection) =>
        connection.__rootConnectionNames?.includes("reentry"),
      ),
    ).toBe(true)
    expect(result.obstacles[0]?.connectedTo).toEqual(["reentry"])
  })

  test("retains crossing jumper and through-obstacle tokens whole", () => {
    const throughObstacle = {
      route_type: "through_obstacle" as const,
      start: { x: -2, y: 0.5 },
      end: { x: 2, y: 0.5 },
      from_layer: "top",
      to_layer: "bottom",
      width: 0.25,
      circuitJsonMetadata: { pcb_plated_hole_id: "hole" },
    }
    const jumper = {
      route_type: "jumper" as const,
      start: { x: -2, y: -0.5 },
      end: { x: 2, y: -0.5 },
      footprint: "0603" as const,
      layer: "top",
    }
    const srj = createSrj({
      connections: [
        { name: "atomic_a", pointsToConnect: [] },
        { name: "atomic_b", pointsToConnect: [] },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "atomic_trace_a",
          connection_name: "atomic_a",
          route: [throughObstacle],
        },
        {
          type: "pcb_trace",
          pcb_trace_id: "atomic_trace_b",
          connection_name: "atomic_b",
          route: [jumper],
        },
      ],
    })

    const result = extractSrjRegion(srj, crop)

    expect(result.traces?.[0]?.route).toEqual([throughObstacle])
    expect(result.traces?.[1]?.route).toEqual([jumper])
    expect(result.connections[0]?.pointsToConnect).toMatchObject([
      { x: -1, y: 0.5, layer: "top" },
      { x: 1, y: 0.5, layer: "bottom" },
    ])
    expect(result.connections[1]?.pointsToConnect).toMatchObject([
      { x: -1, y: -0.5, layer: "top" },
      { x: 1, y: -0.5, layer: "top" },
    ])

    expect(() =>
      extractSrjRegion(
        createSrj({
          connections: [
            { name: "first_atomic", pointsToConnect: [] },
            { name: "second_atomic", pointsToConnect: [] },
          ],
          traces: [
            {
              type: "pcb_trace",
              pcb_trace_id: "first_atomic_trace",
              connection_name: "first_atomic",
              route: [jumper],
            },
            {
              type: "pcb_trace",
              pcb_trace_id: "second_atomic_trace",
              connection_name: "second_atomic",
              route: [jumper],
            },
          ],
        }),
        crop,
      ),
    ).toThrow("distinct boundary terminal")
  })

  test("selects axis-aligned, rotated rectangle, and legacy oval obstacles by intersection", () => {
    const legacyObstacles = [
      {
        obstacleId: "inside",
        type: "rect",
        layers: ["top"],
        center: { x: 0, y: 0 },
        width: 0.2,
        height: 0.2,
        connectedTo: [],
      },
      {
        obstacleId: "rotated_hit",
        type: "rect",
        layers: ["top"],
        center: { x: 1.3, y: 1.3 },
        width: 2,
        height: 0.2,
        ccwRotationDegrees: 45,
        connectedTo: [],
      },
      {
        obstacleId: "rotated_miss",
        type: "rect",
        layers: ["top"],
        center: { x: 3, y: 3 },
        width: 2,
        height: 0.2,
        ccwRotationDegrees: 45,
        connectedTo: [],
      },
      {
        obstacleId: "oval_tangent",
        type: "oval",
        layers: ["top", "bottom"],
        center: { x: 2, y: 0 },
        width: 2,
        height: 0.5,
        connectedTo: ["plated_hole_net"],
      },
      {
        obstacleId: "rotated_oval_hit",
        type: "oval",
        layers: ["top"],
        center: { x: 1.4, y: 1.4 },
        width: 2,
        height: 0.2,
        ccwRotationDegrees: 45,
        connectedTo: [],
      },
      {
        obstacleId: "oval_miss",
        type: "oval",
        layers: ["top"],
        center: { x: 2.01, y: 0 },
        width: 2,
        height: 0.5,
        connectedTo: [],
      },
    ]
    const srj = createSrj({
      obstacles: legacyObstacles as unknown as SimpleRouteJson["obstacles"],
    })

    const result = extractSrjRegion(srj, crop)

    expect(result.obstacles.map((obstacle) => obstacle.obstacleId)).toEqual([
      "inside",
      "rotated_hit",
      "oval_tangent",
      "rotated_oval_hit",
    ])
    expect((result.obstacles[2] as unknown as { type: string }).type).toBe(
      "oval",
    )
    expect(result.obstacles[2]?.connectedTo).toEqual(["plated_hole_net"])
  })

  test("clips a closed board outline and preserves compact metadata", () => {
    const srj = createSrj({
      outline: [
        { x: -3, y: -3 },
        { x: 3, y: -3 },
        { x: 3, y: 3 },
        { x: -3, y: 3 },
        { x: -3, y: -3 },
      ],
    }) as SimpleRouteJson & { id: string; sourceUrl: string }
    srj.id = "sample001"
    srj.sourceUrl = "https://example.test/source"

    const result = extractSrjRegion(srj, crop) as SimpleRouteJson & {
      id: string
      sourceUrl: string
    }

    expect(result.id).toBe("sample001")
    expect(result.sourceUrl).toBe("https://example.test/source")
    expect(result.outline).toHaveLength(5)
    expect(result.outline?.[0]).toEqual(result.outline?.at(-1))
    expect(
      result.outline?.every(
        (point) =>
          point.x >= -1 && point.x <= 1 && point.y >= -1 && point.y <= 1,
      ),
    ).toBe(true)
    expect(
      new Set(
        result.outline?.slice(0, -1).map((point) => `${point.x},${point.y}`),
      ).size,
    ).toBe(4)
  })

  test("omits a disconnected concave outline intersection", () => {
    const srj = createSrj({
      outline: [
        { x: -3, y: -3 },
        { x: 3, y: -3 },
        { x: 3, y: 3 },
        { x: 1, y: 3 },
        { x: 1, y: -1 },
        { x: -1, y: -1 },
        { x: -1, y: 3 },
        { x: -3, y: 3 },
        { x: -3, y: -3 },
      ],
    })

    const result = extractSrjRegion(srj, {
      minX: -2,
      maxX: 2,
      minY: 0,
      maxY: 2,
    })

    expect(result.outline).toBeUndefined()
  })

  test("rewrites constraints only when each referenced connection has one local replacement", () => {
    const makeTrace = (name: string, y: number) => ({
      type: "pcb_trace" as const,
      pcb_trace_id: `trace_${name}`,
      connection_name: name,
      route: [
        { route_type: "wire" as const, x: -0.5, y, layer: "top", width: 0.1 },
        { route_type: "wire" as const, x: 0.5, y, layer: "top", width: 0.1 },
      ],
    })
    const srj = createSrj({
      connections: [
        {
          name: "positive",
          pointsToConnect: [
            { x: -0.5, y: -0.2, layer: "top" },
            { x: 0.5, y: -0.2, layer: "top" },
          ],
        },
        {
          name: "negative",
          pointsToConnect: [
            { x: -0.5, y: 0.2, layer: "top" },
            { x: 0.5, y: 0.2, layer: "top" },
          ],
        },
      ],
      traces: [makeTrace("positive", -0.2), makeTrace("negative", 0.2)],
      differentialPairs: [
        {
          connectionNames: ["positive", "negative"],
          lengthTolerance: 0.2,
          traceGap: 0.15,
        },
      ],
      buses: [
        {
          busId: "bus",
          connectionNames: ["positive", "negative"],
          maxLengthSkew: 0.5,
        },
      ],
    })

    const result = extractSrjRegion(srj, crop)
    const localNames: [string, string] = [
      result.connections[0]?.name ?? "missing-positive",
      result.connections[1]?.name ?? "missing-negative",
    ]

    expect(result.differentialPairs?.[0]?.connectionNames).toEqual(localNames)
    expect(result.buses?.[0]?.connectionNames).toEqual(localNames)

    const oneSided = extractSrjRegion(srj, {
      minX: -1,
      maxX: 1,
      minY: -0.3,
      maxY: 0,
    })
    expect(oneSided.differentialPairs).toEqual([])
    expect(oneSided.buses).toEqual([])
  })

  test("filters connection-only SRJ and top-level jumpers without inventing traces", () => {
    const insidePad = {
      type: "rect" as const,
      layers: ["top"],
      center: { x: 0, y: 0 },
      width: 0.4,
      height: 0.4,
      connectedTo: ["jumper_net"],
    }
    const outsidePad = {
      ...insidePad,
      center: { x: 8, y: 8 },
    }
    const srj = createSrj({
      connections: [
        {
          name: "partly_inside",
          pointsToConnect: [
            { x: 0, y: 0, layer: "top", pointId: "inside" },
            { x: 8, y: 8, layer: "top", pointId: "outside" },
          ],
        },
        {
          name: "outside",
          pointsToConnect: [{ x: 8, y: 8, layer: "top" }],
        },
      ],
      jumpers: [
        {
          jumper_footprint: "0603",
          center: { x: 0, y: 0 },
          orientation: "horizontal",
          width: 1.6,
          height: 0.8,
          pads: [insidePad],
        },
        {
          jumper_footprint: "0603",
          center: { x: 8, y: 8 },
          orientation: "horizontal",
          width: 1.6,
          height: 0.8,
          pads: [outsidePad],
        },
      ],
    })

    const result = extractSrjRegion(srj, crop)

    expect(result.traces).toBeUndefined()
    expect(result.connections).toEqual([
      {
        name: "partly_inside",
        pointsToConnect: [{ x: 0, y: 0, layer: "top", pointId: "inside" }],
      },
    ])
    expect(result.jumpers).toHaveLength(1)
    expect(result.jumpers?.[0]?.center).toEqual({ x: 0, y: 0 })
  })

  test("keeps an in-crop connection point when its routed trace is entirely outside", () => {
    const srj = createSrj({
      connections: [
        {
          name: "pad_net",
          pointsToConnect: [
            {
              x: 0,
              y: 0,
              layer: "top",
              pointId: "pad_point",
              pcb_port_id: "pcb_port_pad",
            },
            {
              x: 3,
              y: 3,
              layer: "top",
              pointId: "remote_point",
              pcb_port_id: "pcb_port_remote",
            },
          ],
        },
      ],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "outside_trace",
          connection_name: "pad_net",
          route: [
            { route_type: "wire", x: 2, y: 2, layer: "top", width: 0.1 },
            { route_type: "wire", x: 3, y: 3, layer: "top", width: 0.1 },
          ],
        },
      ],
    })

    const result = extractSrjRegion(srj, crop)

    expect(result.traces).toEqual([])
    expect(result.connections).toEqual([
      {
        name: "pad_net",
        pointsToConnect: [
          {
            x: 0,
            y: 0,
            layer: "top",
            pointId: "pad_point",
            pcb_port_id: "pcb_port_pad",
          },
        ],
      },
    ])
  })
})
