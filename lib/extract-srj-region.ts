import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"

export type ExtractSrjRegionBounds = SimpleRouteJson["bounds"]

export type ExtractSrjRegionOptions = {
  /**
   * Geometry in this sub-region must never be suppressed to break a false
   * boundary-terminal connectivity alias. Must be contained by `bounds`.
   */
  protectedBounds?: ExtractSrjRegionBounds
}

type Trace = NonNullable<SimpleRouteJson["traces"]>[number]
type RouteToken = Trace["route"][number]
type WireToken = Extract<RouteToken, { route_type: "wire" }>
type ViaToken = Extract<RouteToken, { route_type: "via" }>
type JumperToken = Extract<RouteToken, { route_type: "jumper" }>
type ThroughObstacleToken = Extract<
  RouteToken,
  { route_type: "through_obstacle" }
>
type AtomicToken = JumperToken | ThroughObstacleToken
type Connection = SimpleRouteJson["connections"][number]
type ConnectionPoint = Connection["pointsToConnect"][number]
type Obstacle = SimpleRouteJson["obstacles"][number]

/** Older SRJ producers emitted `oval` obstacles despite the current type. */
type RuntimeObstacle = Omit<Obstacle, "type"> & {
  type: string
  shape?: string
  ccw_rotation?: number
}

type Point = { x: number; y: number }
type PathNode = Point & {
  layer: string
  width: number
  sourceWire?: WireToken
}

type WirePrimitive = {
  kind: "wire"
  start: PathNode
  end: PathNode
}

type ViaPrimitive = {
  kind: "via"
  from: PathNode
  to: PathNode
  token: ViaToken
}

type AtomicPrimitive = {
  kind: "atomic"
  start: PathNode
  end: PathNode
  token: AtomicToken
}

type PathPrimitive = WirePrimitive | ViaPrimitive | AtomicPrimitive

type TraceFragment = {
  route: RouteToken[]
  start: PathNode
  end: PathNode
  startWasCut: boolean
  endWasCut: boolean
  unchanged: boolean
}

type FragmentBuilder = Omit<TraceFragment, "unchanged"> & {
  hasCopper: boolean
}

const EPSILON = 1e-9
const POSITION_EPSILON = 1e-7

const clone = <T>(value: T): T => structuredClone(value)

const assertValidBounds = (bounds: ExtractSrjRegionBounds) => {
  const coordinates = [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY]
  if (!coordinates.every(Number.isFinite)) {
    throw new Error("extractSrjRegion bounds must contain finite coordinates")
  }
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) {
    throw new Error("extractSrjRegion bounds must not be inverted")
  }
}

const pointIsInsideBounds = (point: Point, bounds: ExtractSrjRegionBounds) =>
  point.x >= bounds.minX - EPSILON &&
  point.x <= bounds.maxX + EPSILON &&
  point.y >= bounds.minY - EPSILON &&
  point.y <= bounds.maxY + EPSILON

const snapPointToBounds = <T extends Point>(
  point: T,
  bounds: ExtractSrjRegionBounds,
): T => ({
  ...point,
  x:
    Math.abs(point.x - bounds.minX) <= POSITION_EPSILON
      ? bounds.minX
      : Math.abs(point.x - bounds.maxX) <= POSITION_EPSILON
        ? bounds.maxX
        : point.x,
  y:
    Math.abs(point.y - bounds.minY) <= POSITION_EPSILON
      ? bounds.minY
      : Math.abs(point.y - bounds.maxY) <= POSITION_EPSILON
        ? bounds.maxY
        : point.y,
})

const pointsAreEqual = (left: Point, right: Point) =>
  Math.abs(left.x - right.x) <= POSITION_EPSILON &&
  Math.abs(left.y - right.y) <= POSITION_EPSILON

const nodesAreEqual = (left: PathNode, right: PathNode) =>
  pointsAreEqual(left, right) && left.layer === right.layer

/** Liang-Barsky interval for the portion of a segment inside a rectangle. */
const getSegmentInsideInterval = (
  start: Point,
  end: Point,
  bounds: ExtractSrjRegionBounds,
): { startT: number; endT: number } | null => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  let startT = 0
  let endT = 1

  const clip = (p: number, q: number) => {
    if (Math.abs(p) <= EPSILON) return q >= -EPSILON
    const ratio = q / p
    if (p < 0) {
      if (ratio > endT + EPSILON) return false
      startT = Math.max(startT, ratio)
    } else {
      if (ratio < startT - EPSILON) return false
      endT = Math.min(endT, ratio)
    }
    return true
  }

  if (!clip(-dx, start.x - bounds.minX)) return null
  if (!clip(dx, bounds.maxX - start.x)) return null
  if (!clip(-dy, start.y - bounds.minY)) return null
  if (!clip(dy, bounds.maxY - start.y)) return null
  if (startT > endT + EPSILON) return null

  return {
    startT: Math.max(0, Math.min(1, startT)),
    endT: Math.max(0, Math.min(1, endT)),
  }
}

const interpolateNode = (
  start: PathNode,
  end: PathNode,
  t: number,
): PathNode => {
  if (t <= EPSILON) return { ...start }
  if (t >= 1 - EPSILON) return { ...end }
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    layer: start.layer,
    width: start.width + (end.width - start.width) * t,
  }
}

const getBoundsCorners = (bounds: ExtractSrjRegionBounds): Point[] => [
  { x: bounds.minX, y: bounds.minY },
  { x: bounds.maxX, y: bounds.minY },
  { x: bounds.maxX, y: bounds.maxY },
  { x: bounds.minX, y: bounds.maxY },
]

