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

/** The true common resale value. SERVER-ONLY TRUTH — must never reach a client. */
export const EBAY_V_COMMON = 2650

/** eBay clears from a starting price of 0. */
export const EBAY_STARTING_PRICE = 0

// sigma is metadata for a future random-draw engine; eBay's signals are FIXED, so
// it is recorded but never consumed. A single positive placeholder for non-experts
// (the ±1000 signal band); the expert's signal is exact, so sigma 0.
const NONEXPERT_SIGMA = 500

/**
 * Frozen per-bidder endowment table (eBay_Part2_Data_Inputs.md), keyed by
 * bidderIndex. Bidder 1 is ALWAYS the expert (exact signal, use = 0). Bidders
 * 2..5 are non-experts. `signal` is the bidder's BELIEF and is never used in
 * resolution — realized value is V_common + privateValue.
 */
export const EBAY_ENDOWMENTS: Record<number, Omit<AuctionEndowment, 'bidderIndex'>> = {
  1: { signal: 2650, privateValue: 0,   sigma: 0 },              // Expert
  2: { signal: 1900, privateValue: 100, sigma: NONEXPERT_SIGMA },
  3: { signal: 2850, privateValue: 300, sigma: NONEXPERT_SIGMA },
  4: { signal: 3200, privateValue: 100, sigma: NONEXPERT_SIGMA }, // winner's-curse trap
  5: { signal: 2650, privateValue: 100, sigma: NONEXPERT_SIGMA },
}

/** Highest bidder slot the frozen table defines (groups are 4 or 5). */
export const EBAY_MAX_BIDDER_INDEX = 5

/** Build a full AuctionEndowment for a given bidder slot. */
export function ebayEndowmentFor(bidderIndex: number): AuctionEndowment {
  const row = EBAY_ENDOWMENTS[bidderIndex]
  if (!row) throw new Error(`No eBay endowment for bidderIndex ${bidderIndex}`)
  return { bidderIndex, ...row }
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
