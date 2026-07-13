// Pure unit tests for the live proxy step + the resolver cross-check.
// Run with NO emulator, NO Firebase, in ms:  npm test
import { describe, it, expect } from 'vitest'
import {
  applyBid,
  type AuctionLiveState,
  type StoredMaxes,
  type IncomingBid,
} from '../src/auction/bidEngine'
import { resolveAuction, type AuctionBid } from '../src/auction/resolver'
import type { AuctionSettings } from '../src/auction/settings'
import { EBAY_AUCTION_SETTINGS, EBAY_STARTING_PRICE, ebayEndowmentFor } from '../src/ebayAuction'

const S = EBAY_AUCTION_SETTINGS       // ascending / open / second / increment 1
const START = EBAY_STARTING_PRICE     // 0
const bid = (bidderIndex: number, maxAmount: number, ts: number): IncomingBid =>
  ({ bidderIndex, maxAmount, serverTimestampMs: ts })

describe('applyBid — proxy mechanics', () => {
  it('first bid → high bidder at the opening price (startingPrice 0)', () => {
    const r = applyBid({ currentAmount: 0, highBidderIndex: null }, {}, bid(2, 1500, 1), S, START)
    expect(r).toEqual({ accepted: true, state: { currentAmount: 0, highBidderIndex: 2 }, step: { bidderIndex: 2, amount: 0, atMs: 1 } })
  })

  it('overtake → new high bidder, priced one increment above the incumbent max', () => {
    const state: AuctionLiveState = { currentAmount: 0, highBidderIndex: 1 }
    const maxes: StoredMaxes = { 1: 2000 }
    const r = applyBid(state, maxes, bid(3, 3300, 2), S, START)
    expect(r).toMatchObject({ accepted: true, state: { currentAmount: 2001, highBidderIndex: 3 } })
  })

  it('incumbent auto-raise → incumbent STAYS high, price rises just enough (capped at their max)', () => {
    // Incumbent 1 has max 2600; challenger 2 bids 2500 (below) → 1 stays, price = min(2600, 2501) = 2501.
    const r = applyBid({ currentAmount: 0, highBidderIndex: 1 }, { 1: 2600 }, bid(2, 2500, 2), S, START)
    expect(r).toMatchObject({ accepted: true, state: { currentAmount: 2501, highBidderIndex: 1 } })
  })

  it('tie → INCUMBENT keeps it (earliest timestamp), price = their own max', () => {
    // Incumbent 1 max 2500; challenger 2 ties at 2500 → 1 stays, price = min(2500, 2501) = 2500.
    const r = applyBid({ currentAmount: 2001, highBidderIndex: 1 }, { 1: 2500 }, bid(2, 2500, 5), S, START)
    expect(r).toMatchObject({ accepted: true, state: { currentAmount: 2500, highBidderIndex: 1 } })
  })

  it('incumbent raising own max → no visible change, no history step', () => {
    const r = applyBid({ currentAmount: 2001, highBidderIndex: 1 }, { 1: 2600 }, bid(1, 3000, 9), S, START)
    expect(r).toEqual({ accepted: true, state: { currentAmount: 2001, highBidderIndex: 1 }, step: null })
  })
})

describe('applyBid — every rejection reason', () => {
  it('below-standing: max does not beat the current amount', () => {
    expect(applyBid({ currentAmount: 2500, highBidderIndex: 1 }, { 1: 2600 }, bid(2, 2400, 3), S, START))
      .toEqual({ accepted: false, reason: 'below-standing' })
  })
  it('not-higher-than-own-max: cannot lower or repeat your own max', () => {
    expect(applyBid({ currentAmount: 100, highBidderIndex: 2 }, { 1: 2000, 2: 100 }, bid(1, 2000, 4), S, START))
      .toEqual({ accepted: false, reason: 'not-higher-than-own-max' })
  })
  it('not-positive: zero, negative, NaN, Infinity all rejected', () => {
    for (const bad of [0, -50, NaN, Infinity]) {
      expect(applyBid({ currentAmount: 0, highBidderIndex: null }, {}, bid(1, bad, 1), S, START))
        .toEqual({ accepted: false, reason: 'not-positive' })
    }
  })
})