const pointIsInsidePolygon = (point: Point, polygon: readonly Point[]) => {
  let previous = polygon.at(-1)
  if (!previous) return false
  let inside = false
  for (const current of polygon) {
    const cross =
      (point.y - previous.y) * (current.x - previous.x) -
      (point.x - previous.x) * (current.y - previous.y)
    const dot =
      (point.x - previous.x) * (current.x - previous.x) +
      (point.y - previous.y) * (current.y - previous.y)
    const squaredLength =
      (current.x - previous.x) ** 2 + (current.y - previous.y) ** 2
    if (
      Math.abs(cross) <= EPSILON &&
      dot >= -EPSILON &&
      dot <= squaredLength + EPSILON
    ) {
      return true
    }

    const crossesRay =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x
    if (crossesRay) inside = !inside
    previous = current
  }
  return inside
}

const polygonIntersectsBounds = (
  polygon: readonly Point[],
  bounds: ExtractSrjRegionBounds,
) => {
  if (polygon.some((point) => pointIsInsideBounds(point, bounds))) return true
  if (
    getBoundsCorners(bounds).some((point) =>
      pointIsInsidePolygon(point, polygon),
    )
  ) {
    return true
  }
  let previous = polygon.at(-1)
  if (!previous) return false
  for (const current of polygon) {
    if (getSegmentInsideInterval(previous, current, bounds)) return true
    previous = current
  }
  return false
}

const getRotationRadians = (obstacle: RuntimeObstacle) =>
  ((obstacle.ccwRotationDegrees ?? obstacle.ccw_rotation ?? 0) * Math.PI) / 180

const rotateLocalPoint = (
  localX: number,
  localY: number,
  center: Point,
  radians: number,
): Point => ({
  x: center.x + localX * Math.cos(radians) - localY * Math.sin(radians),
  y: center.y + localX * Math.sin(radians) + localY * Math.cos(radians),
})

const getRotatedRectCorners = (obstacle: RuntimeObstacle): Point[] => {
  const halfWidth = Math.abs(obstacle.width) / 2
  const halfHeight = Math.abs(obstacle.height) / 2
  const radians = getRotationRadians(obstacle)
  return [
    rotateLocalPoint(-halfWidth, -halfHeight, obstacle.center, radians),
    rotateLocalPoint(halfWidth, -halfHeight, obstacle.center, radians),
    rotateLocalPoint(halfWidth, halfHeight, obstacle.center, radians),
    rotateLocalPoint(-halfWidth, halfHeight, obstacle.center, radians),
  ]
}

const toEllipseLocalPoint = (
  point: Point,
  obstacle: RuntimeObstacle,
): Point => {
  const radians = -getRotationRadians(obstacle)
  const dx = point.x - obstacle.center.x
  const dy = point.y - obstacle.center.y
  return {
    x: dx * Math.cos(radians) - dy * Math.sin(radians),
    y: dx * Math.sin(radians) + dy * Math.cos(radians),
  }
}

const pointIsInsideEllipse = (point: Point, obstacle: RuntimeObstacle) => {
  const radiusX = Math.abs(obstacle.width) / 2
  const radiusY = Math.abs(obstacle.height) / 2
  if (radiusX <= EPSILON && radiusY <= EPSILON) {
    return pointsAreEqual(point, obstacle.center)
  }
  const local = toEllipseLocalPoint(point, obstacle)
  if (radiusX <= EPSILON) {
    return (
      Math.abs(local.x) <= POSITION_EPSILON &&
      Math.abs(local.y) <= radiusY + EPSILON
    )
  }
  if (radiusY <= EPSILON) {
    return (
      Math.abs(local.y) <= POSITION_EPSILON &&
      Math.abs(local.x) <= radiusX + EPSILON
    )
  }
  return (
    (local.x * local.x) / (radiusX * radiusX) +
      (local.y * local.y) / (radiusY * radiusY) <=
    1 + EPSILON
  )
}

const orientation = (first: Point, second: Point, third: Point) =>
  (second.y - first.y) * (third.x - second.x) -
  (second.x - first.x) * (third.y - second.y)

const pointIsOnSegment = (point: Point, start: Point, end: Point) =>
  point.x <= Math.max(start.x, end.x) + EPSILON &&
  point.x >= Math.min(start.x, end.x) - EPSILON &&
  point.y <= Math.max(start.y, end.y) + EPSILON &&
  point.y >= Math.min(start.y, end.y) - EPSILON

const segmentsIntersect = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
) => {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart)
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd)
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart)
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd)
  if (
    firstOrientation * secondOrientation < -EPSILON &&
    thirdOrientation * fourthOrientation < -EPSILON
  ) {
    return true
  }
  if (
    Math.abs(firstOrientation) <= EPSILON &&
    pointIsOnSegment(secondStart, firstStart, firstEnd)
  ) {
    return true
  }
  if (
    Math.abs(secondOrientation) <= EPSILON &&
    pointIsOnSegment(secondEnd, firstStart, firstEnd)
  ) {
    return true
  }
  if (
    Math.abs(thirdOrientation) <= EPSILON &&
    pointIsOnSegment(firstStart, secondStart, secondEnd)
  ) {
    return true
  }
  return (
    Math.abs(fourthOrientation) <= EPSILON &&
    pointIsOnSegment(firstEnd, secondStart, secondEnd)
  )
}

const polygonIsSimple = (polygon: readonly Point[]) => {
  for (let firstIndex = 0; firstIndex < polygon.length; firstIndex += 1) {
    const firstEndIndex = (firstIndex + 1) % polygon.length
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < polygon.length;
      secondIndex += 1
    ) {
      const secondEndIndex = (secondIndex + 1) % polygon.length
      const edgesAreAdjacent =
        firstIndex === secondEndIndex || firstEndIndex === secondIndex
      if (edgesAreAdjacent) continue
      const firstStart = polygon[firstIndex]
      const firstEnd = polygon[firstEndIndex]
      const secondStart = polygon[secondIndex]
      const secondEnd = polygon[secondEndIndex]
      if (!firstStart || !firstEnd || !secondStart || !secondEnd) return false
      if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) {
        return false
      }
    }
  }
  return true
}

