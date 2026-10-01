import { describe, expect, it } from 'vitest'
import {
  LAND,
  WORLD,
  geoBounds,
  graticule,
  landAt,
  landPath,
  pointInRing,
  project,
  ringPath,
  unproject,
  worldPath,
} from '@/canvas/projection'
import type { Ring } from '@/canvas/projection'

describe('projection box', () => {
  it('keeps a square graticule — a degree of lat is a degree of lon', () => {
    const perDegreeLon = WORLD.width / (WORLD.lonMax - WORLD.lonMin)
    const perDegreeLat = WORLD.height / (WORLD.latMax - WORLD.latMin)
    expect(perDegreeLon).toBeCloseTo(perDegreeLat, 9)
  })

  it('excludes Antarctica from the viewport on purpose', () => {
    expect(WORLD.latMin).toBeGreaterThan(-60)
    expect(LAND.some((region) => region.id === 'antarctica')).toBe(false)
  })
})

describe('project', () => {
  it('puts the prime meridian at the horizontal centre', () => {
    expect(project(0, 0).x).toBeCloseTo(WORLD.width / 2, 6)
  })

  it('puts the antimeridian at the two edges', () => {
    expect(project(0, -180).x).toBeCloseTo(0, 6)
    expect(project(0, 180).x).toBeCloseTo(WORLD.width, 6)
  })

  it('grows y downward as latitude falls', () => {
    expect(project(60, 0).y).toBeLessThan(project(0, 0).y)
    expect(project(0, 0).y).toBeLessThan(project(-40, 0).y)
  })

  it('is linear in both axes', () => {
    const a = project(10, 20)
    const b = project(20, 40)
    const c = project(30, 60)
    expect(b.x - a.x).toBeCloseTo(c.x - b.x, 9)
    expect(b.y - a.y).toBeCloseTo(c.y - b.y, 9)
  })
})

describe('unproject', () => {
  it('round-trips every plant-plausible coordinate', () => {
    const samples = [
      { lat: 52.4, lon: 16.9 },
      { lat: 25.7, lon: -100.3 },
      { lat: 31.3, lon: 120.6 },
      { lat: -23.5, lon: -46.6 },
      { lat: 41.6, lon: -87.6 },
      { lat: 0, lon: 0 },
    ]
    for (const sample of samples) {
      const point = project(sample.lat, sample.lon)
      const back = unproject(point.x, point.y)
      expect(back.lat).toBeCloseTo(sample.lat, 9)
      expect(back.lon).toBeCloseTo(sample.lon, 9)
    }
  })

  it('clamps latitude to the box rather than inventing a pole', () => {
    expect(unproject(0, -1000).lat).toBe(WORLD.latMax)
    expect(unproject(0, 1e6).lat).toBe(WORLD.latMin)
  })
})

describe('ringPath', () => {
  const square: Ring = [
    [-10, 10],
    [10, 10],
    [10, -10],
    [-10, -10],
  ]

  it('emits a closed straight-segment path at zero smoothing', () => {
    const d = ringPath(square, { smooth: 0 })
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    expect(d).not.toContain('C')
    expect(d.split('L')).toHaveLength(4)
  })

  it('emits one cubic per vertex when smoothed', () => {
    const d = ringPath(square, { smooth: 0.4 })
    expect(d.split('C')).toHaveLength(square.length + 1)
    expect(d.endsWith('Z')).toBe(true)
  })

  it('refuses degenerate rings instead of emitting a broken path', () => {
    expect(ringPath([[0, 0]] as Ring)).toBe('')
    expect(
      ringPath([
        [0, 0],
        [1, 1],
      ] as Ring),
    ).toBe('')
  })

  it('never emits NaN or a negative zero', () => {
    const d = worldPath()
    expect(d).not.toContain('NaN')
    expect(d).not.toContain('-0,')
    expect(d.length).toBeGreaterThan(1000)
  })

  it('is deterministic', () => {
    expect(worldPath()).toBe(worldPath())
  })
})

describe('land data', () => {
  it('has every vertex inside real lat/lon bounds', () => {
    for (const region of LAND) {
      for (const ring of region.rings) {
        expect(ring.length).toBeGreaterThanOrEqual(4)
        for (const [lon, lat] of ring) {
          expect(lon).toBeGreaterThanOrEqual(-180)
          expect(lon).toBeLessThanOrEqual(180)
          expect(lat).toBeGreaterThanOrEqual(-90)
          expect(lat).toBeLessThanOrEqual(90)
        }
      }
    }
  })

  it('gives every region a unique id and a drawable path', () => {
    const ids = new Set(LAND.map((region) => region.id))
    expect(ids.size).toBe(LAND.length)
    for (const region of LAND) expect(landPath(region).length).toBeGreaterThan(20)
  })

  it('draws the big masses first so small islands sit on top', () => {
    expect(LAND[0]?.id).toBe('eurasia')
    const islandIndex = LAND.findIndex((region) => region.id === 'british-isles')
    const eurasiaIndex = LAND.findIndex((region) => region.id === 'eurasia')
    expect(islandIndex).toBeGreaterThan(eurasiaIndex)
  })
})

describe('pointInRing / landAt', () => {
  const square: Ring = [
    [-10, 10],
    [10, 10],
    [10, -10],
    [-10, -10],
  ]

  it('answers inside and outside', () => {
    expect(pointInRing(0, 0, square)).toBe(true)
    expect(pointInRing(20, 0, square)).toBe(false)
    expect(pointInRing(0, 40, square)).toBe(false)
  })

  it('finds land under a continental point and ocean under a mid-Pacific one', () => {
    const kansas = project(38, -98)
    expect(landAt(kansas.x, kansas.y)?.id).toBe('north-america')
    const pacific = project(-20, -140)
    expect(landAt(pacific.x, pacific.y)).toBeNull()
  })

  it('finds Eurasia under central Asia and Africa under the Sahara', () => {
    const kazakhstan = project(48, 68)
    expect(landAt(kazakhstan.x, kazakhstan.y)?.id).toBe('eurasia')
    const sahara = project(22, 10)
    expect(landAt(sahara.x, sahara.y)?.id).toBe('africa')
  })
})

describe('graticule', () => {
  it('spans the box and flags the equator and prime meridian', () => {
    const lines = graticule(30, 30)
    const parallels = lines.filter((line) => line.kind === 'parallel')
    const meridians = lines.filter((line) => line.kind === 'meridian')
    expect(parallels.length).toBeGreaterThan(3)
    expect(meridians.length).toBe(13)
    for (const line of parallels) {
      expect(line.x1).toBeCloseTo(0, 6)
      expect(line.x2).toBeCloseTo(WORLD.width, 6)
      expect(line.y1).toBeCloseTo(line.y2, 9)
    }
    expect(lines.filter((line) => line.major).map((line) => line.degrees).sort()).toEqual([0, 0])
  })
})

describe('geoBounds', () => {
  it('boxes a set of plants with a margin', () => {
    const box = geoBounds(
      [
        { lat: 50, lon: -10 },
        { lat: 40, lon: 10 },
      ],
      20,
    )
    const a = project(50, -10)
    const b = project(40, 10)
    expect(box.x).toBeCloseTo(a.x - 20, 6)
    expect(box.y).toBeCloseTo(a.y - 20, 6)
    expect(box.width).toBeCloseTo(b.x - a.x + 40, 6)
    expect(box.height).toBeCloseTo(b.y - a.y + 40, 6)
  })

  it('falls back to the whole world when given nothing', () => {
    expect(geoBounds([])).toEqual({ x: 0, y: 0, width: WORLD.width, height: WORLD.height })
  })
})
