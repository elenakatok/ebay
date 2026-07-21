// eBay latecomer placement hooks (Latecomer_Placement_Spec_v1 §3.1 / step 2).
// Wired onto ebayGameDef; consumed by the shared placeLatecomer via the code-entry
// path (makeVerifyAttendanceCode). Does NOT modify the assignEndowments onCreate
// trigger — it reproduces the SAME frozen-table assignment for a latecomer's slot,
// which the trigger cannot do because no group is created when a latecomer joins.

import * as admin from 'firebase-admin'
import { fieldFor } from '@mygames/game-engine'
import type { JoinableContext, PlaceContext, PlacementParticipant } from '@mygames/game-server'
import { EBAY_MAX_BIDDER_INDEX, ebayEndowmentFor } from './ebayAuction'

// eBay is single-role. Kept local (not imported from gameDefinition) to avoid an
// import cycle, and it is the same key ebayConfig declares.
const BIDDER_ROLE = 'bidder'

/**
 * Joinable = the auction has FEWER THAN 5 participants AND its clock has not
 * started (spec §3.1 — BOTH conditions). A 4-bidder auction whose clock is
 * already running is NOT joinable. The clock lives in RTDB (auctions/{iid}/{gid}),
 * not the group doc, so this predicate is async; placeLatecomer evaluates it in
 * the transaction's read phase.
 */
export async function ebayIsJoinable(
  group: admin.firestore.DocumentData,
  ctx: JoinableContext,
): Promise<boolean> {
  if (ctx.participantCount >= 5) return false
  const gid = group['group_id'] as string
  const node = (await admin.database().ref(`auctions/${ctx.gameInstanceId}/${gid}`).get())
    .val() as { status?: string } | null
  // startAuction sets status 'open'; close sets 'closed'. No node ⇒ not started.
  const clockStarted = node?.status === 'open' || node?.status === 'closed'
  return !clockStarted
}

/**
 * Assign the latecomer their bidder endowment EXACTLY as assignEndowments would.
 * Their slot is the next after the current members (bidderIndex = current count +
 * 1), so a latecomer is always a NON-expert — bidder 1 (the expert) is already
 * assigned. eBay's endowments are a deterministic frozen table keyed by slot, so
 * no read is needed: the pre-placement group snapshot supplies the count. The
 * group's truth/auction doc (vCommon) already exists from group creation and is
 * left untouched.
 */
export async function ebayOnPlace(
  group: admin.firestore.DocumentData,
  _participant: PlacementParticipant,
  ctx: PlaceContext,
): Promise<void> {
  const members = (group[fieldFor(BIDDER_ROLE, 'participants')] as string[] | undefined) ?? []
  const bidderIndex = members.length + 1
  if (bidderIndex > EBAY_MAX_BIDDER_INDEX) {
    // Unreachable while isJoinable caps joins at <5 (so bidderIndex ≤ 5). Guard,
    // never throw, so a latecomer is never left half-placed.
    console.error(`[ebayOnPlace] bidderIndex ${bidderIndex} exceeds the endowment table; skipping`)
    return
  }
  ctx.tx.update(ctx.participantRef, { auction_endowment: ebayEndowmentFor(bidderIndex) })
}