const segmentIntersectsEllipse = (
  start: Point,
  end: Point,
  obstacle: RuntimeObstacle,
) => {
  if (
    pointIsInsideEllipse(start, obstacle) ||
    pointIsInsideEllipse(end, obstacle)
  ) {
    return true
  }

  const radiusX = Math.abs(obstacle.width) / 2
  const radiusY = Math.abs(obstacle.height) / 2
  if (radiusX <= EPSILON || radiusY <= EPSILON) {
    const radians = getRotationRadians(obstacle)
    const halfLength = Math.max(radiusX, radiusY)
    const axisRadians = radiusY > radiusX ? radians + Math.PI / 2 : radians
    const axisStart = {
      x: obstacle.center.x - Math.cos(axisRadians) * halfLength,
      y: obstacle.center.y - Math.sin(axisRadians) * halfLength,
    }
    const axisEnd = {
      x: obstacle.center.x + Math.cos(axisRadians) * halfLength,
      y: obstacle.center.y + Math.sin(axisRadians) * halfLength,
    }
    return segmentsIntersect(start, end, axisStart, axisEnd)
  }

  const localStart = toEllipseLocalPoint(start, obstacle)
  const localEnd = toEllipseLocalPoint(end, obstacle)
  const dx = localEnd.x - localStart.x
  const dy = localEnd.y - localStart.y
  const a = (dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY)
  const b =
    (2 * localStart.x * dx) / (radiusX * radiusX) +
    (2 * localStart.y * dy) / (radiusY * radiusY)
  const c =
    (localStart.x * localStart.x) / (radiusX * radiusX) +
    (localStart.y * localStart.y) / (radiusY * radiusY) -
    1
  if (Math.abs(a) <= EPSILON) return false
  const discriminant = b * b - 4 * a * c
  if (discriminant < -EPSILON) return false
  const root = Math.sqrt(Math.max(0, discriminant))
  const firstT = (-b - root) / (2 * a)
  const secondT = (-b + root) / (2 * a)
  return (
    (firstT >= -EPSILON && firstT <= 1 + EPSILON) ||
    (secondT >= -EPSILON && secondT <= 1 + EPSILON)
  )
}

const ellipseIntersectsBounds = (
  obstacle: RuntimeObstacle,
  bounds: ExtractSrjRegionBounds,
) => {
  if (pointIsInsideBounds(obstacle.center, bounds)) return true
  const corners = getBoundsCorners(bounds)
  if (corners.some((corner) => pointIsInsideEllipse(corner, obstacle))) {
    return true
  }
  let previous = corners.at(-1)
  if (!previous) return false
  for (const current of corners) {
    if (segmentIntersectsEllipse(previous, current, obstacle)) {
      return true
    }
    previous = current
  }
  return false
}

const obstacleIntersectsBounds = (
  obstacle: RuntimeObstacle,
  bounds: ExtractSrjRegionBounds,
) => {
  const isEllipse =
    obstacle.type === "oval" ||
    obstacle.shape === "oval" ||
    obstacle.shape === "circle"
  return isEllipse
    ? ellipseIntersectsBounds(obstacle, bounds)
    : polygonIntersectsBounds(getRotatedRectCorners(obstacle), bounds)
}

const pointIsInsideObstacle = (point: Point, obstacle: RuntimeObstacle) => {
  const isEllipse =
    obstacle.type === "oval" ||
    obstacle.shape === "oval" ||
    obstacle.shape === "circle"
  return isEllipse
    ? pointIsInsideEllipse(point, obstacle)
    : pointIsInsidePolygon(point, getRotatedRectCorners(obstacle))
}

const getWireNode = (token: WireToken): PathNode => ({
  x: token.x,
  y: token.y,
  layer: token.layer,
  width: token.width,
  sourceWire: token,
})

const getAtomicNodes = (
  token: AtomicToken,
  fallbackWidth: number,
): { start: PathNode; end: PathNode } => {
  if (token.route_type === "jumper") {
    return {
      start: { ...token.start, layer: token.layer, width: fallbackWidth },
      end: { ...token.end, layer: token.layer, width: fallbackWidth },
    }
  }
  return {
    start: {
      ...token.start,
      layer: token.from_layer,
      width: token.width,
    },
    end: { ...token.end, layer: token.to_layer, width: token.width },
  }
}

const appendWirePrimitive = (
  primitives: PathPrimitive[],
  cursor: PathNode | null,
  target: PathNode,
  expectedLayer: string,
  width: number,
) => {
  if (!cursor || pointsAreEqual(cursor, target)) return
  primitives.push({
    kind: "wire",
    start: { ...cursor, layer: expectedLayer, width },
    end: { ...target, layer: expectedLayer, width },
  })
}

const buildPathPrimitives = (trace: Trace, fallbackWidth: number) => {
  const primitives: PathPrimitive[] = []
  let cursor: PathNode | null = null

  for (const token of trace.route) {
    if (token.route_type === "wire") {
      const target = getWireNode(token)
      // A wire point's width/layer describe the segment beginning at that
      // point. Use the previous wire's metadata for wire-to-wire segments;
      // synthetic cursors after vias or atomic tokens fall back to the target.
      appendWirePrimitive(
        primitives,
        cursor,
        target,
        cursor?.sourceWire?.layer ?? token.layer,
        cursor?.sourceWire?.width ?? token.width,
      )
      cursor = target
      continue
    }

    if (token.route_type === "via") {
      const width = cursor?.width ?? fallbackWidth
      const from: PathNode = {
        x: token.x,
        y: token.y,
        layer: token.from_layer,
        width,
      }
      const to: PathNode = { ...from, layer: token.to_layer }
      appendWirePrimitive(primitives, cursor, from, token.from_layer, width)
      primitives.push({ kind: "via", from, to, token })
      cursor = to
      continue
    }

    const { start, end } = getAtomicNodes(token, cursor?.width ?? fallbackWidth)
    appendWirePrimitive(primitives, cursor, start, start.layer, start.width)
    primitives.push({ kind: "atomic", start, end, token })
    cursor = end
  }

  return primitives
}

