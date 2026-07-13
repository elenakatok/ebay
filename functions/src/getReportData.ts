import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import { ebayGameDef } from './gameDefinition'

// Exported so updateGroupContract stays importable (it references these), and so the
// row shape never drifts. Derived from the role config (single role `bidder`).
export const VALID_ROLES = new Set(ebayGameDef.roles.roles.map(r => r.key))

// Text questions from prepDefaults — read once at module load (for the free-text tiles).
export const TEXT_QUESTIONS = (ebayGameDef.prepDefaults ?? [])
  .filter(q => q.format === 'text' && !q.hidden)
  .map(q => ({ field: q.field, prompt: q.prompt, role_target: q.role_target }))

export const TEXT_FIELDS = TEXT_QUESTIONS.map(q => q.field)

// ── Report row shapes ───────────────────────────────────────────────────────────

/** Report 3 — one row per student (Profit is a GAME outcome, never a grade). */
export type ReportRow = {
  participant_id: string
  display_name: string
  group_number: number | null
  group_id: string | null
  role: string
  bidder_label: string | null
  /** Realized auction profit for this student (may be negative). null = never bid / no data. */
  profit: number | null
  /** Flat participation point (1 = present) — the grade component. null = no-show. */
  participation: number | null
  knowledge_check_score: number | null
  /** GAME outcome (never a grade): 'Won' | 'Lost' | 'No bid' | null (unresolved). */
  outcome_label: MemberOutcome | null
  text_answers: Record<string, string>
}

/** Per-student auction outcome (a GAME result, never a grade). '—' = unresolved/no data. */
export type MemberOutcome = 'Won' | 'Lost' | 'No bid' | '—'

export type GroupMemberOutcome = {
  participant_id: string
  name: string
  bidder_label: string
  outcome: MemberOutcome
}

/** Report 1 — one row per group. */
export type AuctionStatus = 'not-started' | 'open' | 'closed' | 'resolved'

export type GroupReport = {
  group_number: number | null
  group_id: string
  auction_status: AuctionStatus
  no_sale: boolean
  highest_bid: number | null       // winner's max (highest max submitted)
  auction_price: number | null     // clearing price
  winner_profit: number | null     // realized value − clearing (may be negative)
  high_bidder_name: string | null
  high_bidder_label: string | null
  time_highest_sec: number | null  // elapsed seconds from auction start
  second_bidder_name: string | null
  second_bidder_label: string | null
  time_second_sec: number | null
  expert_name: string | null
  /** Per-member game outcome — powers the instructor dashboard's per-student Won/Lost/No bid. */
  members: GroupMemberOutcome[]
}

/** Report 2 — price-over-time series for one group (X = elapsed seconds). */
export type GroupSeries = {
  group_number: number | null
  group_id: string
  duration_seconds: number
  /** {t: elapsed seconds from start, price}. Starts at {t:0, price:startingPrice}. */
  points: Array<{ t: number; price: number }>
}

const STARTING_PRICE = 0

function bidderLabel(bidderIndex: number): string {
  return bidderIndex === 1 ? 'Bidder 1 (Expert)' : `Bidder ${bidderIndex}`
}

// ── The callable ────────────────────────────────────────────────────────────────

