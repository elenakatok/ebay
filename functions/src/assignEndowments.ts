// ═══════════════════════════════════════════════════════════════════════════════
// eBay Part 3 — Slice 0: per-participant endowment assignment AT MATCH TIME.
//
// The match/group-creation path is the SHARED makeTriggerMatching (game-server),
// which eBay must not modify. The eBay-local hook into "match time" is therefore a
// Firestore onCreate trigger on the group doc: when triggerMatching writes a group,
// this fires and stamps each participant's endowment + records the group's truth.
//
// bidderIndex assignment: the single expert ALWAYS gets bidderIndex 1; non-experts
// fill slots 2..N in match order (their order in the group's role array).
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
  ebayEndowmentFor,
} from './ebayAuction'

// Role keys in a fixed order: expert first (→ bidderIndex 1), then non-experts.
const EXPERT_ROLE = 'expert'
const ORDERED_ROLES = [
  EXPERT_ROLE,
  ...ebayConfig.roles.map(r => r.key).filter(k => k !== EXPERT_ROLE),
]

/** Server-only doc holding the group's truth (deny-all in firestore.rules). */
const TRUTH_DOC = 'auction'

export const assignEndowments = onDocumentCreated(
  'game_instances/{instanceId}/groups/{groupId}',
  async (event) => {
    const snap = event.data
    if (!snap) return
    const group = snap.data()
    const { instanceId, groupId } = event.params

    // Build the bidder ordering: expert(s) first, then non-experts in match order.
    const orderedPids: string[] = []
    for (const roleKey of ORDERED_ROLES) {
      const pids = (group[fieldFor(roleKey, 'participants')] as string[] | undefined) ?? []
      orderedPids.push(...pids)
    }
    if (orderedPids.length === 0) {
      console.warn(`[assignEndowments] group ${groupId} has no participants; nothing to do`)
      return
    }
    if (orderedPids.length > EBAY_MAX_BIDDER_INDEX) {
      // Groups are 4 or 5 (spec §10). Larger is a matching bug — log loudly, assign
      // the slots we can rather than throwing and leaving the group half-stamped.
      console.error(
        `[assignEndowments] group ${groupId} has ${orderedPids.length} participants; ` +
        `endowment table only defines ${EBAY_MAX_BIDDER_INDEX} bidder slots`,
      )
    }

    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(instanceId)
    const batch = db.batch()

    orderedPids.forEach((pid, i) => {
      const bidderIndex = i + 1
      if (bidderIndex > EBAY_MAX_BIDDER_INDEX) return // skip un-endowable overflow slots
      batch.update(instanceRef.collection('participants').doc(pid), {
        auction_endowment: ebayEndowmentFor(bidderIndex),
      })
    })

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
