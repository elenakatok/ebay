// ═══════════════════════════════════════════════════════════════════════════════
// eBay Part 3 — Slice 3: the LIVE auction server (RTDB state + bid callable).
//
// startAuction / closeAuction — instructor.   submitBid — student (the hot path).
//
// STORAGE (extraction-disciplined, `auctions/` namespace, NO max ever public):
//   RTDB  auctions/{iid}/{gid}         public state — status, currentAmount,
//                                      highBidderIndex, startedAtMs, endsAtMs,
//                                      increment, seq, history/{pushId}. NO max.
//   RTDB  auctionMembers/{iid}/{uid}   server-only { = groupId } — powers the
//                                      per-group RTDB read rule. Denied to clients.
//   FS    groups/{gid}/bids/{index}    CONFIDENTIAL max per bidder (rules-denied).
//
// CONCURRENCY: the RTDB auction node carries a `seq` counter. Each accepted bid is
// applied inside an RTDB transaction that ABORTS unless seq is unchanged since it
// read the incumbent's (confidential) max from Firestore — then the outer loop
// re-reads and recomputes. The bidder's max is written to Firestore BEFORE the
// seq-bumping transaction, so any reader that sees a bidder as high-bidder at a
// given seq is guaranteed to see that bidder's max. No lost updates; no max in RTDB.
//
// DEADLINE: the server clock (Date.now() here IS server time) is the ONLY truth. No
// client-supplied time is ever read. A bid past endsAtMs is rejected AND closes the
// auction (implicit close). This is the sniping lesson — airtight.
// ═══════════════════════════════════════════════════════════════════════════════

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId, extractStudentOnCallIds } from '@mygames/game-server'
import { ebayGameDef } from './gameDefinition'
import { applyBid, type StoredMaxes } from './auction/bidEngine'
import { resolveAuction, type AuctionBid, type AuctionEndowment } from './auction/resolver'
import { EBAY_AUCTION_SETTINGS, EBAY_STARTING_PRICE, EBAY_V_COMMON } from './ebayAuction'

const def = ebayGameDef
const START = EBAY_STARTING_PRICE
const MAX_BID_RETRIES = 8

const auctionRef = (iid: string, gid: string) => admin.database().ref(`auctions/${iid}/${gid}`)
const bidsCol = (iid: string, gid: string) =>
  admin.firestore().collection('game_instances').doc(iid).collection('groups').doc(gid).collection('bids')

/** Member participant ids of a group, from the single-role participant array. */
function groupMemberIds(group: FirebaseFirestore.DocumentData): string[] {
  return (group['bidder_participants'] as string[] | undefined) ?? []
}

// ── startAuction (instructor) ───────────────────────────────────────────────────
export const startAuction = onCall({ cors: def.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined
  const iid = await extractInstructorGameId(data, isEmulator, authHeader)
  const gid = data['group_id']
  if (typeof gid !== 'string' || !gid) throw new HttpsError('invalid-argument', 'group_id required')

  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(iid)
  const groupSnap = await instanceRef.collection('groups').doc(gid).get()
  if (!groupSnap.exists) throw new HttpsError('not-found', 'Group not found')
  const members = groupMemberIds(groupSnap.data()!)
  if (members.length === 0) throw new HttpsError('failed-precondition', 'Group has no members')

  // GUARD: every member must be endowed. Endowments are assigned by an async onCreate
  // trigger, so the group can exist for a moment before they land — do NOT start a
  // partially-endowed auction. Retryable.
  const memberSnaps = await Promise.all(members.map(pid => instanceRef.collection('participants').doc(pid).get()))
  const allEndowed = memberSnaps.every(s => s.exists && s.data()!['auction_endowment'] != null)
  if (!allEndowed) {
    throw new HttpsError('failed-precondition', 'Endowments not yet assigned to all members — retry in a moment.')
  }

  // Idempotency: an already-open auction is a no-op (never a reset); closed is terminal.
  const ref = auctionRef(iid, gid)
  const existing = (await ref.get()).val() as { status?: string } | null
  if (existing?.status === 'open') return { ok: true as const, alreadyStarted: true }
  if (existing?.status === 'closed') throw new HttpsError('failed-precondition', 'Auction already closed')

  // Duration + increment come from INSTRUCTOR CONFIG at start time (not launch),
  // falling back to the compiled defaults.
  const configData = (await instanceRef.collection('config').doc('main').get()).data() ?? {}
  const durationSeconds = Number(configData['duration_seconds'] ?? EBAY_AUCTION_SETTINGS.durationSeconds)
  const increment = Number(configData['bid_increment'] ?? EBAY_AUCTION_SETTINGS.increment)

  const startedAtMs = Date.now()                    // SERVER clock only
  const endsAtMs = startedAtMs + durationSeconds * 1000

  await ref.set({
    status: 'open',
    currentAmount: START,
    highBidderIndex: null,
    startedAtMs,
    endsAtMs,
    increment,
    seq: 0,
    // history omitted until the first bid
  })

  // Membership index for the per-group RTDB read rule (server-only).
  const memberWrites: Record<string, string> = {}
  for (const pid of members) memberWrites[`auctionMembers/${iid}/${pid}`] = gid
  await admin.database().ref().update(memberWrites)

  return { ok: true as const, endsAtMs, startedAtMs, durationSeconds, increment }
})

