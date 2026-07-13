// Unit tests for the single-role group-sizing rule (spec §2b) — NO emulator, ms.
//   - planGroupSizes at every class size 1..30 (R1/R3/R4)
//   - explicit 6 / 7 / 11 / 9-flex fallbacks
//   - matcher-equivalence: the SHARED matchParticipants, configured as eBay wires it
//     ({bidder:4}, perRoleCap 7), produces exactly planGroupSizes for every n ≥ 4
//   - endowment assignment: every group has exactly one bidderIndex 1 = the expert
import { describe, it, expect } from 'vitest'
import { matchParticipants, mulberry32, type RoleConfig } from '@mygames/game-engine'
import { planGroupSizes } from '../src/auction/grouping'
import {
  EBAY_GROUP_POLICY,
  EBAY_V_COMMON,
  assignBidderEndowments,
} from '../src/ebayAuction'

const IDEAL = EBAY_GROUP_POLICY.ideal // 4
const MAX = EBAY_GROUP_POLICY.max     // 7

describe('planGroupSizes — R1/R3/R4 across every class size 1..30', () => {
  for (let n = 1; n <= 30; n++) {
    it(`n=${n}: no orphans, no group <${IDEAL} (unless n<${IDEAL}), no group >${MAX}`, () => {
      const sizes = planGroupSizes(n, EBAY_GROUP_POLICY)
      // R1 — everyone placed.
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(n)
      for (const s of sizes) {
        expect(s).toBeLessThanOrEqual(MAX)               // never oversized past the ceiling
        if (n >= IDEAL) expect(s).toBeGreaterThanOrEqual(IDEAL) // never undersized (turnout ≥ ideal)
      }
      if (n < IDEAL) expect(sizes).toEqual([n])          // degenerate but valid
    })
  }
})

describe('planGroupSizes — explicit un-tileable fallbacks', () => {
  const sorted = (n: number) => [...planGroupSizes(n, EBAY_GROUP_POLICY)].sort((a, b) => a - b)
  it('6 → one group of 6', () => expect(planGroupSizes(6, EBAY_GROUP_POLICY)).toEqual([6]))
  it('7 → one group of 7', () => expect(planGroupSizes(7, EBAY_GROUP_POLICY)).toEqual([7]))
  it('11 → 6 + 5', () => expect(sorted(11)).toEqual([5, 6]))
  it('9 → 4 + 5 (the flex case)', () => expect(sorted(9)).toEqual([4, 5]))
  it('12 → 4 + 4 + 4', () => expect(planGroupSizes(12, EBAY_GROUP_POLICY)).toEqual([4, 4, 4]))
  it('1/2/3 → one degenerate group', () => {
    expect(planGroupSizes(1, EBAY_GROUP_POLICY)).toEqual([1])
    expect(planGroupSizes(2, EBAY_GROUP_POLICY)).toEqual([2])
    expect(planGroupSizes(3, EBAY_GROUP_POLICY)).toEqual([3])
  })
})

// The shared matcher, configured exactly as eBay's gameDefinition wires it.
const BIDDER_ROLE: RoleConfig = { roles: [{ key: 'bidder', label: 'Bidder', short: 'B' }] }
function matchSizes(n: number, seed: number): number[] {
  const eligible = Array.from({ length: n }, (_, i) => ({ participant_id: `p${i}`, role: 'bidder' }))
  const groups = matchParticipants(eligible, {
    roleConfig: BIDDER_ROLE,
    composition: { bidder: IDEAL },
    perRoleCap: MAX,
    rng: mulberry32(seed),
  })
  return groups.map(g => (g['bidder_participants'] as string[]).length)
}

describe('matcher-equivalence — {bidder:4}, perRoleCap 7 realizes planGroupSizes for n ≥ 4', () => {
  for (let n = 4; n <= 30; n++) {
    it(`n=${n}: matcher sizes === planGroupSizes, all placed`, () => {
      const got = matchSizes(n, 12345 + n).sort((a, b) => a - b)
      const want = [...planGroupSizes(n, EBAY_GROUP_POLICY)].sort((a, b) => a - b)
      expect(got).toEqual(want)
      expect(got.reduce((a, b) => a + b, 0)).toBe(n) // no orphans
    })
  }
})

describe('endowment assignment — exactly one expert (bidderIndex 1) per group', () => {
  it('the bidderIndex-1 row is the expert: signalHalfWidth 0, signal === vCommon', () => {
    const [first] = assignBidderEndowments(['a', 'b', 'c', 'd'])
    expect(first.bidderIndex).toBe(1)
    expect(first.endowment.signalHalfWidth).toBe(0)
    expect(first.endowment.signal).toBe(EBAY_V_COMMON)
  })

  it('every group size 4..7 yields exactly one bidderIndex 1, distinct indexes', () => {
    for (let size = 4; size <= MAX; size++) {
      const pids = Array.from({ length: size }, (_, i) => `p${i}`)
      const assigned = assignBidderEndowments(pids)
      expect(assigned).toHaveLength(size)
      const idxs = assigned.map(a => a.bidderIndex)
      expect(idxs.filter(i => i === 1)).toHaveLength(1)               // exactly one expert
      expect(new Set(idxs).size).toBe(size)                          // distinct
      expect(idxs).toEqual(Array.from({ length: size }, (_, i) => i + 1))
    }
  })

  it('non-experts (bidderIndex ≥ 2) all have signalHalfWidth 1000; bidder 4 stays most over-optimistic', () => {
    const assigned = assignBidderEndowments(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    for (const a of assigned.filter(x => x.bidderIndex >= 2)) {
      expect(a.endowment.signalHalfWidth).toBe(1000)
    }
    const signals = assigned.map(a => a.endowment.signal)
    expect(Math.max(...signals)).toBe(assigned.find(a => a.bidderIndex === 4)!.endowment.signal)
  })
})
