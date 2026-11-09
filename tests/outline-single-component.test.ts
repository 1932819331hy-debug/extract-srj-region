import { expect, test } from "bun:test"
import { extractSrjRegion, type SimpleRouteJson } from "../lib"

type Point = { x: number; y: number }
const outline: Point[] = [
  { x: 0, y: 0 },
  { x: 6, y: 0 },
  { x: 6, y: 6 },
  { x: 4, y: 6 },
  { x: 4, y: 2 },
  { x: 2, y: 2 },
  { x: 2, y: 6 },
  { x: 0, y: 6 },
]
const input = (ring: Point[]): SimpleRouteJson => ({
  layerCount: 2,
  minTraceWidth: 0.2,
  bounds: { minX: -20, maxX: 20, minY: -20, maxY: 20 },
  obstacles: [],
  connections: [],
  outline: ring,
})
const transforms = [
  (p: Point) => ({ x: p.x, y: p.y }),
  (p: Point) => ({ x: -p.y, y: p.x }),
  (p: Point) => ({ x: -p.x, y: -p.y }),
  (p: Point) => ({ x: p.y + 11, y: -p.x - 7 }),
]
const keys = (ring: Point[]) => ring.map((p) => `${p.x},${p.y}`).sort()

for (const [orientation, transform] of transforms.entries()) {
  for (const reverse of [false, true]) {
    for (const closeInput of [false, true]) {
      test(`retains a single U arm after clipping: orientation ${orientation}, reverse ${reverse}, closed ${closeInput}`, () => {
        const ring = outline.map(transform)
        if (reverse) ring.reverse()
        const first = ring[0]
        if (closeInput && first) ring.push({ ...first })
        // The crop extends into the empty notch, but meets only the left arm.
        // Its filled intersection is exactly [0, 2] x [2.5, 3.5], area 2.
        const corners = [
          { x: -0.5, y: 2.5 },
          { x: 2.5, y: 3.5 },
        ].map(transform)
        const crop = {
          minX: Math.min(...corners.map((p) => p.x)),
          maxX: Math.max(...corners.map((p) => p.x)),
          minY: Math.min(...corners.map((p) => p.y)),
          maxY: Math.max(...corners.map((p) => p.y)),
        }
        const expected = [
          { x: 0, y: 2.5 },
          { x: 2, y: 2.5 },
          { x: 2, y: 3.5 },
          { x: 0, y: 3.5 },
        ].map(transform)
        const srj = input(ring)
        const before = structuredClone({ srj, crop })
        const result = extractSrjRegion(srj, crop)
        expect(result.outline).toBeDefined()
        expect(result.outline).toHaveLength(5)
        expect(result.outline?.[0]).toEqual(result.outline?.at(-1))
        expect(keys(result.outline?.slice(0, -1) ?? [])).toEqual(keys(expected))
        expect({ srj, crop }).toEqual(before)
        expect(extractSrjRegion(srj, crop)).toEqual(result)
      })
    }
  }
}

test("still omits a U crop with two surviving arms", () => {
  const result = extractSrjRegion(input(outline), {
    minX: 0.5,
    maxX: 5.5,
    minY: 2.5,
    maxY: 3.5,
  })
  expect(result.outline).toBeUndefined()
})

test("retains the concavity when the U bridge survives", () => {
  const result = extractSrjRegion(input(outline), {
    minX: -0.5,
    maxX: 6.5,
    minY: -0.5,
    maxY: 6.5,
  })
  expect(result.outline).toEqual([...outline, outline[0]])
})