// ── closeAuction (instructor; also called implicitly on a late bid) ──────────────
async function closeAuctionNode(iid: string, gid: string): Promise<void> {
  await auctionRef(iid, gid).transaction(cur => {
    if (cur && cur.status === 'open') cur.status = 'closed'
    return cur
  })
}

export const closeAuction = onCall({ cors: def.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined
  const iid = await extractInstructorGameId(data, isEmulator, authHeader)
  const gid = data['group_id']
  if (typeof gid !== 'string' || !gid) throw new HttpsError('invalid-argument', 'group_id required')
  await closeAuctionNode(iid, gid)
  return { ok: true as const }
})

// ── resolve + close (Slice 5) ─────────────────────────────────────────────────────
//
// CLOSE TRIGGER: the CLOCK closes the auction — there is no instructor close button.
// Because there is no scheduled function, resolution is driven by whoever NEXT observes
// the passed deadline (a client whose countdown hit zero, OR a student who loads the
// page later) via the `checkAuctionClose` callable. An auction whose deadline passed
// with nobody watching still resolves the instant someone next looks.
//
// IDEMPOTENCY: the RTDB status flip (closeAuctionNode) freezes bids; then a Firestore
// transaction guarded by group.auction_resolved_at ELECTS exactly one resolver — the
// loser of the race sees the marker present and no-ops. Inputs are frozen at close, so
// every racer computes the identical resolution; only one writes. No double-write, one
// winner, one clearing price.
//
// REVEAL WITHOUT RELAXING RULES: the confidential maxes (bids/) and vCommon
// (truth/auction) stay DENIED to clients forever. At resolve time they are COPIED into
// `auction_result`, which is written onto EACH member's own participant doc — readable
// only by that member (the existing own-doc read rule), so no other group can read this
// group's vCommon. Nothing is un-denied.

interface StoredResultBidder {
  bidderIndex: number
  signal: number
  privateValue: number
  signalHalfWidth: number
  maxAmount: number | null   // revealable at close; null = never bid
  realizedValue: number
  profit: number
}

