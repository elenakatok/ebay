import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import {
  makeGetInstructorSession,
  makeAssignRole,
  makeCompletePrep,
  makeConfirmReady,
  makeGenerateAttendanceCode,
  makeVerifyAttendanceCode,
  makeGetRoster,
  makeSyncRoster,
  makeTriggerMatching,
  makeStartNegotiation,
  makeSubmitLeadOutcome,
  makeSubmitConfirmation,
  makeSubmitInstructorOutcome,
  makeFinalizeInstance,
  makePushResultsToClassroom,
  makeGetGameConfig,
  makeUpdateGameConfig,
  makeGetStudentPrepQuestions,
  makeGetDebriefQuestions,
  makeSubmitKnowledgeCheck,
  makeSubmitStaticKnowledgeCheckQuestion,
  makeGetInfoUrls,
} from '@mygames/game-server'
import { ebayGameDef } from './gameDefinition'

admin.initializeApp()

// NOTE: eBay now has a single-role KC gate ('kc_gate_bidder', grading 'assigned_role')
// plus 11 graded statics (eBay_KC_Questions_v2.md — see gameDefinition prepDefaults). The
// shared validateKCGate would PASS (exactly one gate covers the 'bidder' role), but we
// still don't invoke it here — validation runs at config-save time in makeUpdateGameConfig.

// ── Game endpoints (onCall, via game-server factories + eBay definition) ─

export const getInstructorSession  = makeGetInstructorSession(ebayGameDef)
export const assignRole             = makeAssignRole(ebayGameDef)
export const completePrep           = makeCompletePrep(ebayGameDef)
export const confirmReady           = makeConfirmReady(ebayGameDef)
export const generateAttendanceCode = makeGenerateAttendanceCode(ebayGameDef)
export const verifyAttendanceCode   = makeVerifyAttendanceCode(ebayGameDef)
export const getRoster              = makeGetRoster(ebayGameDef)
export const syncRoster             = makeSyncRoster(ebayGameDef)
export const triggerMatching            = makeTriggerMatching(ebayGameDef)
export const startNegotiation           = makeStartNegotiation(ebayGameDef)
export const submitLeadOutcome          = makeSubmitLeadOutcome(ebayGameDef)
export const submitConfirmation         = makeSubmitConfirmation(ebayGameDef)
export const submitInstructorOutcome    = makeSubmitInstructorOutcome(ebayGameDef)
export const finalizeInstance       = makeFinalizeInstance(ebayGameDef)
export const pushResultsToClassroom = makePushResultsToClassroom(ebayGameDef)
export const getGameConfig          = makeGetGameConfig(ebayGameDef)
export const updateGameConfig       = makeUpdateGameConfig(ebayGameDef)
export const getStudentPrepQuestions            = makeGetStudentPrepQuestions(ebayGameDef)
export const getDebriefQuestions                = makeGetDebriefQuestions(ebayGameDef)
export const submitKnowledgeCheck               = makeSubmitKnowledgeCheck(ebayGameDef)
export const submitStaticKnowledgeCheckQuestion = makeSubmitStaticKnowledgeCheckQuestion(ebayGameDef)
export const getInfoUrls                        = makeGetInfoUrls(ebayGameDef)
export { getReportData } from './getReportData'
export { scoreAndRecord } from './scoreAndRecord'

// ── Part 3 Slice 0: endowment assignment at match time (Firestore onCreate trigger) ──
export { assignEndowments } from './assignEndowments'

// ── Part 3 Slice 3: live auction server (RTDB state + bid callable) ──
export { startAuction, submitBid, closeAuction, checkAuctionClose } from './liveAuction'

// ── Non-game onRequest endpoints ──────────────────────────────────────────────

const CORS_ORIGINS = new Set(['https://ebay.mygames.live'])

export const health = onRequest((req, res) => {
  const origin = req.headers.origin ?? ''
  if (CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.set('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') { res.status(204).send(''); return }
  res.json({ ok: true, game: 'ebay' })
})

// Emulator-only dev seed functions — onRequest, not game endpoints.
export { seedMatchTest, seedGroupForTest } from './seedFunctions'
