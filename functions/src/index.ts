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

// NOTE: validateKCGate is intentionally NOT called. eBay is single-role and has NO
// KC role gate (removed with the single-role move — see gameDefinition prepDefaults).
// The shared validator requires a gate per role, so invoking it would falsely fail.

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
export { updateGroupContract } from './updateGroupContract'
export { scoreAndRecord } from './scoreAndRecord'

// ── Part 3 Slice 0: endowment assignment at match time (Firestore onCreate trigger) ──
export { assignEndowments } from './assignEndowments'

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