const getTokenStartNode = (
  token: RouteToken,
  fallbackWidth: number,
): PathNode => {
  if (token.route_type === "wire") return getWireNode(token)
  if (token.route_type === "via") {
    return {
      x: token.x,
      y: token.y,
      layer: token.from_layer,
      width: fallbackWidth,
    }
  }
  return getAtomicNodes(token, fallbackWidth).start
}

const getTokenEndNode = (
  token: RouteToken,
  fallbackWidth: number,
): PathNode => {
  if (token.route_type === "wire") return getWireNode(token)
  if (token.route_type === "via") {
    return {
      x: token.x,
      y: token.y,
      layer: token.to_layer,
      width: fallbackWidth,
    }
  }
  return getAtomicNodes(token, fallbackWidth).end
}

const traceIsCompletelyInside = (
  trace: Trace,
  bounds: ExtractSrjRegionBounds,
) =>
  trace.route.every((token) => {
    if (token.route_type === "wire" || token.route_type === "via") {
      return pointIsInsideBounds(token, bounds)
    }
    return (
      pointIsInsideBounds(token.start, bounds) &&
      pointIsInsideBounds(token.end, bounds)
    )
  })

const makeWireToken = (node: PathNode): WireToken => {
  if (
    node.sourceWire &&
    pointsAreEqual(node, node.sourceWire) &&
    node.layer === node.sourceWire.layer
  ) {
    return clone(node.sourceWire)
  }
  return {
    route_type: "wire",
    x: node.x,
    y: node.y,
    layer: node.layer,
    width: node.width,
  }
}

const addBoundaryTerminalStubs = (
  fragment: TraceFragment,
  startTerminal: PathNode,
  endTerminal: PathNode,
): RouteToken[] => {
  const route = clone(fragment.route)
  if (
    fragment.startWasCut &&
    !nodesAreEqual(startTerminal, fragment.start) &&
    route[0]?.route_type === "wire"
  ) {
    route.unshift(makeWireToken(startTerminal))
  }
  if (
    fragment.endWasCut &&
    !nodesAreEqual(endTerminal, fragment.end) &&
    route.at(-1)?.route_type === "wire"
  ) {
    route.push(makeWireToken(endTerminal))
  }
  return route
}

const appendWireNode = (builder: FragmentBuilder, node: PathNode) => {
  const previous = builder.route.at(-1)
  if (
    previous?.route_type === "wire" &&
    pointsAreEqual(previous, node) &&
    previous.layer === node.layer
  ) {
    return
  }
  builder.route.push(makeWireToken(node))
}

const clipTrace = (
  trace: Trace,
  bounds: ExtractSrjRegionBounds,
  fallbackWidth: number,
): TraceFragment[] => {
  if (trace.route.length === 0) return []
  if (traceIsCompletelyInside(trace, bounds)) {
    const firstToken = trace.route[0]
    const lastToken = trace.route.at(-1)
    if (!firstToken || !lastToken) return []
    return [
      {
        route: clone(trace.route),
        start: getTokenStartNode(firstToken, fallbackWidth),
        end: getTokenEndNode(lastToken, fallbackWidth),
        startWasCut: false,
        endWasCut: false,
        unchanged: true,
      },
    ]
  }

  const fragments: TraceFragment[] = []
  let current: FragmentBuilder | null = null

  const flush = () => {
    if (current?.hasCopper) {
      fragments.push({
        route: current.route,
        start: current.start,
        end: current.end,
        startWasCut: current.startWasCut,
        endWasCut: current.endWasCut,
        unchanged: false,
      })
    }
    current = null
  }

  const createFragment = (
    node: PathNode,
    wasCut: boolean,
  ): FragmentBuilder => ({
    route: [makeWireToken(node)],
    start: node,
    end: node,
    startWasCut: wasCut,
    endWasCut: false,
    hasCopper: false,
  })

  for (const primitive of buildPathPrimitives(trace, fallbackWidth)) {
    if (primitive.kind === "wire") {
      const interval = getSegmentInsideInterval(
        primitive.start,
        primitive.end,
        bounds,
      )
      if (!interval) {
        flush()
        continue
      }
      const clippedStart = snapPointToBounds(
        interpolateNode(primitive.start, primitive.end, interval.startT),
        bounds,
      )
      const clippedEnd = snapPointToBounds(
        interpolateNode(primitive.start, primitive.end, interval.endT),
        bounds,
      )
      const startWasCut = interval.startT > EPSILON
      const endWasCut = interval.endT < 1 - EPSILON

      if (!current || !nodesAreEqual(current.end, clippedStart)) {
        flush()
        current = createFragment(clippedStart, startWasCut)
      }
      const activeFragment = current
      if (!activeFragment) {
        throw new Error("Failed to initialize clipped trace fragment")
      }
      if (!pointsAreEqual(clippedStart, clippedEnd)) {
        // Vias and atomic tokens end at this coordinate but do not supply
        // the outgoing wire's origin or width to adjacent-wire consumers.
        appendWireNode(activeFragment, clippedStart)
        appendWireNode(activeFragment, clippedEnd)
        activeFragment.end = clippedEnd
        activeFragment.hasCopper = true
      }
      activeFragment.endWasCut = endWasCut
      if (endWasCut) flush()
      continue
    }

    if (primitive.kind === "via") {
      if (!pointIsInsideBounds(primitive.from, bounds)) {
        flush()
        continue
      }
      if (!current || !nodesAreEqual(current.end, primitive.from)) {
        flush()
        current = {
          route: [],
          start: primitive.from,
          end: primitive.from,
          startWasCut: false,
          endWasCut: false,
          hasCopper: false,
        }
      }
      current.route.push(clone(primitive.token))
      current.end = primitive.to
      current.hasCopper = true
      continue
    }

    const interval = getSegmentInsideInterval(
      primitive.start,
      primitive.end,
      bounds,
    )
    if (!interval) {
      flush()
      continue
    }
    const fullyInside =
      pointIsInsideBounds(primitive.start, bounds) &&
      pointIsInsideBounds(primitive.end, bounds)
    if (fullyInside) {
      if (!current || !nodesAreEqual(current.end, primitive.start)) {
        flush()
        current = {
          route: [],
          start: primitive.start,
          end: primitive.start,
          startWasCut: false,
          endWasCut: false,
          hasCopper: false,
        }
      }
      current.route.push(clone(primitive.token))
      current.end = primitive.end
      current.hasCopper = true
      continue
    }

    flush()
    const terminalStart = snapPointToBounds(
      {
        ...interpolateNode(primitive.start, primitive.end, interval.startT),
        layer: primitive.start.layer,
      },
      bounds,
    )
    const terminalEnd = snapPointToBounds(
      {
        ...interpolateNode(primitive.start, primitive.end, interval.endT),
        layer: primitive.end.layer,
      },
      bounds,
    )
    current = {
      route: [clone(primitive.token)],
      start: terminalStart,
      end: terminalEnd,
      startWasCut: !pointIsInsideBounds(primitive.start, bounds),
      endWasCut: !pointIsInsideBounds(primitive.end, bounds),
      hasCopper: true,
    }
    flush()
  }
  flush()
  return fragments
}

