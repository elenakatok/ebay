// ═══════════════════════════════════════════════════════════════════════════════
// Slice 0 SECURITY test — a student-authed client CANNOT read the group's vCommon.
//
// This is the entire pedagogical point: one leak of the common value spoils the
// lesson. Enforced by Firestore RULES, not convention. This test proves it.
//
// Requires the Firestore emulator (RULES cannot be exercised without it), so it is
// NOT part of the emulator-free default `npm test`. Run it with:
//     npm run test:rules      (boots firestore emulator, then vitest)
// ═══════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'

const PROJECT_ID = 'demo-ebay'
const INSTANCE = 'inst1'
const GROUP = 'grpA'
const STUDENT = 'student-1'
const OTHER = 'student-2'

// FIRESTORE_EMULATOR_HOST is set by the test:rules script (host:port).
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8082'
const [host, port] = emulatorHost.split(':')

let testEnv: RulesTestEnvironment

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host,
      port: Number(port),
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
    },
  })

  // Seed with rules DISABLED, mimicking the backend (admin SDK) write path.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    // The group doc (client-readable) — deliberately does NOT carry vCommon.
    await db.doc(`game_instances/${INSTANCE}/groups/${GROUP}`).set({
      group_id: GROUP,
      expert_participants: [STUDENT],
      nonexpert_participants: [OTHER],
    })
    // The server-only truth doc — carries vCommon.
    await db.doc(`game_instances/${INSTANCE}/groups/${GROUP}/truth/auction`).set({
      group_id: GROUP,
      vCommon: 2650,
    })
    // The student's own participant doc, stamped with their endowment.
    await db.doc(`game_instances/${INSTANCE}/participants/${STUDENT}`).set({
      participant_id: STUDENT,
      role: 'expert',
      auction_endowment: { bidderIndex: 1, signal: 2650, privateValue: 0, sigma: 0 },
    })
  })
})

afterAll(async () => {
  await testEnv?.cleanup()
})

describe('vCommon is denied to clients (RULES-enforced)', () => {
  it('DENIES a student read of the truth doc (vCommon)', async () => {
    const db = testEnv.authenticatedContext(STUDENT).firestore()
    await assertFails(db.doc(`game_instances/${INSTANCE}/groups/${GROUP}/truth/auction`).get())
  })

  it('DENIES an unauthenticated read of the truth doc', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(db.doc(`game_instances/${INSTANCE}/groups/${GROUP}/truth/auction`).get())
  })

  it('the group doc a student CAN read carries NO vCommon field', async () => {
    const db = testEnv.authenticatedContext(STUDENT).firestore()
    const snap = await assertSucceeds(db.doc(`game_instances/${INSTANCE}/groups/${GROUP}`).get())
    expect(snap.data()?.vCommon).toBeUndefined()
  })

  it('positive control: a student CAN read their own endowment', async () => {
    const db = testEnv.authenticatedContext(STUDENT).firestore()
    const snap = await assertSucceeds(db.doc(`game_instances/${INSTANCE}/participants/${STUDENT}`).get())
    expect(snap.data()?.auction_endowment?.bidderIndex).toBe(1)
  })
})