/** Resolve a group's auction (idempotently) and reveal the result to its members. */
async function resolveAndCloseAuction(iid: string, gid: string): Promise<void> {
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(iid)
  const groupRef = instanceRef.collection('groups').doc(gid)

  // Freeze bids first (idempotent). submitBid rejects once status !== 'open', so the
  // maxes read below cannot change under us.
  await closeAuctionNode(iid, gid)

  const groupSnap = await groupRef.get()
  if (!groupSnap.exists) return
  const members = groupMemberIds(groupSnap.data()!)
  if (members.length === 0) return

  // Endowments (the canonical bidder set) from participants.
  const memberSnaps = await Promise.all(members.map(pid => instanceRef.collection('participants').doc(pid).get()))
  const endowments: AuctionEndowment[] = []
  for (const s of memberSnaps) {
    const e = s.data()?.['auction_endowment'] as Partial<AuctionEndowment> | undefined
    if (e && typeof e.bidderIndex === 'number') {
      endowments.push({
        bidderIndex: e.bidderIndex,
        signal: Number(e.signal ?? 0),
        privateValue: Number(e.privateValue ?? 0),
        signalHalfWidth: Number(e.signalHalfWidth ?? 0),
      })
    }
  }

  // Confidential maxes (one per bidder = their FINAL/highest) from the rules-denied subcollection.
  const bidsSnap = await bidsCol(iid, gid).get()
  const maxByIndex = new Map<number, number>()
  const bids: AuctionBid[] = []
  for (const b of bidsSnap.docs) {
    const d = b.data()
    if (typeof d['bidderIndex'] === 'number' && typeof d['maxAmount'] === 'number') {
      maxByIndex.set(d['bidderIndex'], d['maxAmount'])
      bids.push({ bidderIndex: d['bidderIndex'], maxAmount: d['maxAmount'], serverTimestampMs: Number(d['serverTimestampMs'] ?? 0) })
    }
  }

  // vCommon from the rules-denied truth doc.
  const truthSnap = await groupRef.collection('truth').doc('auction').get()
  const vCommon = Number(truthSnap.data()?.['vCommon'] ?? EBAY_V_COMMON)

  const node = (await auctionRef(iid, gid).get()).val() as AuctionNode | null
  const settings = { ...EBAY_AUCTION_SETTINGS, increment: node?.increment ?? EBAY_AUCTION_SETTINGS.increment }

  // The PURE resolver — unmodified. One entry per bidder = their final max.
  const resolution = resolveAuction(bids, endowments, vCommon, settings, START)
  const byIndex = new Map(resolution.perBidder.map(p => [p.bidderIndex, p]))

  const perBidder: StoredResultBidder[] = endowments
    .slice()
    .sort((a, b) => a.bidderIndex - b.bidderIndex)
    .map(e => {
      const r = byIndex.get(e.bidderIndex)
      return {
        bidderIndex: e.bidderIndex,
        signal: e.signal,
        privateValue: e.privateValue,
        signalHalfWidth: e.signalHalfWidth,
        maxAmount: maxByIndex.get(e.bidderIndex) ?? null,
        realizedValue: r?.realizedValue ?? vCommon + e.privateValue,
        profit: r?.profit ?? 0,
      }
    })

  const resolvedAtMs = Date.now()
  const auctionResult = {
    winnerBidderIndex: resolution.winnerBidderIndex,
    clearingPrice: resolution.clearingPrice,
    vCommon,                                   // revealable now — the auction is over
    perBidder,
    resolvedAtMs,
  }

  // Idempotent commit: elect one resolver, then reveal to each member's OWN doc.
  await db.runTransaction(async (tx) => {
    const g = await tx.get(groupRef)
    if (g.data()?.['auction_resolved_at'] != null) return   // already resolved — no-op
    tx.set(groupRef, {
      auction_resolved_at: resolvedAtMs,
      status: 'completed',
      agreement_reached: resolution.winnerBidderIndex !== null,
      // Placeholder outcome for the UNCHANGED scoring stub (echoes price); Slice 6
      // replaces this with the real participation/KC grade. vCommon is NOT stored here
      // (the group doc is broadly readable) — only the public clearing price.
      outcome: resolution.winnerBidderIndex !== null
        ? { price: resolution.clearingPrice ?? 0 }
        : { no_deal: true },
    }, { merge: true })
    for (const pid of members) {
      tx.set(instanceRef.collection('participants').doc(pid), { auction_result: auctionResult }, { merge: true })
    }
  })
}

