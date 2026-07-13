// ═══════════════════════════════════════════════════════════════════════════════
// eBay Part 3 — endowment assignment AT MATCH TIME (single-role redesign).
//
// The match/group-creation path is the SHARED makeTriggerMatching (game-server),
// which eBay must not modify. The eBay-local hook into "match time" is therefore a
// Firestore onCreate trigger on the group doc: when triggerMatching writes a group,
// this fires and stamps each participant's endowment + records the group's truth.
//
// SINGLE ROLE: everyone is a `bidder`. Expertise is an information endowment, not an
// identity — whoever draws bidderIndex 1 IS the expert (their endowment has
// signalHalfWidth 0, signal === vCommon). Group membership is already randomized by
// the shared matcher's shuffle, so the first bidder in the array (→ bidderIndex 1)
// is an effectively random expert. Exactly one expert per group, GUARANTEED BY
// CONSTRUCTION. Bidders fill slots 1..N in match order.
//
// ── vCommon MUST NEVER REACH A CLIENT ──────────────────────────────────────────
// The group doc is client-readable (firestore.rules), so vCommon CANNOT live on it.
// It is written to a server-only subcollection  groups/{groupId}/truth/{doc}  whose
// reads/writes are denied to every client by RULES (see firestore.rules). Only the
// backend (admin SDK, which bypasses rules) ever reads it.
// ═══════════════════════════════════════════════════════════════════════════════

import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { fieldFor } from '@mygames/game-engine'
import { ebayConfig } from './gameDefinition'
import {
  EBAY_V_COMMON,
  EBAY_MAX_BIDDER_INDEX,
  assignBidderEndowments,
} from './ebayAuction'

// Every role key (single-role game → just `bidder`), in declared order.
const ROLE_KEYS = ebayConfig.roles.map(r => r.key)

/** Server-only doc holding the group's truth (deny-all in firestore.rules). */
const TRUTH_DOC = 'auction'

export const assignEndowments = onDocumentCreated(
  'game_instances/{instanceId}/groups/{groupId}',
  async (event) => {
    const snap = event.data
    if (!snap) return
    const group = snap.data()
    const { instanceId, groupId } = event.params

    // Collect group members in match order (their order in the role array). The
    // first member draws bidderIndex 1 → the expert.
    const orderedPids: string[] = []
    for (const roleKey of ROLE_KEYS) {
      const pids = (group[fieldFor(roleKey, 'participants')] as string[] | undefined) ?? []
      orderedPids.push(...pids)
    }
    if (orderedPids.length === 0) {
      console.warn(`[assignEndowments] group ${groupId} has no participants; nothing to do`)
      return
    }
    if (orderedPids.length > EBAY_MAX_BIDDER_INDEX) {
      // Groups are 4–7 (spec §2b). Larger is a matching bug — log loudly, assign
      // the slots we can rather than throwing and leaving the group half-stamped.
      console.error(
        `[assignEndowments] group ${groupId} has ${orderedPids.length} participants; ` +
        `endowment table only defines ${EBAY_MAX_BIDDER_INDEX} bidder slots`,
      )
    }

    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(instanceId)
    const batch = db.batch()

    // Pure assignment (bidderIndex 1..N; first member = expert). Overflow dropped.
    for (const { participantId, endowment } of assignBidderEndowments(orderedPids)) {
      batch.update(instanceRef.collection('participants').doc(participantId), {
        auction_endowment: endowment,
      })
    }

    // Truth: vCommon in a server-only subcollection the client cannot read.
    batch.set(
      instanceRef.collection('groups').doc(groupId).collection('truth').doc(TRUTH_DOC),
      {
        group_id: groupId,
        game_instance_id: instanceId,
        vCommon: EBAY_V_COMMON,
        assigned_at: FieldValue.serverTimestamp(),
      },
    )

    await batch.commit()
  },
)