const allocateId = (base: string, usedIds: Set<string>) => {
  let candidate = base
  let suffix = 2
  while (usedIds.has(candidate)) {
    candidate = `${base}_${suffix}`
    suffix += 1
  }
  usedIds.add(candidate)
  return candidate
}

const getPointLayers = (point: ConnectionPoint) =>
  "layer" in point ? [point.layer] : point.layers

const findMatchingConnectionPoint = (
  connection: Connection | undefined,
  node: PathNode,
) =>
  connection?.pointsToConnect.find(
    (point) =>
      pointsAreEqual(point, node) && getPointLayers(point).includes(node.layer),
  )

const uniqueStrings = (values: Array<string | undefined>) =>
  Array.from(new Set(values.filter((value): value is string => Boolean(value))))

type TraceNetContext = {
  canonicalName: string
  aliases: string[]
  provenanceAliases: Set<string>
}

const getTraceNetContext = (
  trace: Trace,
  originalConnection: Connection | undefined,
): TraceNetContext => {
  const canonicalName =
    originalConnection?.__netConnectionName ?? trace.connection_name
  const aliases = uniqueStrings([
    canonicalName,
    trace.connection_name,
    originalConnection?.__netConnectionName,
    originalConnection?.netConnectionName,
    ...(originalConnection?.__rootConnectionNames ?? []),
    originalConnection?.rootConnectionName,
  ])
  const provenanceAliases = new Set(
    uniqueStrings([
      ...aliases,
      originalConnection?.name,
      ...(originalConnection?.mergedConnectionNames ?? []),
      trace.pcb_trace_id,
      ...(trace.connectsTo ?? []),
      ...(originalConnection?.pointsToConnect.flatMap((point) => [
        point.pointId,
        "pcb_port_id" in point ? point.pcb_port_id : undefined,
      ]) ?? []),
    ]),
  )
  return { canonicalName, aliases, provenanceAliases }
}

const getConnectionPointAliases = (point: ConnectionPoint) =>
  uniqueStrings([
    point.pointId,
    "pcb_port_id" in point ? point.pcb_port_id : undefined,
  ])

const getRoundedCoordinateLayerHash = (node: PathNode) =>
  `${Math.round(node.x * 100)},${Math.round(node.y * 100)}:${node.layer}`

const resolveConnectionForTrace = (trace: Trace, connections: Connection[]) => {
  const exact = connections.find(
    (connection) => connection.name === trace.connection_name,
  )
  if (exact) return exact

  const aliasCandidates = connections.filter(
    (connection) =>
      connection.rootConnectionName === trace.connection_name ||
      connection.netConnectionName === trace.connection_name ||
      connection.__netConnectionName === trace.connection_name ||
      connection.__rootConnectionNames?.includes(trace.connection_name) ||
      connection.mergedConnectionNames?.includes(trace.connection_name),
  )
  if (aliasCandidates.length <= 1) return aliasCandidates[0]

  const traceAliases = new Set(trace.connectsTo ?? [])
  const scoredCandidates = aliasCandidates.map((connection) => ({
    connection,
    score: connection.pointsToConnect.reduce((score, point) => {
      const aliases = [
        point.pointId,
        "pcb_port_id" in point ? point.pcb_port_id : undefined,
      ]
      return (
        score +
        aliases.filter((alias) => alias && traceAliases.has(alias)).length
      )
    }, 0),
  }))
  const bestScore = Math.max(
    ...scoredCandidates.map((candidate) => candidate.score),
  )
  const bestCandidates = scoredCandidates.filter(
    (candidate) => candidate.score === bestScore && candidate.score > 0,
  )
  return bestCandidates.length === 1 ? bestCandidates[0]?.connection : undefined
}

const addReplacement = (
  replacements: Map<string, string[]>,
  originalName: string | undefined,
  replacementName: string,
) => {
  if (!originalName) return
  const existing = replacements.get(originalName) ?? []
  if (!existing.includes(replacementName)) existing.push(replacementName)
  replacements.set(originalName, existing)
}

const createBoundaryObstacle = ({
  node,
  obstacleId,
  localConnectionName,
  rootNames,
}: {
  node: PathNode
  obstacleId: string
  localConnectionName: string
  rootNames: string[]
}): Obstacle => ({
  obstacleId,
  type: "rect",
  layers: [node.layer],
  center: { x: node.x, y: node.y },
  width: node.width,
  height: node.width,
  connectedTo: uniqueStrings([localConnectionName, ...rootNames]),
})

