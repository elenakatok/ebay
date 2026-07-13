import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from './firebase'

// ── Helper ────────────────────────────────────────────────────────────────────
// Single wrapper: the Firebase SDK auto-attaches the ID token Bearer when
// auth.currentUser exists, and sends nothing when there is no session —
// covering both bootstrap (getInstructorSession, assignRole) and authed calls.

async function callFn<T>(name: string, data: object = {}): Promise<T> {
  const fn = httpsCallable<object, T>(functions, name)
  const result = await fn(data)
  return result.data
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type TestArgs   = { _test: { participant_id: string; game_instance_id: string } }
export type TokenArgs  = { token: string }
export type BearerArgs = Record<string, never>   // empty — auth is in Authorization header
export type CallArgs   = TestArgs | TokenArgs | BearerArgs

export type AssignRoleResult = {
  ok:               boolean
  role:             string
  customToken:      string
  participant_id:   string
  game_instance_id: string
}

/** Bootstrap — no session yet; classroom JWT or _test bypass travels in data. */
export const assignRole = (args: CallArgs) =>
  callFn<AssignRoleResult>('assignRole', args)

export const CLASSROOM_URL = import.meta.env.DEV
  ? 'http://localhost:5173'
  : 'https://classroom.mygames.live'

// onCall auth errors arrive as FirebaseError with code 'functions/permission-denied'
// or 'functions/unauthenticated' — not HTTP status strings.
export function isAuthError(err: unknown): boolean {
  if (!(err instanceof FirebaseError)) return false
  return (
    err.code === 'functions/permission-denied' ||
    err.code === 'functions/unauthenticated'
  )
}

export type OutcomeFields = Record<string, unknown>

export const confirmReady = (args: CallArgs) =>
  callFn<{ ok: boolean }>('confirmReady', args)

export const verifyAttendanceCode = (args: CallArgs, code: string) =>
  callFn<{ ok: boolean }>('verifyAttendanceCode', { ...args, code })

export const startNegotiation = (args: CallArgs) =>
  callFn<{ ok: boolean }>('startNegotiation', args)

export const submitLeadOutcome = (args: CallArgs, outcome: OutcomeFields | null) =>
  callFn<{ ok: boolean }>('submitLeadOutcome', { ...args, outcome })

export const submitConfirmation = (args: CallArgs, confirmed: boolean) =>
  callFn<{ ok: boolean; outcome: string }>('submitConfirmation', { ...args, confirmed })

// ── Live auction (Slice 3) ──────────────────────────────────────────────────────

/** Instructor: start the live auction for a group (reads duration/increment from config). */
export const startAuction = (groupId: string) =>
  callFn<{ ok: boolean; endsAtMs?: number; startedAtMs?: number; durationSeconds?: number; increment?: number; alreadyStarted?: boolean }>(
    'startAuction', { group_id: groupId })

/** Instructor: close the live auction for a group. */
export const closeAuction = (groupId: string) =>
  callFn<{ ok: boolean }>('closeAuction', { group_id: groupId })

/** Student: submit a confidential proxy max. (Slice 4 wires the real bidding UI to this.) */
export const submitBid = (args: CallArgs, groupId: string, maxAmount: number) =>
  callFn<{ ok: boolean; currentAmount: number; highBidderIndex: number | null }>(
    'submitBid', { ...args, group_id: groupId, max_amount: maxAmount })

/** Student: observe the deadline → resolve + close (idempotent). Slice 5's close trigger. */
export const checkAuctionClose = (args: CallArgs, groupId: string) =>
  callFn<{ ok: boolean; resolved: boolean; alreadyResolved?: boolean; reason?: string }>(
    'checkAuctionClose', { ...args, group_id: groupId })

// ── Instructor API ────────────────────────────────────────────────────────────

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export type RosterParticipant = {
  participant_id: string
  display_name:   string
  role:           string | null
  role_label:     string | null
  group_id:       string | null
  is_lead:        boolean | null
  attended:       boolean
  finalized:      boolean
}

export type RosterGroup = {
  group_id:             string
  status:               string
  lead_participant_id:  string
  participants_by_role: Record<string, string[]>
  agreement_reached:    boolean | null
  outcome:              Record<string, unknown> | null
}

export type PushSummary = {
  total:     number
  succeeded: number
  failed:    { participant_id: string; reason: string }[]
}

/** Bootstrap — no session yet; JWT travels in data; SDK attaches nothing. */
export const getInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('getInstructorSession', args)

/** Remaining instructor calls: SDK auto-attaches Firebase Bearer when session exists. */
export const syncRoster = () =>
  callFn<{ ok: boolean; synced: number; skipped: number }>('syncRoster', {})

export const generateAttendanceCode = () =>
  callFn<{ ok: boolean; code: string }>('generateAttendanceCode', {})

export const getRoster = () =>
  callFn<{ ok: boolean; participants: RosterParticipant[]; groups: RosterGroup[] }>('getRoster', {})

export const triggerMatching = () =>
  callFn<{ ok: boolean; groups: unknown[]; alreadyMatched?: boolean }>('triggerMatching', {})

export const finalizeInstance = () =>
  callFn<{ ok: boolean }>('finalizeInstance', {})

// ── Reports (Slice 7) — mirrors functions/src/getReportData.ts ────────────────────

export type MemberOutcome = 'Won' | 'Lost' | 'No bid' | '—'
export type AuctionStatus = 'not-started' | 'open' | 'closed' | 'resolved'

export type GroupMemberOutcome = {
  participant_id: string
  name: string
  bidder_label: string
  outcome: MemberOutcome
}

export type GroupReport = {
  group_number: number | null
  group_id: string
  auction_status: AuctionStatus
  no_sale: boolean
  highest_bid: number | null
  auction_price: number | null
  winner_profit: number | null
  high_bidder_name: string | null
  high_bidder_label: string | null
  time_highest_sec: number | null
  second_bidder_name: string | null
  second_bidder_label: string | null
  time_second_sec: number | null
  expert_name: string | null
  members: GroupMemberOutcome[]
}

export type GroupSeries = {
  group_number: number | null
  group_id: string
  duration_seconds: number
  points: Array<{ t: number; price: number }>
}

export type StudentReportRow = {
  participant_id: string
  display_name: string
  group_number: number | null
  group_id: string | null
  role: string
  bidder_label: string | null
  profit: number | null
  participation: number | null
  knowledge_check_score: number | null
  outcome_label: MemberOutcome | null
  text_answers: Record<string, string>
}

export type ReportQuestion = { field: string; prompt: string; role_target: string }

export type ReportData = {
  ok: boolean
  rows: StudentReportRow[]
  groupReports: GroupReport[]
  timeSeries: GroupSeries[]
  questions: ReportQuestion[]
}

export const getReportData = () => callFn<ReportData>('getReportData', {})

export const pushResultsToClassroom = () =>
  callFn<{ ok: boolean } & PushSummary>('pushResultsToClassroom', {})
