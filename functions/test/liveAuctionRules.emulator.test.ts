// ═══════════════════════════════════════════════════════════════════════════════
// Slice 3 SECURITY test — the confidential max never leaks, and the live auction
// node is server-write-only + own-group-read-only. Enforced by RULES.
//
// Needs the Firestore AND Database emulators. Run via:  npm run test:rules
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
const IID = 'inst1'
const GID = 'grpA'
const OTHER_GID = 'grpB'
const STUDENT = 'student-1'
const REVEAL_MEMBER = 'reveal-m1'   // distinct doc for the Slice-5 reveal tests (shared project)

const fsHost = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8082').split(':')
const dbHost = (process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? '127.0.0.1:9002').split(':')

let testEnv: RulesTestEnvironment

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: fsHost[0], port: Number(fsHost[1]),
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
    },
    database: {
      host: dbHost[0], port: Number(dbHost[1]),
      rules: readFileSync(resolve(__dirname, '../../database.rules.json'), 'utf8'),
    },
  })

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()
    // A confidential proxy max + the group's truth (both server-only).
    await fs.doc(`game_instances/${IID}/groups/${GID}/bids/1`).set({ bidderIndex: 1, maxAmount: 9999, serverTimestampMs: 1 })
    await fs.doc(`game_instances/${IID}/groups/${GID}/truth/auction`).set({ vCommon: 2650 })
    // Slice 5: the full reveal lands on each member's OWN participant doc at resolution
    // (member-only read), copied from bids/ + truth/ — which stay denied forever.
    // Distinct participant ids (this project/instance is SHARED with vCommonDenied's
    // suite, which owns `student-1` — do not clobber it).
    await fs.doc(`game_instances/${IID}/participants/${REVEAL_MEMBER}`).set({
      group_id: GID,
      auction_result: { winnerBidderIndex: 4, clearingPrice: 2901, vCommon: 2650, perBidder: [], resolvedAtMs: 1 },
    })

    const db = ctx.database()
    // Public auction node for the student's group + another group; membership index.
    await db.ref(`auctions/${IID}/${GID}`).set({ status: 'open', currentAmount: 100, highBidderIndex: 2, seq: 3 })
    await db.ref(`auctions/${IID}/${OTHER_GID}`).set({ status: 'open', currentAmount: 50, highBidderIndex: 1, seq: 1 })
    await db.ref(`auctionMembers/${IID}/${STUDENT}`).set(GID)
  })
})

afterAll(async () => { await testEnv?.cleanup() })

describe('Firestore — confidential max (bids/) is denied to clients', () => {
  it('DENIES a student read of a bid max', async () => {
    const fs = testEnv.authenticatedContext(STUDENT).firestore()
    await assertFails(fs.doc(`game_instances/${IID}/groups/${GID}/bids/1`).get())
  })
  it('DENIES an unauthenticated read of a bid max', async () => {
    const fs = testEnv.unauthenticatedContext().firestore()
    await assertFails(fs.doc(`game_instances/${IID}/groups/${GID}/bids/1`).get())
  })
  it('vCommon still denied (regression)', async () => {
    const fs = testEnv.authenticatedContext(STUDENT).firestore()
    await assertFails(fs.doc(`game_instances/${IID}/groups/${GID}/truth/auction`).get())
  })
})

describe('RTDB — auctions/** is server-write-only + own-group-read-only', () => {
  it('a student CAN read their OWN group public node', async () => {
    const db = testEnv.authenticatedContext(STUDENT).database()
    const snap = await assertSucceeds(db.ref(`auctions/${IID}/${GID}`).get())
    expect(snap.val().currentAmount).toBe(100)
  })
  it('DENIES a student read of ANOTHER group node', async () => {
    const db = testEnv.authenticatedContext(STUDENT).database()
    await assertFails(db.ref(`auctions/${IID}/${OTHER_GID}`).get())
  })
  it('DENIES an unauthenticated read of the auction node', async () => {
    const db = testEnv.unauthenticatedContext().database()
    await assertFails(db.ref(`auctions/${IID}/${GID}`).get())
  })
  it('DENIES a student WRITE anywhere under auctions/** (not one field)', async () => {
    const db = testEnv.authenticatedContext(STUDENT).database()
    await assertFails(db.ref(`auctions/${IID}/${GID}/currentAmount`).set(1))
    await assertFails(db.ref(`auctions/${IID}/${GID}/highBidderIndex`).set(1))
    await assertFails(db.ref(`auctions/${IID}/${GID}/history/x`).set({ bidderIndex: 1, amount: 1, atMs: 1 }))
  })
  it('DENIES a student read/write of the server-only auctionMembers index', async () => {
    const db = testEnv.authenticatedContext(STUDENT).database()
    await assertFails(db.ref(`auctionMembers/${IID}/${STUDENT}`).get())
    await assertFails(db.ref(`auctionMembers/${IID}/${STUDENT}`).set(OTHER_GID))
  })
})

describe('Slice 5 — the reveal is readable WITHOUT relaxing bids/ or truth/', () => {
  it('a member CAN read their OWN auction_result after resolution', async () => {
    const fs = testEnv.authenticatedContext(REVEAL_MEMBER).firestore()
    const snap = await assertSucceeds(fs.doc(`game_instances/${IID}/participants/${REVEAL_MEMBER}`).get())
    expect(snap.data()!.auction_result.vCommon).toBe(2650)
    expect(snap.data()!.auction_result.clearingPrice).toBe(2901)
  })
  it('DENIES another student reading someone else\'s reveal (own-doc only)', async () => {
    const fs = testEnv.authenticatedContext('reveal-outsider').firestore()
    await assertFails(fs.doc(`game_instances/${IID}/participants/${REVEAL_MEMBER}`).get())
  })
  it('bids/ (confidential max) STILL denied AFTER resolution — reveal came from the copy', async () => {
    const fs = testEnv.authenticatedContext(STUDENT).firestore()
    await assertFails(fs.doc(`game_instances/${IID}/groups/${GID}/bids/1`).get())
  })
  it('truth/auction (vCommon) STILL denied AFTER resolution — reveal came from the copy', async () => {
    const fs = testEnv.authenticatedContext(STUDENT).firestore()
    await assertFails(fs.doc(`game_instances/${IID}/groups/${GID}/truth/auction`).get())
  })
  it('a member CANNOT client-write auction_result onto their own doc (server-only field)', async () => {
    const fs = testEnv.authenticatedContext(REVEAL_MEMBER).firestore()
    await assertFails(fs.doc(`game_instances/${IID}/participants/${REVEAL_MEMBER}`).update({
      auction_result: { winnerBidderIndex: 1, clearingPrice: 0, vCommon: 0, perBidder: [], resolvedAtMs: 2 },
    }))
  })
})