const clipOutline = (
  outline: readonly Point[],
  bounds: ExtractSrjRegionBounds,
): Point[] | undefined => {
  let polygon = outline.map((point) => ({ ...point }))
  const firstOutlinePoint = polygon[0]
  const lastOutlinePoint = polygon.at(-1)
  if (
    polygon.length > 1 &&
    firstOutlinePoint &&
    lastOutlinePoint &&
    pointsAreEqual(firstOutlinePoint, lastOutlinePoint)
  ) {
    polygon.pop()
  }
  if (polygon.length < 3) return undefined

  type ClipEdge = {
    inside: (point: Point) => boolean
    intersect: (start: Point, end: Point) => Point
  }
  const edges: ClipEdge[] = [
    {
      inside: (point) => point.x >= bounds.minX - EPSILON,
      intersect: (start, end) => {
        const t = (bounds.minX - start.x) / (end.x - start.x)
        return { x: bounds.minX, y: start.y + (end.y - start.y) * t }
      },
    },
    {
      inside: (point) => point.x <= bounds.maxX + EPSILON,
      intersect: (start, end) => {
        const t = (bounds.maxX - start.x) / (end.x - start.x)
        return { x: bounds.maxX, y: start.y + (end.y - start.y) * t }
      },
    },
    {
      inside: (point) => point.y >= bounds.minY - EPSILON,
      intersect: (start, end) => {
        const t = (bounds.minY - start.y) / (end.y - start.y)
        return { x: start.x + (end.x - start.x) * t, y: bounds.minY }
      },
    },
    {
      inside: (point) => point.y <= bounds.maxY + EPSILON,
      intersect: (start, end) => {
        const t = (bounds.maxY - start.y) / (end.y - start.y)
        return { x: start.x + (end.x - start.x) * t, y: bounds.maxY }
      },
    },
  ]

  for (const edge of edges) {
    const input = polygon
    polygon = []
    if (input.length === 0) break
    let previous = input.at(-1)
    if (!previous) break
    for (const current of input) {
      const currentInside = edge.inside(current)
      const previousInside = edge.inside(previous)
      if (currentInside) {
        if (!previousInside) polygon.push(edge.intersect(previous, current))
        polygon.push(current)
      } else if (previousInside) {
        polygon.push(edge.intersect(previous, current))
      }
      previous = current
    }
  }

  const deduplicated: Point[] = []
  for (const point of polygon.map((value) =>
    snapPointToBounds(value, bounds),
  )) {
    const previous = deduplicated.at(-1)
    if (!previous || !pointsAreEqual(previous, point)) {
      deduplicated.push(point)
    }
  }
  const firstDeduplicatedPoint = deduplicated[0]
  const lastDeduplicatedPoint = deduplicated.at(-1)
  if (
    deduplicated.length > 1 &&
    firstDeduplicatedPoint &&
    lastDeduplicatedPoint &&
    pointsAreEqual(firstDeduplicatedPoint, lastDeduplicatedPoint)
  ) {
    deduplicated.pop()
  }
  if (deduplicated.length < 3) return undefined
  // A single SRJ outline cannot represent disconnected intersections. A
  // concave board clipped across separate lobes produces a weakly-simple ring
  // with bridge/self-overlap edges; omit it rather than inventing a board edge.
  if (!polygonIsSimple(deduplicated)) return undefined
  const firstPoint = deduplicated[0]
  if (!firstPoint) return undefined
  return [...deduplicated, { ...firstPoint }]
}

const jumperIntersectsBounds = (
  jumper: NonNullable<SimpleRouteJson["jumpers"]>[number],
  bounds: ExtractSrjRegionBounds,
) => {
  const body: RuntimeObstacle = {
    type: "rect",
    layers: [],
    connectedTo: [],
    center: jumper.center,
    width: jumper.width,
    height: jumper.height,
  }
  return (
    obstacleIntersectsBounds(body, bounds) ||
    jumper.pads.some((pad) =>
      obstacleIntersectsBounds(pad as RuntimeObstacle, bounds),
    )
  )
}

/**
 * Extract a bounded SRJ problem while preserving connectivity at its boundary.
 *
 * Wire centerlines are clipped to `bounds`. Vias are retained by center
 * containment. Jumper and through-obstacle route tokens are atomic: a token
 * that crosses the crop is retained whole, while its local connection uses the
 * actual rectangle intersections as immutable boundary terminals.
 */