// ── checkAuctionClose (student group member) — the deadline-observed close trigger ──
export const checkAuctionClose = onCall({ cors: def.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined
  const { participantId, gameInstanceId: iid } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const gid = data['group_id']
  if (typeof gid !== 'string' || !gid) throw new HttpsError('invalid-argument', 'group_id required')

  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(iid)
  const pSnap = await instanceRef.collection('participants').doc(participantId).get()
  if (!pSnap.exists || pSnap.data()!['group_id'] !== gid) {
    throw new HttpsError('permission-denied', 'Not a member of this group')
  }

  const groupRef = instanceRef.collection('groups').doc(gid)
  if ((await groupRef.get()).data()?.['auction_resolved_at'] != null) {
    return { ok: true as const, resolved: true, alreadyResolved: true }
  }

  const node = (await auctionRef(iid, gid).get()).val() as AuctionNode | null
  if (!node) return { ok: true as const, resolved: false, reason: 'no-auction' as const }
  // Only the CLOCK closes: resolve iff the server deadline has passed (or already closed).
  if (node.status === 'open' && Date.now() <= node.endsAtMs) {
    return { ok: true as const, resolved: false, reason: 'still-open' as const }
  }

  await resolveAndCloseAuction(iid, gid)
  return { ok: true as const, resolved: true }
})

// ── submitBid (student; the hot path) ────────────────────────────────────────────
export const submitBid = onCall({ cors: def.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined
  const { participantId, gameInstanceId: iid } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const gid = data['group_id']
  if (typeof gid !== 'string' || !gid) throw new HttpsError('invalid-argument', 'group_id required')
  const maxAmount = Number(data['max_amount'])
  if (!Number.isFinite(maxAmount) || maxAmount <= 0) {
    throw new HttpsError('invalid-argument', 'max_amount must be a positive number')
  }
  // NOTE: any client-supplied time (e.g. data.client_now_ms) is IGNORED by design —
  // the server clock is the sole deadline authority (the sniping lesson).

  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(iid)
  const pSnap = await instanceRef.collection('participants').doc(participantId).get()
  if (!pSnap.exists) throw new HttpsError('not-found', 'Participant not found')
  const p = pSnap.data()!
  if (p['group_id'] !== gid) throw new HttpsError('permission-denied', 'Not a member of this group')
  const endowment = p['auction_endowment'] as { bidderIndex?: number } | undefined
  const bidderIndex = endowment?.bidderIndex
  if (typeof bidderIndex !== 'number') throw new HttpsError('failed-precondition', 'No endowment assigned yet')

  const ref = auctionRef(iid, gid)
  const node0 = (await ref.get()).val() as AuctionNode | null
  if (!node0 || node0.status !== 'open') throw new HttpsError('failed-precondition', 'Auction is not open')
  if (Date.now() > node0.endsAtMs) {
    await closeAuctionNode(iid, gid)
    throw new HttpsError('failed-precondition', 'Auction has ended')
  }

  const settings = { ...EBAY_AUCTION_SETTINGS, increment: node0.increment }
  const myBidRef = bidsCol(iid, gid).doc(String(bidderIndex))
  const myPrevMax = (await myBidRef.get()).data()?.['maxAmount'] as number | undefined

  // Pre-validate (rules 4–6) on the initial snapshot so an invalid bid never writes.
  const pre = applyBid(
    { currentAmount: node0.currentAmount, highBidderIndex: node0.highBidderIndex },
    await readMaxes(iid, gid, node0.highBidderIndex, bidderIndex, myPrevMax),
    { bidderIndex, maxAmount, serverTimestampMs: Date.now() },
    settings, START,
  )
  if (!pre.accepted) throw rejectionError(pre.reason)

  // Record the max in Firestore BEFORE the seq-bumping transaction (the invariant).
  const serverTimestampMs = Date.now()
  await myBidRef.set({ bidderIndex, maxAmount, serverTimestampMs, at: FieldValue.serverTimestamp() })

  // Keep the node SYNCED for the duration of the call. Without an active listener the
  // admin SDK invokes the transaction handler with a null-first cache miss, which would
  // otherwise abort spuriously. Awaiting the first value event guarantees the handler
  // sees the real node. Detached in `finally`.
  let firstSync: () => void = () => {}
  const synced = new Promise<void>(res => { firstSync = res })
  const syncCb = ref.on('value', () => firstSync())
  await synced

  try {
    // Optimistic loop: recompute against a fresh incumbent max, commit iff seq unchanged.
    for (let attempt = 0; attempt < MAX_BID_RETRIES; attempt++) {
      const node = (await ref.get()).val() as AuctionNode | null
      if (!node || node.status !== 'open') throw new HttpsError('failed-precondition', 'Auction is not open')
      if (Date.now() > node.endsAtMs) { await closeAuctionNode(iid, gid); throw new HttpsError('failed-precondition', 'Auction has ended') }

      const readSeq = node.seq ?? 0
      const maxes = await readMaxes(iid, gid, node.highBidderIndex ?? null, bidderIndex, myPrevMax)
      const res = applyBid(
        { currentAmount: node.currentAmount, highBidderIndex: node.highBidderIndex ?? null },
        maxes,
        { bidderIndex, maxAmount, serverTimestampMs },
        settings, START,
      )
      if (!res.accepted) throw rejectionError(res.reason)   // e.g. outbid on a retry

      const preKey = ref.child('history').push().key as string
      const tx = await ref.transaction((cur: AuctionNode | null) => {
        if (cur === null) return undefined                                  // node truly absent → abort
        if (cur.status !== 'open') return undefined                         // abort
        if (Date.now() > cur.endsAtMs) return undefined                     // abort (late)
        if ((cur.seq ?? 0) !== readSeq) return undefined                    // concurrent change → retry
        cur.currentAmount = res.state.currentAmount
        cur.highBidderIndex = res.state.highBidderIndex
        cur.seq = readSeq + 1
        if (res.step) { if (!cur.history) cur.history = {}; cur.history[preKey] = res.step }
        return cur
      })

      if (tx.committed) {
        return { ok: true as const, currentAmount: res.state.currentAmount, highBidderIndex: res.state.highBidderIndex }
      }
      // Aborted — decide from a FRESH read (never the transaction's own snapshot, which
      // can be null on a cache-miss abort). A closed/ended auction is terminal; anything
      // else was a concurrent change → recompute and retry.
      const fresh = (await ref.get()).val() as AuctionNode | null
      if (!fresh || fresh.status !== 'open') throw new HttpsError('failed-precondition', 'Auction is not open')
      if (Date.now() > fresh.endsAtMs) { await closeAuctionNode(iid, gid); throw new HttpsError('failed-precondition', 'Auction has ended') }
      // else seq changed under us — loop and recompute.
    }
    throw new HttpsError('aborted', 'Too much contention — please retry')
  } finally {
    ref.off('value', syncCb)
  }
})

