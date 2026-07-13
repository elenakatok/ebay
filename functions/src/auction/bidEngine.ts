// ═══════════════════════════════════════════════════════════════════════════════
// AUCTION ENGINE — pure proxy-bid step (extraction candidate; NO Firebase, NO I/O).
//
// Same discipline as resolver.ts: inputs in, result out, generic vocabulary only,
// zero Firebase imports. The live auction callable CALLS this per accepted bid; it
// does not embed any storage or clock. Ascending, open, second-price proxy.
//
// CONSISTENCY WITH THE RESOLVER (verified in bidEngine.test.ts): replaying a set of
// maxes through applyBid in server-receipt order converges to the SAME clearing
// price and winner that resolveAuction() computes for those maxes. Ties resolve to
// the INCUMBENT (whoever bid first = earliest serverTimestampMs), matching the
// resolver's earliest-timestamp tie-break.
// ═══════════════════════════════════════════════════════════════════════════════

import type { AuctionSettings } from './settings'

export interface AuctionLiveState {
  currentAmount: number            // the standing high bid (public)
  highBidderIndex: number | null   // 1..N, or null when nobody has bid yet
}

/** The CONFIDENTIAL current/highest max per bidder (server-side only — never public). */
export interface StoredMaxes {
  readonly [bidderIndex: number]: number | undefined
}

export interface IncomingBid {
  bidderIndex: number
  maxAmount: number          // the bidder's confidential proxy maximum
  serverTimestampMs: number  // server-receipt time (tie-break / history stamp)
}

/** A visible bid step — the ONLY thing appended to public history. Never a max. */
export interface HistoryStep {
  bidderIndex: number
  amount: number
  atMs: number
}

export type ApplyBidResult =
  | { accepted: false; reason: 'not-positive' | 'below-standing' | 'not-higher-than-own-max' }
  | { accepted: true; state: AuctionLiveState; step: HistoryStep | null }

/**
 * Apply one incoming proxy bid to the live state (ascending, second-price).
 *
 * @param state        current { currentAmount, highBidderIndex }
 * @param maxes        confidential stored maxes; must include the incumbent's and
 *                     the bidder's OWN previous max (for the raise-only rule)
 * @param bid          the incoming bid
 * @param settings     pinned auction params (increment, direction, pricing)
 * @param startingPrice the single-bidder / opening clearing floor (eBay: 0)
 *
 * Rejection reasons (pure rules 4–6; status/deadline/membership are the caller's):
 *   not-positive              amount is not a positive finite number
 *   not-higher-than-own-max   amount does not exceed the bidder's own previous max
 *   below-standing            amount does not beat the standing high bid
 */
export function applyBid(
  state: AuctionLiveState,
  maxes: StoredMaxes,
  bid: IncomingBid,
  settings: AuctionSettings,
  startingPrice: number,
): ApplyBidResult {
  if (settings.direction !== 'ascending') throw new Error('not implemented')
  if (settings.pricing !== 'second') throw new Error('not implemented')

  if (!Number.isFinite(bid.maxAmount) || bid.maxAmount <= 0) {
    return { accepted: false, reason: 'not-positive' }
  }
  const ownPrev = maxes[bid.bidderIndex]
  if (ownPrev !== undefined && bid.maxAmount <= ownPrev) {
    return { accepted: false, reason: 'not-higher-than-own-max' }
  }
  if (bid.maxAmount <= state.currentAmount) {
    return { accepted: false, reason: 'below-standing' }
  }

  const inc = settings.increment
  const high = state.highBidderIndex

  // First (accepted) bid → become high bidder at the opening price.
  if (high === null) {
    return {
      accepted: true,
      state: { currentAmount: startingPrice, highBidderIndex: bid.bidderIndex },
      step: { bidderIndex: bid.bidderIndex, amount: startingPrice, atMs: bid.serverTimestampMs },
    }
  }

  // Incumbent raising their OWN max → no competitor moved, no visible change.
  if (high === bid.bidderIndex) {
    return { accepted: true, state, step: null }
  }

  const theirMax = maxes[high] ?? 0
  if (bid.maxAmount > theirMax) {
    // Overtake: I win, priced one increment above the incumbent's max (capped at my max).
    const amount = Math.min(bid.maxAmount, theirMax + inc)
    return {
      accepted: true,
      state: { currentAmount: amount, highBidderIndex: bid.bidderIndex },
      step: { bidderIndex: bid.bidderIndex, amount, atMs: bid.serverTimestampMs },
    }
  }
  // bid.maxAmount <= theirMax (incl. tie) → incumbent stays; their proxy auto-raises
  // just enough to stay ahead (capped at their own max). Tie → incumbent keeps it.
  const amount = Math.min(theirMax, bid.maxAmount + inc)
  return {
    accepted: true,
    state: { currentAmount: amount, highBidderIndex: high },
    step: { bidderIndex: high, amount, atMs: bid.serverTimestampMs },
  }
}
