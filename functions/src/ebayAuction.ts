// ═══════════════════════════════════════════════════════════════════════════════
// eBay AUCTION — the game-specific layer (eBay vocabulary + pinned config).
//
// The auction ENGINE (functions/src/auction/*) is domain-generic. THIS file holds
// everything eBay: the frozen endowment table, the common value, the pinned
// AuctionSettings, and the human-facing "Bidder N (Expert)" labels. When the
// engine is extracted, this file stays behind in eBay unchanged.
//
// Data of record: eBay_Part2_Data_Inputs.md  (V_common = 2650, bidder table).
// ═══════════════════════════════════════════════════════════════════════════════

import type { AuctionSettings } from './auction/settings'
import type { AuctionEndowment } from './auction/resolver'
import type { GroupSizePolicy } from './auction/grouping'

/** The true common resale value. SERVER-ONLY TRUTH — must never reach a client. */
export const EBAY_V_COMMON = 2650

/** eBay clears from a starting price of 0. */
export const EBAY_STARTING_PRICE = 0

// signalHalfWidth: the true common value lies within [signal ± signalHalfWidth] — a
// bounded, UNIFORM interval (the case says "within ±1000 of your signal"), NOT a
// Gaussian sd. Metadata for a future random-draw engine; eBay's signals are FIXED,
// so it is recorded but never consumed. Non-experts: ±1000. Expert (bidder 1): 0 —
// their signal IS the truth, which is exactly what makes them the expert.
const NONEXPERT_SIGNAL_HALF_WIDTH = 1000

/**
 * Frozen per-bidder endowment table (eBay_Part2_Data_Inputs.md), keyed by
 * bidderIndex. Bidder 1 is ALWAYS the expert (exact signal, use = 0). Bidders
 * 2..7 are non-experts. `signal` is the bidder's BELIEF and is never used in
 * resolution — realized value is V_common + privateValue.
 *
 * Rows 6–7 (groups can now reach 7, spec §2b/§2c) keep the same spirit: non-expert,
 * signal within ±1000 of 2650, private use 100–300. Bidder 4's signal (3200) stays
 * the MOST over-optimistic — it is the deliberate winner's-curse trap.
 */
export const EBAY_ENDOWMENTS: Record<number, Omit<AuctionEndowment, 'bidderIndex'>> = {
  1: { signal: 2650, privateValue: 0,   signalHalfWidth: 0 },                        // Expert
  2: { signal: 1900, privateValue: 100, signalHalfWidth: NONEXPERT_SIGNAL_HALF_WIDTH },
  3: { signal: 2850, privateValue: 300, signalHalfWidth: NONEXPERT_SIGNAL_HALF_WIDTH },
  4: { signal: 3200, privateValue: 100, signalHalfWidth: NONEXPERT_SIGNAL_HALF_WIDTH }, // winner's-curse trap (most over-optimistic)
  5: { signal: 2650, privateValue: 100, signalHalfWidth: NONEXPERT_SIGNAL_HALF_WIDTH },
  6: { signal: 2300, privateValue: 200, signalHalfWidth: NONEXPERT_SIGNAL_HALF_WIDTH }, // realized 2850
  7: { signal: 3000, privateValue: 100, signalHalfWidth: NONEXPERT_SIGNAL_HALF_WIDTH }, // realized 2750
}

/** Highest bidder slot the frozen table defines (groups can reach 7 — spec §2b). */
export const EBAY_MAX_BIDDER_INDEX = 7

/** Build a full AuctionEndowment for a given bidder slot. */
export function ebayEndowmentFor(bidderIndex: number): AuctionEndowment {
  const row = EBAY_ENDOWMENTS[bidderIndex]
  if (!row) throw new Error(`No eBay endowment for bidderIndex ${bidderIndex}`)
  return { bidderIndex, ...row }
}

/** eBay's group-sizing policy: base 4, oversize ceiling 7 (spec §2b). */
export const EBAY_GROUP_POLICY: GroupSizePolicy = { ideal: 4, max: EBAY_MAX_BIDDER_INDEX }

/**
 * PURE endowment assignment for a matched group (used by the onCreate trigger).
 * Given the members in match order, assigns bidderIndex 1..N and the matching
 * endowment row. The first member (bidderIndex 1) IS the expert. Overflow slots
 * beyond the frozen table (> EBAY_MAX_BIDDER_INDEX) are dropped (caller logs it).
 */
export function assignBidderEndowments(
  orderedPids: string[],
): Array<{ participantId: string; bidderIndex: number; endowment: AuctionEndowment }> {
  const out: Array<{ participantId: string; bidderIndex: number; endowment: AuctionEndowment }> = []
  orderedPids.forEach((pid, i) => {
    const bidderIndex = i + 1
    if (bidderIndex > EBAY_MAX_BIDDER_INDEX) return
    out.push({ participantId: pid, bidderIndex, endowment: ebayEndowmentFor(bidderIndex) })
  })
  return out
}

/**
 * eBay's pinned auction parameters. `durationSeconds` and `increment` are the two
 * instructor-editable knobs (real configFields); the rest are compiled defaults.
 */
export const EBAY_AUCTION_SETTINGS: AuctionSettings = {
  durationSeconds: 600,
  increment: 1,
  direction: 'ascending',
  format: 'open',
  closeType: 'hard',
  pricing: 'second',
  proxyBidding: true,
  revealAtClose: 'full',
}

/** In-auction display label for a bidder slot (eBay vocabulary — copy, not logic). */
export function ebayBidderLabel(bidderIndex: number): string {
  return bidderIndex === 1 ? 'Bidder 1 (Expert)' : `Bidder ${bidderIndex}`
}
