// ═══════════════════════════════════════════════════════════════════════════════
// AUCTION ENGINE — group-sizing rule (domain-generic; NO Firebase, NO I/O).
//
// The DEFINED tiling rule for a single-role auction (spec §2b), and the reference
// against which the shared matcher's config is verified. This is pure: given a
// turnout, it returns the intended group sizes. It encodes the SAME algorithm the
// shared matcher realizes for {role: ideal}, perRoleCap = max — so eBay's
// composition {bidder:4} + perRoleCap 7 produces exactly these sizes for any
// turnout ≥ ideal (proven by grouping.test.ts's matcher-equivalence test).
//
// Rules:
//   R1  every attendee is placed (no orphans)
//   R3  groups are `ideal` or `ideal+1` where possible
//   R4  an un-tileable remainder is absorbed by ONE oversized group (up to `max`);
//       never an undersized group (< ideal) unless turnout itself is < ideal.
// ═══════════════════════════════════════════════════════════════════════════════

export interface GroupSizePolicy {
  ideal: number   // eBay: 4 — the base group size
  max: number     // eBay: 7 — the oversize ceiling that absorbs a remainder
}

/**
 * Returns the group sizes for `n` attendees under `policy`, summing to `n`.
 *
 * n < ideal  → one degenerate group of size n (valid; the resolver handles a
 *              single bidder). n <= 0 → no groups.
 * n >= ideal → floor(n/ideal) base groups of `ideal`, then the remainder r = n mod
 *              ideal is distributed round-robin (+1 per group), mirroring the shared
 *              matcher's distributeExtras. r ≤ ideal−1, so with `max` = ideal+3 no
 *              group exceeds `max` and none is left below `ideal`.
 *
 * Examples (ideal 4, max 7): 4→[4], 5→[5], 6→[6], 7→[7], 9→[5,4], 11→[6,5], 12→[4,4,4].
 */
export function planGroupSizes(n: number, policy: GroupSizePolicy): number[] {
  const { ideal } = policy
  if (n <= 0) return []
  if (n < ideal) return [n]

  const groupCount = Math.floor(n / ideal)
  const remainder = n - groupCount * ideal
  const sizes = new Array<number>(groupCount).fill(ideal)
  for (let i = 0; i < remainder; i++) {
    sizes[i % groupCount] += 1   // round-robin, exactly as distributeExtras spreads
  }
  return sizes
}