describe('applyBid — not-implemented parameters throw', () => {
  it('descending throws', () => {
    const d: AuctionSettings = { ...S, direction: 'descending' }
    expect(() => applyBid({ currentAmount: 0, highBidderIndex: null }, {}, bid(1, 100, 1), d, START)).toThrow('not implemented')
  })
  it('first-price throws (live proxy is second-price)', () => {
    const f: AuctionSettings = { ...S, pricing: 'first' }
    expect(() => applyBid({ currentAmount: 0, highBidderIndex: null }, {}, bid(1, 100, 1), f, START)).toThrow('not implemented')
  })
})

// ── THE CROSS-CHECK: live proxy convergence === resolver clearing price ──────────
// Replay a set of maxes through applyBid in server-receipt order and assert the
// final standing amount + high bidder equal what resolveAuction computes.

type Case = { name: string; maxes: Record<number, number>; expectWinner: number | null; expectClearing: number | null }
const CASES: Case[] = [
  { name: 'case1', maxes: { 1: 2600, 2: 2500, 3: 2400, 4: 2300 }, expectWinner: 1, expectClearing: 2501 },
  { name: 'case2', maxes: { 1: 2000, 2: 2100, 3: 3300, 4: 2200 }, expectWinner: 3, expectClearing: 2201 },
  { name: 'case3', maxes: { 1: 2000, 2: 2100, 3: 2900, 4: 3300 }, expectWinner: 4, expectClearing: 2901 },
  { name: 'case4-tie', maxes: { 1: 2500, 2: 2500, 3: 2000, 4: 2000 }, expectWinner: 1, expectClearing: 2500 },
  { name: 'case5-single', maxes: { 2: 1500 }, expectWinner: 2, expectClearing: 0 },
  { name: 'case6-none', maxes: {}, expectWinner: null, expectClearing: null },
]

/** Replay maxes in (amount asc, bidderIndex asc) order — server-receipt order. */
function replay(maxes: Record<number, number>): { state: AuctionLiveState; ts: Record<number, number> } {
  const feed = Object.entries(maxes)
    .map(([idx, max]) => ({ bidderIndex: Number(idx), maxAmount: max }))
    .sort((a, b) => a.maxAmount - b.maxAmount || a.bidderIndex - b.bidderIndex)
  let state: AuctionLiveState = { currentAmount: START, highBidderIndex: null }
  const stored: Record<number, number> = {}
  const ts: Record<number, number> = {}
  feed.forEach((f, i) => {
    ts[f.bidderIndex] = i + 1
    const r = applyBid(state, stored, { bidderIndex: f.bidderIndex, maxAmount: f.maxAmount, serverTimestampMs: i + 1 }, S, START)
    if (r.accepted) { state = r.state; stored[f.bidderIndex] = f.maxAmount }
  })
  return { state, ts }
}

describe('CROSS-CHECK — live proxy final price === resolveAuction clearing price', () => {
  for (const c of CASES) {
    it(`${c.name}: live convergence matches the resolver`, () => {
      const { state, ts } = replay(c.maxes)

      // Build the resolver's inputs from the SAME maxes + the SAME server timestamps.
      const bids: AuctionBid[] = Object.entries(c.maxes).map(([idx, max]) => ({
        bidderIndex: Number(idx), maxAmount: max, serverTimestampMs: ts[Number(idx)],
      }))
      const endow = [1, 2, 3, 4, 5].map(ebayEndowmentFor)
      const res = resolveAuction(bids, endow, 2650, S, START)

      // Resolver and live agree on the winner…
      expect(state.highBidderIndex).toBe(c.expectWinner)
      expect(res.winnerBidderIndex).toBe(c.expectWinner)

      // …and on the clearing price (live standing amount === resolver clearingPrice),
      // except the zero-bid case where the resolver reports null (no sale) and the live
      // state simply never left the opening price.
      if (c.expectWinner === null) {
        expect(res.clearingPrice).toBeNull()
        expect(state.currentAmount).toBe(START)
      } else {
        expect(state.currentAmount).toBe(c.expectClearing)
        expect(res.clearingPrice).toBe(c.expectClearing)
        expect(state.currentAmount).toBe(res.clearingPrice)
      }
    })
  }
})
