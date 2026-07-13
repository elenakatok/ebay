// Conformance tests for the PURE auction resolver.
// Run with NO emulator, NO Firebase, in milliseconds:  npm test  (vitest run)
import { describe, it, expect } from 'vitest'
import { resolveAuction, type AuctionBid, type AuctionEndowment } from '../src/auction/resolver'
import type { AuctionSettings } from '../src/auction/settings'
import {
  EBAY_AUCTION_SETTINGS,
  EBAY_V_COMMON,
  EBAY_STARTING_PRICE,
  ebayEndowmentFor,
} from '../src/ebayAuction'

// Conformance vector context: vCommon = 2650, increment = 1, pricing = 'second',
// startingPrice = 0, endowments per the Slice 0 table.
const V = EBAY_V_COMMON              // 2650
const START = EBAY_STARTING_PRICE    // 0
const SETTINGS = EBAY_AUCTION_SETTINGS // ascending / open / second / increment 1

// Full 4-bidder endowment set used by every conformance case.
const ENDOW_4: AuctionEndowment[] = [1, 2, 3, 4].map(ebayEndowmentFor)

/** Build one bid; serverTimestampMs defaults ascending by bidder so ties are total-ordered. */
function bid(bidderIndex: number, maxAmount: number, ts = bidderIndex): AuctionBid {
  return { bidderIndex, maxAmount, serverTimestampMs: ts }
}

const profitOf = (r: ReturnType<typeof resolveAuction>, idx: number) =>
  r.perBidder.find(p => p.bidderIndex === idx)!.profit

describe('resolveAuction — conformance vector (second-price, increment 1)', () => {
  it('case 1: B1 wins @ 2501, profit +149', () => {
    const r = resolveAuction(
      [bid(1, 2600), bid(2, 2500), bid(3, 2400), bid(4, 2300)],
      ENDOW_4, V, SETTINGS, START,
    )
    expect(r.winnerBidderIndex).toBe(1)
    expect(r.clearingPrice).toBe(2501)
    expect(profitOf(r, 1)).toBe(149)
  })

  it('case 2: B3 wins @ 2201, profit +749', () => {
    const r = resolveAuction(
      [bid(1, 2000), bid(2, 2100), bid(3, 3300), bid(4, 2200)],
      ENDOW_4, V, SETTINGS, START,
    )
    expect(r.winnerBidderIndex).toBe(3)
    expect(r.clearingPrice).toBe(2201)
    expect(profitOf(r, 3)).toBe(749)
  })

  it('case 3: B4 wins @ 2901 — WINNER\'S CURSE, profit MUST be -151 (never clamped)', () => {
    const r = resolveAuction(
      [bid(1, 2000), bid(2, 2100), bid(3, 2900), bid(4, 3300)],
      ENDOW_4, V, SETTINGS, START,
    )
    expect(r.winnerBidderIndex).toBe(4)
    expect(r.clearingPrice).toBe(2901)
    expect(profitOf(r, 4)).toBe(-151)
    expect(profitOf(r, 4)).toBeLessThan(0)
  })

  it('case 4a: tie 2500/2500, B1 earlier ts → B1 wins @ own max 2500 (capped)', () => {
    const r = resolveAuction(
      [bid(1, 2500, /*ts*/ 10), bid(2, 2500, /*ts*/ 20), bid(3, 2000), bid(4, 2000)],
      ENDOW_4, V, SETTINGS, START,
    )
    expect(r.winnerBidderIndex).toBe(1)
    expect(r.clearingPrice).toBe(2500)          // own max, never exceeded
  })

  it('case 4b: tie flips — B2 earlier ts → B2 wins @ own max 2500', () => {
    const r = resolveAuction(
      [bid(1, 2500, /*ts*/ 20), bid(2, 2500, /*ts*/ 10), bid(3, 2000), bid(4, 2000)],
      ENDOW_4, V, SETTINGS, START,
    )
    expect(r.winnerBidderIndex).toBe(2)
    expect(r.clearingPrice).toBe(2500)
  })

  it('case 5: single bidder B2 @ 1500 → clears at startingPrice 0, profit +2750', () => {
    const r = resolveAuction(
      [bid(2, 1500)],
      ENDOW_4, V, SETTINGS, START,
    )
    expect(r.winnerBidderIndex).toBe(2)
    expect(r.clearingPrice).toBe(0)
    expect(profitOf(r, 2)).toBe(2750)
  })

  it('case 6: no bids → no sale, all profits 0', () => {
    const r = resolveAuction([], ENDOW_4, V, SETTINGS, START)
    expect(r.winnerBidderIndex).toBeNull()
    expect(r.clearingPrice).toBeNull()
    expect(r.perBidder.every(p => p.profit === 0)).toBe(true)
    // realizedValue is still defined for every bidder even with no sale.
    expect(r.perBidder.find(p => p.bidderIndex === 3)!.realizedValue).toBe(V + 300)
  })
})

describe('resolveAuction — parameter branches', () => {
  it('pricing "first": case-1 inputs → winner pays own max 2600', () => {
    const first: AuctionSettings = { ...SETTINGS, pricing: 'first' }
    const r = resolveAuction(
      [bid(1, 2600), bid(2, 2500), bid(3, 2400), bid(4, 2300)],
      ENDOW_4, V, first, START,
    )
    expect(r.winnerBidderIndex).toBe(1)
    expect(r.clearingPrice).toBe(2600)
  })

  it('format "sealed": case-2 inputs → identical result to open (format-neutral)', () => {
    const sealed: AuctionSettings = { ...SETTINGS, format: 'sealed' }
    const r = resolveAuction(
      [bid(1, 2000), bid(2, 2100), bid(3, 3300), bid(4, 2200)],
      ENDOW_4, V, sealed, START,
    )
    expect(r.winnerBidderIndex).toBe(3)
    expect(r.clearingPrice).toBe(2201)
    expect(profitOf(r, 3)).toBe(749)
  })

  it('direction "descending": throws not implemented', () => {
    const desc: AuctionSettings = { ...SETTINGS, direction: 'descending' }
    expect(() => resolveAuction([bid(1, 2600)], ENDOW_4, V, desc, START))
      .toThrow('not implemented')
  })
})