export const getReportData = onCall({ cors: ebayGameDef.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  try {
    const db = admin.firestore()
    const rtdb = admin.database()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    const [participantsSnap, groupsSnap, attendingSnap] = await Promise.all([
      instanceRef.collection('participants').get(),
      instanceRef.collection('groups').get(),
      rtdb.ref(`game_instances/${gameInstanceId}/attendance`).get(),
    ])

    const attending = (attendingSnap.val() ?? {}) as Record<string, { display_name?: string } | null>

    const sortedGroups = groupsSnap.docs.slice().sort((a, b) => a.id.localeCompare(b.id))
    const groupNumberMap = new Map<string, number>(sortedGroups.map((g, i) => [g.id, i + 1]))

    // Per-participant helpers.
    type PData = Record<string, unknown>
    const pById = new Map<string, PData>()
    for (const p of participantsSnap.docs) pById.set(p.id, p.data() as PData)

    const nameOf = (pid: string): string => {
      const d = pById.get(pid) ?? {}
      const rtdbName = attending[pid]?.display_name?.trim()
      const fsName = ((d['display_name'] ?? d['name'] ?? '') as string).trim()
      return rtdbName || fsName || `${pid.slice(0, 8)}…`
    }
    const bidderIndexOf = (pid: string): number | null => {
      const e = (pById.get(pid) ?? {})['auction_endowment'] as { bidderIndex?: number } | undefined
      return typeof e?.bidderIndex === 'number' ? e.bidderIndex : null
    }

    // ── Read the auction node + confidential maxes for every group (admin bypass) ──
    type StoredResult = {
      winnerBidderIndex: number | null
      clearingPrice: number | null
      vCommon: number
      perBidder: Array<{ bidderIndex: number; maxAmount: number | null; profit: number; realizedValue: number }>
    }
    const auctionByGid = new Map<string, {
      nodeStatus: string | null
      startedAtMs: number | null
      durationSeconds: number
      history: Array<{ amount: number; atMs: number }>
      maxByIndex: Map<number, { maxAmount: number; serverTimestampMs: number }>
      result: StoredResult | null
    }>()

    await Promise.all(sortedGroups.map(async (gdoc) => {
      const gid = gdoc.id
      const [nodeSnap, bidsSnap] = await Promise.all([
        rtdb.ref(`auctions/${gameInstanceId}/${gid}`).get(),
        instanceRef.collection('groups').doc(gid).collection('bids').get(),
      ])
      const node = nodeSnap.val() as {
        status?: string; startedAtMs?: number; endsAtMs?: number
        history?: Record<string, { amount?: number; atMs?: number }>
      } | null

      const startedAtMs = typeof node?.startedAtMs === 'number' ? node.startedAtMs : null
      const durationSeconds = node?.startedAtMs != null && node?.endsAtMs != null
        ? Math.round((node.endsAtMs - node.startedAtMs) / 1000)
        : Number(ebayGameDef.configFields?.find(f => f.key === 'duration_seconds')?.default ?? 600)

      const history = Object.values(node?.history ?? {})
        .map(h => ({ amount: Number(h?.amount ?? 0), atMs: Number(h?.atMs ?? 0) }))
        .filter(h => h.atMs > 0)
        .sort((a, b) => a.atMs - b.atMs)

      const maxByIndex = new Map<number, { maxAmount: number; serverTimestampMs: number }>()
      for (const b of bidsSnap.docs) {
        const d = b.data()
        if (typeof d['bidderIndex'] === 'number' && typeof d['maxAmount'] === 'number') {
          maxByIndex.set(d['bidderIndex'], {
            maxAmount: d['maxAmount'],
            serverTimestampMs: Number(d['serverTimestampMs'] ?? 0),
          })
        }
      }

      // The reveal (winner/clearing/profit/vCommon) lives on each member's own doc.
      const members = (gdoc.data()['bidder_participants'] as string[] | undefined) ?? []
      let result: StoredResult | null = null
      for (const pid of members) {
        const r = (pById.get(pid) ?? {})['auction_result'] as StoredResult | undefined
        if (r && Array.isArray(r.perBidder)) { result = r; break }
      }

      auctionByGid.set(gid, { nodeStatus: node?.status ?? null, startedAtMs, durationSeconds, history, maxByIndex, result })
    }))

    // ── Report 1: per-group summary ──────────────────────────────────────────────
    const groupReports: GroupReport[] = []
    const timeSeries: GroupSeries[] = []

    for (const gdoc of sortedGroups) {
      const gid = gdoc.id
      const group_number = groupNumberMap.get(gid) ?? null
      const a = auctionByGid.get(gid)
      const members = (gdoc.data()['bidder_participants'] as string[] | undefined) ?? []

      // Time series (Report 2): elapsed seconds vs price.
      const points: Array<{ t: number; price: number }> = [{ t: 0, price: STARTING_PRICE }]
      if (a?.startedAtMs != null) {
        for (const h of a.history) points.push({ t: Math.max(0, (h.atMs - a.startedAtMs) / 1000), price: h.amount })
      }
      timeSeries.push({ group_number, group_id: gid, duration_seconds: a?.durationSeconds ?? 600, points })

      // pid holding a given bidderIndex (for name/expert lookups).
      const pidByIndex = new Map<number, string>()
      for (const pid of members) { const bi = bidderIndexOf(pid); if (bi != null) pidByIndex.set(bi, pid) }
      const expert_name = pidByIndex.has(1) ? nameOf(pidByIndex.get(1)!) : null

      const result = a?.result ?? null
      const noSale = result == null || result.winnerBidderIndex == null
      const auction_status: AuctionStatus =
        result != null ? 'resolved'
        : a?.nodeStatus == null ? 'not-started'
        : a.nodeStatus === 'open' ? 'open'
        : 'closed'

      // Rank submitted maxes to find high + second bidder + their submission times.
      const ranked = a
        ? [...a.maxByIndex.entries()].map(([bi, v]) => ({ bi, ...v })).sort((x, y) => y.maxAmount - x.maxAmount)
        : []
      const startedAtMs = a?.startedAtMs ?? null
      const elapsed = (ms: number): number | null =>
        startedAtMs != null && ms > 0 ? Math.max(0, Math.round((ms - startedAtMs) / 1000)) : null

      const high = ranked[0] ?? null
      const second = ranked[1] ?? null
      const winnerIdx = result?.winnerBidderIndex ?? null
      const winnerBidder = winnerIdx != null ? result?.perBidder.find(b => b.bidderIndex === winnerIdx) : undefined

      const nameFor = (bi: number | null): string | null =>
        bi != null && pidByIndex.has(bi) ? nameOf(pidByIndex.get(bi)!) : null

      // Per-member GAME outcome (never a grade): Won / Lost / No bid, or '—' before resolution.
      const outcomeFor = (bi: number | null): MemberOutcome => {
        if (bi == null || result == null) return '—'
        if (result.winnerBidderIndex === bi) return 'Won'
        return a?.maxByIndex.has(bi) ? 'Lost' : 'No bid'
      }
      const memberOutcomes: GroupMemberOutcome[] = members
        .map(pid => ({ pid, bi: bidderIndexOf(pid) }))
        .filter(m => m.bi != null)
        .sort((x, y) => x.bi! - y.bi!)
        .map(m => ({
          participant_id: m.pid,
          name: nameOf(m.pid),
          bidder_label: bidderLabel(m.bi!),
          outcome: outcomeFor(m.bi),
        }))

      groupReports.push({
        group_number,
        group_id: gid,
        auction_status,
        no_sale: noSale,
        highest_bid: high ? high.maxAmount : null,
        auction_price: result?.clearingPrice ?? null,
        winner_profit: winnerBidder ? winnerBidder.profit : null,
        high_bidder_name: high ? nameFor(high.bi) : null,
        high_bidder_label: high ? bidderLabel(high.bi) : null,
        time_highest_sec: high ? elapsed(high.serverTimestampMs) : null,
        second_bidder_name: second ? nameFor(second.bi) : null,
        second_bidder_label: second ? bidderLabel(second.bi) : null,
        time_second_sec: second ? elapsed(second.serverTimestampMs) : null,
        expert_name,
        members: memberOutcomes,
      })
    }

    // ── Report 3: per-student rows ───────────────────────────────────────────────
    const rows: ReportRow[] = []
    for (const pdoc of participantsSnap.docs) {
      const d = pdoc.data() as PData
      if (d['finalized_at'] == null) continue
      const role = d['role'] as string | undefined
      if (!role || !VALID_ROLES.has(role)) continue
      if (d['raw_score'] === null || d['raw_score'] === undefined) continue   // no-shows excluded

      const groupId = (d['group_id'] as string | undefined) ?? null
      const bi = bidderIndexOf(pdoc.id)
      const a = groupId ? auctionByGid.get(groupId) : undefined
      const result = a?.result ?? null
      const myProfit = (bi != null && result)
        ? result.perBidder.find(b => b.bidderIndex === bi)?.profit ?? null
        : null
      const outcome_label: MemberOutcome | null =
        bi == null || result == null ? null
        : result.winnerBidderIndex === bi ? 'Won'
        : a?.maxByIndex.has(bi) ? 'Lost' : 'No bid'

      const text_answers: Record<string, string> = {}
      for (const field of TEXT_FIELDS) {
        const val = d[field]
        if (typeof val === 'string' && val.trim()) text_answers[field] = val.trim()
      }

      rows.push({
        participant_id: pdoc.id,
        display_name: nameOf(pdoc.id),
        group_number: groupId ? (groupNumberMap.get(groupId) ?? null) : null,
        group_id: groupId,
        role,
        bidder_label: bi != null ? bidderLabel(bi) : null,
        profit: myProfit,
        participation: d['raw_score'] as number,
        knowledge_check_score: (d['knowledge_check_score'] as number | null) ?? null,
        outcome_label,
        text_answers,
      })
    }

    rows.sort((x, y) => {
      const gn = (x.group_number ?? Infinity) - (y.group_number ?? Infinity)
      if (gn !== 0) return gn
      return x.display_name.localeCompare(y.display_name)
    })
    groupReports.sort((x, y) => (x.group_number ?? Infinity) - (y.group_number ?? Infinity))
    timeSeries.sort((x, y) => (x.group_number ?? Infinity) - (y.group_number ?? Infinity))

    return { ok: true as const, rows, groupReports, timeSeries, questions: TEXT_QUESTIONS }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[getReportData] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