// ── helpers ──────────────────────────────────────────────────────────────────────
interface AuctionNode {
  status: 'pending' | 'open' | 'closed'
  currentAmount: number
  highBidderIndex: number | null
  startedAtMs: number
  endsAtMs: number
  increment: number
  seq: number
  history?: Record<string, unknown>
}

/**
 * Build the confidential maxes applyBid needs: the bidder's OWN previous max (rule 5
 * baseline — always the pre-bid value) and the current incumbent's max (fresh from
 * Firestore). Never includes the incoming bid's own new max, so self-raise stays valid.
 */
async function readMaxes(
  iid: string, gid: string, incumbentIndex: number | null, bidderIndex: number, myPrevMax: number | undefined,
): Promise<StoredMaxes> {
  const maxes: Record<number, number> = {}
  if (myPrevMax !== undefined) maxes[bidderIndex] = myPrevMax
  if (incumbentIndex != null && incumbentIndex !== bidderIndex) {
    const m = (await bidsCol(iid, gid).doc(String(incumbentIndex)).get()).data()?.['maxAmount'] as number | undefined
    if (m !== undefined) maxes[incumbentIndex] = m
  }
  return maxes
}

function rejectionError(reason: 'not-positive' | 'below-standing' | 'not-higher-than-own-max'): HttpsError {
  const msg = reason === 'below-standing'
    ? 'Your maximum does not beat the current high bid'
    : reason === 'not-higher-than-own-max'
      ? 'Your maximum must be higher than your previous maximum'
      : 'Bid must be a positive amount'
  return new HttpsError('failed-precondition', msg)
}