export const extractSrjRegion = (
  srj: SimpleRouteJson,
  bounds: ExtractSrjRegionBounds,
  options: ExtractSrjRegionOptions = {},
): SimpleRouteJson => {
  assertValidBounds(bounds)
  const { protectedBounds } = options
  if (protectedBounds) {
    assertValidBounds(protectedBounds)
    if (
      protectedBounds.minX < bounds.minX - EPSILON ||
      protectedBounds.maxX > bounds.maxX + EPSILON ||
      protectedBounds.minY < bounds.minY - EPSILON ||
      protectedBounds.maxY > bounds.maxY + EPSILON
    ) {
      throw new Error(
        "extractSrjRegion protectedBounds must be contained by bounds",
      )
    }
  }

  const usedTraceIds = new Set(
    (srj.traces ?? []).map((trace) => trace.pcb_trace_id),
  )
  const usedConnectionNames = new Set(
    srj.connections.map((connection) => connection.name),
  )
  const usedPointIds = new Set(
    srj.connections.flatMap((connection) =>
      connection.pointsToConnect.flatMap((point) =>
        point.pointId ? [point.pointId] : [],
      ),
    ),
  )
  const usedObstacleIds = new Set(
    srj.obstacles.flatMap((obstacle) =>
      obstacle.obstacleId ? [obstacle.obstacleId] : [],
    ),
  )

  const intersectingInputObstacles = srj.obstacles.filter((obstacle) =>
    obstacleIntersectsBounds(obstacle as RuntimeObstacle, bounds),
  )
  const boundaryObstacles: Obstacle[] = []
  const artificialCutEndpoints: Array<{
    point: Point
    provenanceAliases: Set<string>
  }> = []
  const outputTraces: Trace[] = []
  const outputConnections: Connection[] = []
  const consumedConnections = new Set<string>()
  const connectionReplacements = new Map<string, string[]>()
  const traceContexts = new Map<Trace, TraceNetContext>()
  const traceFragments = new Map<Trace, TraceFragment[]>()
  const canonicalNameByTraceId = new Map<string, string>()
  const ambiguousTraceIds = new Set<string>()
  const boundaryTerminalReservations: Array<{
    node: PathNode
    canonicalName: string
  }> = []

  const allocateBoundaryTerminal = (
    node: PathNode,
    canonicalName: string,
    allowShift: boolean,
  ): PathNode => {
    const candidateOffsets = [0]
    if (allowShift) {
      for (let offsetStep = 1; offsetStep <= 90; offsetStep += 1) {
        candidateOffsets.push(offsetStep / 100, -offsetStep / 100)
      }
    }
    const onVerticalEdge =
      Math.abs(node.x - bounds.minX) <= POSITION_EPSILON ||
      Math.abs(node.x - bounds.maxX) <= POSITION_EPSILON
    const onHorizontalEdge =
      Math.abs(node.y - bounds.minY) <= POSITION_EPSILON ||
      Math.abs(node.y - bounds.maxY) <= POSITION_EPSILON
    const candidateNodes: PathNode[] = []
    for (const offset of candidateOffsets) {
      if (onVerticalEdge) candidateNodes.push({ ...node, y: node.y + offset })
      if (onHorizontalEdge) candidateNodes.push({ ...node, x: node.x + offset })
    }

    const terminal = candidateNodes.find((candidate) => {
      if (!pointIsInsideBounds(candidate, bounds)) return false
      return boundaryTerminalReservations.every((reservation) => {
        if (reservation.canonicalName === canonicalName) return true
        if (
          getRoundedCoordinateLayerHash(candidate) ===
          getRoundedCoordinateLayerHash(reservation.node)
        ) {
          return false
        }
        const halfWidth =
          Math.max(candidate.width, reservation.node.width) / 2 + EPSILON
        return (
          Math.abs(candidate.x - reservation.node.x) > halfWidth ||
          Math.abs(candidate.y - reservation.node.y) > halfWidth
        )
      })
    })
    if (!terminal) {
      throw new Error(
        `Could not allocate a distinct boundary terminal for ${canonicalName} at (${node.x}, ${node.y})`,
      )
    }
    boundaryTerminalReservations.push({ node: terminal, canonicalName })
    return terminal
  }

  for (const trace of srj.traces ?? []) {
    const originalConnection = resolveConnectionForTrace(trace, srj.connections)
    const context = getTraceNetContext(trace, originalConnection)
    const fragments = clipTrace(trace, bounds, srj.minTraceWidth)
    traceContexts.set(trace, context)
    traceFragments.set(trace, fragments)
    const existingCanonicalName = canonicalNameByTraceId.get(trace.pcb_trace_id)
    if (ambiguousTraceIds.has(trace.pcb_trace_id)) {
      // Leave ambiguous duplicate IDs unmapped.
    } else if (existingCanonicalName === undefined) {
      canonicalNameByTraceId.set(trace.pcb_trace_id, context.canonicalName)
    } else if (existingCanonicalName !== context.canonicalName) {
      // Duplicate trace IDs are invalid provenance and cannot be normalized
      // safely to either net.
      canonicalNameByTraceId.delete(trace.pcb_trace_id)
      ambiguousTraceIds.add(trace.pcb_trace_id)
    }
    for (const fragment of fragments) {
      for (const [node, wasCut, routeToken] of [
        [fragment.start, fragment.startWasCut, fragment.route[0]],
        [fragment.end, fragment.endWasCut, fragment.route.at(-1)],
      ] as const) {
        if (!wasCut || routeToken?.route_type === "wire") continue
        // Atomic tokens cannot accept a boundary stub. Reserve their exact
        // intersections before allocating shiftable wire terminals so output
        // does not depend on trace order.
        boundaryTerminalReservations.push({
          node,
          canonicalName: context.canonicalName,
        })
      }
    }
  }

  for (const trace of srj.traces ?? []) {
    const fragments = traceFragments.get(trace)
    if (!fragments) throw new Error("Missing clipped trace fragments")
    const originalConnection = resolveConnectionForTrace(trace, srj.connections)
    const netContext = traceContexts.get(trace)
    if (!netContext) throw new Error("Missing trace net context")
    if (originalConnection && fragments.length > 0) {
      consumedConnections.add(originalConnection.name)
    }

    for (const [fragmentIndex, fragment] of fragments.entries()) {
      const traceId =
        fragments.length === 1
          ? trace.pcb_trace_id
          : allocateId(
              `${trace.pcb_trace_id}__region_${fragmentIndex}`,
              usedTraceIds,
            )
      const localConnectionName = allocateId(
        `${trace.connection_name}__region_${trace.pcb_trace_id}_${fragmentIndex}`,
        usedConnectionNames,
      )
      const rootNames = netContext.aliases
      const startTerminal = fragment.startWasCut
        ? allocateBoundaryTerminal(
            fragment.start,
            netContext.canonicalName,
            fragment.route[0]?.route_type === "wire",
          )
        : fragment.start
      const endTerminal = fragment.endWasCut
        ? allocateBoundaryTerminal(
            fragment.end,
            netContext.canonicalName,
            fragment.route.at(-1)?.route_type === "wire",
          )
        : fragment.end

      const createEndpoint = (
        node: PathNode,
        endpoint: "start" | "end",
        wasCut: boolean,
      ): ConnectionPoint => {
        const originalPoint = wasCut
          ? undefined
          : findMatchingConnectionPoint(originalConnection, node)
        if (originalPoint) return clone(originalPoint)
        return {
          x: node.x,
          y: node.y,
          layer: node.layer,
          pointId: allocateId(
            `${localConnectionName}__${endpoint}_point`,
            usedPointIds,
          ),
        }
      }

      const startPoint = createEndpoint(
        startTerminal,
        "start",
        fragment.startWasCut,
      )
      const endPoint = createEndpoint(endTerminal, "end", fragment.endWasCut)
      const pointsToConnect = [startPoint]
      if (
        !pointsAreEqual(startPoint, endPoint) ||
        getPointLayers(startPoint).join("\0") !==
          getPointLayers(endPoint).join("\0")
      ) {
        pointsToConnect.push(endPoint)
      }

      outputConnections.push({
        ...(originalConnection?.isOffBoard !== undefined
          ? { isOffBoard: originalConnection.isOffBoard }
          : {}),
        ...(originalConnection?.nominalTraceWidth !== undefined
          ? { nominalTraceWidth: originalConnection.nominalTraceWidth }
          : {}),
        name: localConnectionName,
        rootConnectionName: netContext.canonicalName,
        __rootConnectionNames: rootNames,
        ...(originalConnection?.netConnectionName
          ? { netConnectionName: originalConnection.netConnectionName }
          : {}),
        ...(originalConnection?.__netConnectionName
          ? { __netConnectionName: originalConnection.__netConnectionName }
          : {}),
        pointsToConnect,
      })

      const outputTrace = {
        ...clone(trace),
        pcb_trace_id: traceId,
        connection_name: localConnectionName,
        route: addBoundaryTerminalStubs(fragment, startTerminal, endTerminal),
      }
      const retainedEndpointAliases = uniqueStrings([
        ...getConnectionPointAliases(startPoint),
        ...getConnectionPointAliases(endPoint),
      ])
      if (retainedEndpointAliases.length > 0) {
        outputTrace.connectsTo = retainedEndpointAliases
      } else {
        delete outputTrace.connectsTo
      }
      outputTraces.push(outputTrace)

      for (const alias of [
        originalConnection?.name,
        originalConnection?.rootConnectionName,
        trace.connection_name,
      ]) {
        addReplacement(connectionReplacements, alias, localConnectionName)
      }

      for (const [endpoint, node, wasCut] of [
        ["start", fragment.start, fragment.startWasCut],
        ["end", fragment.end, fragment.endWasCut],
      ] as const) {
        if (!wasCut) continue
        artificialCutEndpoints.push({
          point: node,
          provenanceAliases: netContext.provenanceAliases,
        })
        const terminal = endpoint === "start" ? startTerminal : endTerminal
        if (!pointsAreEqual(terminal, node)) {
          artificialCutEndpoints.push({
            point: terminal,
            provenanceAliases: netContext.provenanceAliases,
          })
        }
        const obstacleId = allocateId(
          `${traceId}__boundary_${endpoint}`,
          usedObstacleIds,
        )
        boundaryObstacles.push(
          createBoundaryObstacle({
            node: terminal,
            obstacleId,
            localConnectionName,
            rootNames,
          }),
        )
      }
    }
  }

  const outputObstacles = intersectingInputObstacles
    .filter((obstacle) => {
      if (pointIsInsideBounds(obstacle.center, bounds)) return true
      if (!protectedBounds) return true
      if (
        obstacleIntersectsBounds(obstacle as RuntimeObstacle, protectedBounds)
      ) {
        return true
      }
      const obstacleAliases = new Set(
        uniqueStrings([
          ...obstacle.connectedTo,
          ...(obstacle.offBoardConnectsTo ?? []),
        ]),
      )
      if (obstacleAliases.size === 0) return true
      return !artificialCutEndpoints.some(
        (endpoint) =>
          pointIsInsideObstacle(endpoint.point, obstacle as RuntimeObstacle) &&
          !Array.from(endpoint.provenanceAliases).some((alias) =>
            obstacleAliases.has(alias),
          ),
      )
    })
    .map((obstacle) => ({
      ...clone(obstacle),
      connectedTo: uniqueStrings(
        obstacle.connectedTo.map(
          (alias) => canonicalNameByTraceId.get(alias) ?? alias,
        ),
      ),
    }))
  outputObstacles.push(...boundaryObstacles)

  for (const connection of srj.connections) {
    if (consumedConnections.has(connection.name)) continue
    const pointsToConnect = connection.pointsToConnect
      .filter((point) => pointIsInsideBounds(point, bounds))
      .map(clone)
    if (pointsToConnect.length === 0) continue
    outputConnections.push({ ...clone(connection), pointsToConnect })
    addReplacement(connectionReplacements, connection.name, connection.name)
  }

  const getSingleReplacement = (name: string) => {
    const replacements = connectionReplacements.get(name)
    return replacements?.length === 1 ? replacements[0] : undefined
  }
  const differentialPairs = srj.differentialPairs?.flatMap((pair) => {
    const first = getSingleReplacement(pair.connectionNames[0])
    const second = getSingleReplacement(pair.connectionNames[1])
    return first && second
      ? [
          {
            ...clone(pair),
            connectionNames: [first, second] as [string, string],
          },
        ]
      : []
  })
  const buses = srj.buses?.flatMap((bus) => {
    const names = bus.connectionNames.map(getSingleReplacement)
    return names.every((name): name is string => Boolean(name))
      ? [{ ...clone(bus), connectionNames: names }]
      : []
  })

  const clippedOutline = srj.outline
    ? clipOutline(srj.outline, bounds)
    : undefined
  const jumpers = srj.jumpers
    ?.filter((jumper) => jumperIntersectsBounds(jumper, bounds))
    .map(clone)

  const preservedMetadata = clone(srj) as unknown as Record<string, unknown>
  for (const replacedField of [
    "bounds",
    "obstacles",
    "connections",
    "traces",
    "outline",
    "jumpers",
    "differentialPairs",
    "buses",
    // SRJ18 embeds the complete source board in these fields. Carrying them
    // into every small crop defeats extraction and can add megabytes/sample.
    "sourceCircuitJson",
    "sourceKicadPcb",
  ]) {
    delete preservedMetadata[replacedField]
  }

  const result: Record<string, unknown> = {
    ...preservedMetadata,
    bounds: clone(bounds),
    obstacles: outputObstacles,
    connections: outputConnections,
  }
  if (srj.traces !== undefined) result.traces = outputTraces
  if (clippedOutline) result.outline = clippedOutline
  if (srj.jumpers !== undefined) result.jumpers = jumpers ?? []
  if (srj.differentialPairs !== undefined) {
    result.differentialPairs = differentialPairs ?? []
  }
  if (srj.buses !== undefined) result.buses = buses ?? []
  return result as unknown as SimpleRouteJson
}
