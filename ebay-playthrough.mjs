/**
 * eBay SINGLE-ROLE skeleton — EMULATOR play-through (Playwright, real browser).
 *
 * A UI-driven regression harness. 13 students, ONE role `bidder` → single-role
 * matching tiles to [5,4,4] (spec §2b): a 4→5 flex group plus two of 4. Students
 * bootstrap via the DEV `?_pid=&_gid=` _test bypass; the instructor is driven via the
 * REAL dashboard buttons (Generate Code / Match Now / the deadlock-override control /
 * Score & Record); all reads hit the emulator Firestore REST endpoint with
 * `Bearer owner`.
 *
 * NON-NEGOTIABLE (Baxter lessons baked in):
 *  • Every student state transition is driven by CLICKING THE ACTUAL BUTTON /
 *    FILLING THE ACTUAL FIELD in the browser — never a backend/API call. (A Baxter
 *    bug survived fix attempts because Playwright called the function, not the button.)
 *  • Instructor gates are driven through the real dashboard UI too.
 *  • CLEAN-START UNCONDITIONALLY: this harness tears down + rebuilds the whole local
 *    stack (functions build → emulators → Vite) at the start of every run. No port probe.
 *  • The gradebook push is OBSERVED for real: a mock classroom callback is wired via
 *    functions/.env.local BEFORE the emulator boots, so the dashboard "Score & Record"
 *    button's real POST lands on it (POST + 200 asserted). Nothing is stubbed to pass.
 *
 * COVERAGE (student launch → grade push):
 *   1. Instructor: dashboard loads, roster visible (all 13 students).
 *   2. Every student launches as the single role `bidder` (no role branch).
 *   3. REAL KC (Slice 6): a single-option role gate ("What is your role?" → Bidder,
 *      always true → passes first click) + Gary's 5 graded MC. Options shuffle per
 *      student (drive selects by label text). stu-1 gets 3/5 (score 0.6), stu-2 gets
 *      0/5 (score 0 — a wrong answer never blocks), everyone else 5/5 (1.0).
 *   4. Info-document phase: the role sheet link is present AND resolves (shared eBay.pdf).
 *   5. Matching: 13 → [5,4,4] — R1 all placed, 4→5 flex, R2 exactly one expert
 *      (bidderIndex 1) per group, each student's payload carries their own endowment,
 *      and vCommon is absent from every client-readable group doc.
 *   6. Outcome: a `price` deal is accepted + persisted (schema-valid).
 *   7. Deadlock override: the dashboard control submits { price } (NOT { placeholder }) —
 *      locks in the Part-1 fix of the latent Hawks-scaffold bug.
 *   8. GRADING (Slice 6 — participation + KC only, PROFIT NEVER GRADED): every present
 *      bidder gets the SAME flat raw (degenerate pool → z 0); the cursed winner (−$151)
 *      and a losing bidder ($0) get the SAME participation score; silent bidders are
 *      PRESENT (not −2); the true no-show is raw null / z −2, EXCLUDED; KC score (0–1)
 *      rides as its own gradebook field; nobody is dropped from the push.
 *   9. LIVE AUCTION (Slice 4 — driven through the REAL student bidding UI): Start button
 *      opens the auction; the STORED duration override (60s) takes effect; every student
 *      reaches the bidding screen; the clock counts down; the private-info panel is
 *      correct per role and NO non-expert ever sees the expert value (2650); status
 *      flips winning/not-winning; one history row per submitted bid; a losing max (109)
 *      never renders; the personal outbid + defended messages appear; raise-only is
 *      rejected; the fat-finger confirm fires and Cancel does not submit; 4 simultaneous
 *      UI bids settle to the exact proxy price 3001 with no lost updates; no confidential
 *      max appears anywhere in RTDB; the startAuction guard blocks an un-endowed group;
 *      at the server deadline the clock stops and the bid control vanishes (no snipe).
 *      Every student bid is a real fill-field + click — NO submitBid callable is poked.
 *  10. Finalize: Score & Record → participation+KC scoring → real grade push (POST + 200).
 *  11. Reports (Slice 6): the instructor Reports page loads for a RESOLVED auction, with
 *      a real KC-score column and no negotiation-era crash.
 *
 * ── ONE-COMMAND RUN ──────────────────────────────────────────────────────────
 *   From the eBay repo root (where playwright resolves):
 *     cd games/ebay && node ebay-playthrough.mjs
 *   Env: HEADED=1 to watch the browsers; SLOWMO=80 to slow clicks.
 *   (one-time: `npm install` at games/ebay to install the declared playwright devDependency)
 */

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, openSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Config ─────────────────────────────────────────────────────────────────────

const PROJECT   = 'ebay-mygames-live'
const ROOT      = path.dirname(fileURLToPath(import.meta.url))
const FE        = process.env.FE_BASE ?? 'http://localhost:5173'
const FUNCTIONS = process.env.FN_BASE ?? `http://localhost:5005/${PROJECT}/us-central1`
const FIRESTORE = process.env.FS_BASE ?? `http://localhost:8082/v1/projects/${PROJECT}/databases/(default)/documents`
const DATABASE  = process.env.DB_BASE ?? 'http://localhost:9002'
const DB_NS     = `${PROJECT}-default-rtdb`
const HEADED    = process.env.HEADED === '1'
const SLOWMO    = process.env.SLOWMO ? Number(process.env.SLOWMO) : 0

// Emulator + Vite ports (source: firebase.json emulators block + Vite default).
const PORTS = [9101, 5005, 8082, 9002, 5006, 4002, 5173]

// A fresh instance id per run so re-runs never collide.
const GID  = process.env.GID ?? `pt-${Date.now()}`
// 13 students. ONE is the TRUE NO-SHOW (launches + completes KC, never attends class);
// the other 12 attend → single-role matching tiles to [4,4,4] (spec §2b / planGroupSizes) —
// three groups of 4: happy-deal + conformance-close + no-sale (present-but-no-bid), and
// the held-back no-show proves the −2 floor. Every student is placed (no orphans).
const PIDS = Array.from({ length: 13 }, (_, i) => `stu-${i + 1}`)

// Placeholder prices: happy-path group vs deadlock-override group.
const HAPPY_PRICE    = 500
const DEADLOCK_PRICE = 777

// ── Slice 6: the REAL KC (single-option gate + 5 graded statics) + the no-show ──
const NOSHOW_PID  = PIDS[PIDS.length - 1]              // stu-13 — launches + KC, never attends
const ATTEND_PIDS = PIDS.filter(p => p !== NOSHOW_PID) // the 12 who attend → [4,4,4]

// The 5 graded statics, in stepper order (prepDefaults order 1..5). For each, a UNIQUE
// substring of the CORRECT option label and of a WRONG option label — the drive selects
// by TEXT so it is immune to the per-student option shuffle. (Verbatim from
// eBay_KC_Questions_v1.md; Q3 uses the corrected 2×2 set, Q5 has 3 options.)
const KC_FIELDS  = ['kc_private_vs_common', 'kc_information_structure', 'kc_second_price', 'kc_hard_close', 'kc_profit_definition']
const KC_CORRECT = {
  kc_private_vs_common:     'learn nothing about the value',
  kc_information_structure: 'uncertain information about the non-expert',
  kc_second_price:          'the highest bid. They pay the second highest bid',
  kc_hard_close:            'At a pre-specified time',
  kc_profit_definition:     'Neither of the above',
}
const KC_WRONG = {
  kc_private_vs_common:     'attract more bidders',
  kc_information_structure: 'You will be a seller',
  kc_second_price:          'second highest bid. They pay their own bid',
  kc_hard_close:            'no buyer wants to bid',
  kc_profit_definition:     'Use value',
}
// Answer plan by pid: stu-1 → 3/5 (score 0.6); stu-2 → 0/5 (score 0); all others → 5/5 (1.0).
const KC_THREE_PID = PIDS[0]   // stu-1
const KC_ZERO_PID  = PIDS[1]   // stu-2
function kcPlanFor(pid) {
  if (pid === KC_THREE_PID) return new Set(['kc_private_vs_common', 'kc_information_structure', 'kc_second_price'])
  if (pid === KC_ZERO_PID)  return new Set()
  return new Set(KC_FIELDS)     // everyone else answers all 5 correctly
}

// ── Tiny test harness ──────────────────────────────────────────────────────────

let PASS = 0, FAIL = 0
const log    = (tag, msg) => console.log(`[${tag}] ${msg}`)
const banner = msg => console.log('\n' + '─'.repeat(66) + '\n' + msg + '\n' + '─'.repeat(66))
function assert(cond, name) {
  if (cond) { PASS++; console.log(`  ✓ ASSERT: ${name}`) }
  else      { FAIL++; console.log(`  ✗ ASSERT FAILED: ${name}`) }
}

// ── On-failure diagnostics (never affects pass/fail) ────────────────────────────

let browser = null
const students = []      // { page, pid, role }
let dash = null          // instructor dashboard page
const ARTIFACT_DIR = path.resolve(ROOT, 'playthrough-artifacts', GID)

async function headingText(page) {
  try {
    const hs = (await page.locator('h1').allTextContents()).map(h => h.trim()).filter(Boolean)
    return hs.length ? hs.join(' | ') : '(no <h1> visible)'
  } catch { return '(could not read <h1>)' }
}
async function dumpDiagnostics(reason) {
  console.log('\n' + '═'.repeat(66) + '\nDIAGNOSTIC DUMP — ' + reason + '\n' + '═'.repeat(66))
  try { mkdirSync(ARTIFACT_DIR, { recursive: true }) } catch { /* best effort */ }
  const targets = [
    ...students.map(s => ({ label: s.pid, page: s.page })),
    ...(dash ? [{ label: 'dashboard', page: dash }] : []),
  ]
  for (const { label, page } of targets) {
    if (!page) continue
    const heading = await headingText(page)
    let url = '(unknown)'; try { url = page.url() } catch { /* closed */ }
    let shot = path.join(ARTIFACT_DIR, `${label}.png`)
    try { await page.screenshot({ path: shot, fullPage: true }) } catch (e) { shot = `(screenshot failed: ${e.message})` }
    console.log(`  [${label}]  heading: ${heading}`)
    console.log(`  ${' '.repeat(label.length)}   url: ${url}`)
    console.log(`  ${' '.repeat(label.length)}   shot: ${shot}`)
  }
  console.log('═'.repeat(66) + '\n')
}

// ── Firestore REST helpers (emulator; owner auth bypasses rules) ────────────────

async function fsGetDocs(collection) {
  const res = await fetch(`${FIRESTORE}/game_instances/${GID}/${collection}?pageSize=100`, {
    headers: { Authorization: 'Bearer owner' },
  })
  if (!res.ok) return []
  return (await res.json()).documents ?? []
}
async function fsGetDoc(pathSuffix) {
  const res = await fetch(`${FIRESTORE}/game_instances/${GID}/${pathSuffix}`, {
    headers: { Authorization: 'Bearer owner' },
  })
  if (!res.ok) return null
  return res.json()
}
const strVal = f => f?.stringValue ?? ''
const numVal = f => (f?.integerValue != null ? parseInt(f.integerValue, 10) : (f?.doubleValue ?? null))
const arrVal = f => (f?.arrayValue?.values ?? []).map(v => v.stringValue)

async function readParticipants() {
  const docs = await fsGetDocs('participants')
  return docs.map(d => {
    // auction_endowment is a map field written by the assignEndowments trigger.
    const endow = d.fields?.auction_endowment?.mapValue?.fields
    return {
      id:               d.name.split('/').pop(),
      role:             strVal(d.fields?.role),
      is_lead:          d.fields?.is_lead?.booleanValue ?? false,
      group_id:         strVal(d.fields?.group_id),
      raw_score:        numVal(d.fields?.raw_score),
      normalized_score: numVal(d.fields?.normalized_score),
      knowledge_check_score: numVal(d.fields?.knowledge_check_score),
      // Own endowment (the client-readable payload); undefined until the trigger runs.
      bidderIndex:      endow ? numVal(endow.bidderIndex) : null,
      hasEndowment:     endow != null,
    }
  })
}
async function readGroups() {
  const docs = await fsGetDocs('groups')
  return docs.map(d => {
    const outcome = d.fields?.outcome?.mapValue?.fields
    return {
      id:        d.name.split('/').pop(),
      status:    strVal(d.fields?.status),
      agreement: d.fields?.agreement_reached?.booleanValue ?? null,
      bidders:   arrVal(d.fields?.bidder_participants),   // single-role membership
      lead:      strVal(d.fields?.lead_participant_id),
      // vCommon must NEVER be on the client-readable group doc (it lives in a
      // server-only truth subcollection). Capture it so we can assert its absence.
      vCommonOnGroup: d.fields?.vCommon !== undefined,
      // The placeholder outcome: single `price` decimal (+ optional notes).
      price:     outcome?.price != null ? numVal(outcome.price) : null,
      hasOutcome: outcome != null,
    }
  })
}
async function pollGroups(pred, maxMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const gs = await readGroups()
    if (gs.length && pred(gs)) return gs
    await sleep(700)
  }
  return readGroups()
}
// Endowments are written by the assignEndowments onCreate TRIGGER, which fires
// asynchronously AFTER triggerMatching commits the group docs — so participant docs
// gain auction_endowment a beat after group_id. Poll until the predicate holds.
async function pollParticipants(pred, maxMs = 30_000) {
  const start = Date.now()
  let ps = await readParticipants()
  while (Date.now() - start < maxMs) {
    ps = await readParticipants()
    if (ps.length && pred(ps)) return ps
    await sleep(700)
  }
  return ps
}
async function readAttendanceCode() {
  const doc = await fsGetDoc('attendance_code/current')
  return doc?.fields?.code?.stringValue ?? null
}

// ── RTDB emulator REST + callable helpers (Slice 3 live auction) ─────────────────
// Bearer owner bypasses RTDB rules so the harness can read the server-only truth.
async function rtdbGet(rpath) {
  const res = await fetch(`${DATABASE}/${rpath}.json?ns=${DB_NS}`, { headers: { Authorization: 'Bearer owner' } })
  if (!res.ok) return null
  return res.json()
}
const readAuction = gid => rtdbGet(`auctions/${GID}/${gid}`)
async function pollAuction(gid, pred, maxMs = 15_000) {
  const start = Date.now()
  let a = await readAuction(gid)
  while (Date.now() - start < maxMs) {
    a = await readAuction(gid)
    if (pred(a)) return a
    await sleep(500)
  }
  return a
}
// Direct callable POST to the functions emulator. Returns {ok,status,result,error}.
async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data }),
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, result: body.result, error: body.error }
}
const startAuctionFn = gid => callFn('startAuction', { _dev: { game_instance_id: GID }, group_id: gid })
const submitBidFn = (pid, gid, maxAmount, extra = {}) =>
  callFn('submitBid', { _test: { participant_id: pid, game_instance_id: GID }, group_id: gid, max_amount: maxAmount, ...extra })

// Firestore REST: set/clear a participant's raw auction_endowment field (owner bypass).
async function patchEndowment(pid, rawValueOrNull) {
  const body = { fields: { auction_endowment: rawValueOrNull ?? { nullValue: null } } }
  const res = await fetch(`${FIRESTORE}/game_instances/${GID}/participants/${pid}?updateMask.fieldPaths=auction_endowment`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return res.ok
}
// Recursively collect every numeric leaf under an RTDB subtree (for the no-max walk).
function numericLeaves(node, out = []) {
  if (node == null) return out
  if (typeof node === 'number') { out.push(node); return out }
  if (typeof node === 'object') for (const v of Object.values(node)) numericLeaves(v, out)
  return out
}

// ── Slice 4: drive the REAL student bidding UI (never a submitBid callable) ───────
// The frozen eBay endowment table (functions/src/ebayAuction.ts), by bidderIndex —
// so the harness can assert each role's private-info panel and prove no non-expert
// ever sees the expert's exact value (2650).
const EBAY_SIGNAL = { 1: 2650, 2: 1900, 3: 2850, 4: 3200, 5: 2650, 6: 2300, 7: 3000 }
const EBAY_USE    = { 1: 0,    2: 100,  3: 300,  4: 100,  5: 100,  6: 200,  7: 100 }
const dollars = n => '$' + n.toLocaleString('en-US')

const AUCTION_SCREEN = '[data-testid="auction-screen"]'
const waitAuctionScreen = (page, ms = 25_000) => page.waitForSelector(AUCTION_SCREEN, { timeout: ms })
const bodyText    = page => page.locator('body').innerText()
const historyRows = page => page.locator('[data-testid="auction-history-row"]').count()
// Fill the max field + click Place bid (no fat-finger dialog expected for these amounts).
async function uiBid(page, amount) {
  await page.locator('[data-testid="auction-max-input"]').fill(String(amount))
  await page.locator('[data-testid="auction-place-bid"]').click()
}

// ── Slice 5: close-on-deadline → resolve → full-reveal results ────────────────────
const RESULTS_SCREEN = '[data-testid="auction-results"]'
const waitResults = (page, ms = 30_000) => page.waitForSelector(RESULTS_SCREEN, { timeout: ms })
const dataAttr = (page, testid, a) => page.locator(`[data-testid="${testid}"]`).getAttribute(a)
// ADVERSARIAL/SECURITY helper: the deadline-observed close trigger, as a direct callable.
const checkCloseFn = (pid, gid) => callFn('checkAuctionClose', { _test: { participant_id: pid, game_instance_id: GID }, group_id: gid })
// Read the stored reveal (auction_result) off a member's participant doc via owner REST.
const restNum = f => (f?.integerValue != null ? parseInt(f.integerValue, 10) : (f?.doubleValue != null ? f.doubleValue : null))
async function readStoredResult(pid) {
  const d = await fsGetDoc(`participants/${pid}`)
  const f = d?.fields?.auction_result?.mapValue?.fields
  if (!f) return null
  const perBidder = (f.perBidder?.arrayValue?.values ?? []).map(v => {
    const b = v.mapValue.fields
    return { bidderIndex: restNum(b.bidderIndex), maxAmount: restNum(b.maxAmount), profit: restNum(b.profit) }
  })
  return { winner: restNum(f.winnerBidderIndex), clearing: restNum(f.clearingPrice), vCommon: restNum(f.vCommon), resolvedAtMs: restNum(f.resolvedAtMs), perBidder }
}
async function pollStoredResult(pid, ms = 40_000) {
  const start = Date.now()
  let r = await readStoredResult(pid)
  while (Date.now() - start < ms && !r) { await sleep(700); r = await readStoredResult(pid) }
  return r
}
// Read every results-row's {bidder, max, profit} from a rendered reveal table.
const readResultRows = page => page.locator('[data-testid="results-row"]').evaluateAll(
  rows => rows.map(r => ({ bidder: Number(r.dataset.bidder), max: r.dataset.max, profit: Number(r.dataset.profit), won: r.dataset.won === 'true' })))

// ── Student / dashboard URLs (DEV bypasses) ─────────────────────────────────────

const studentUrl   = pid => `${FE}/?_pid=${pid}&_gid=${GID}&_session=tab`
const dashboardUrl = () => `${FE}/dashboard?_dev_game_instance_id=${encodeURIComponent(GID)}&_session=tab`

// ── Phase 1: info → KC gate → graded MC → reflection → hold (per student) ───────

// The assignRole endpoint runs a Firestore transaction on ONE shared role_counts doc. The
// Firestore EMULATOR locks pessimistically with a short timeout, so concurrent assignRole calls
// cascade into "10 ABORTED: Transaction lock timeout" (and reload-retries pile on more). So the
// role-assignment step is driven SEQUENTIALLY (below), one student at a time → zero contention.
// A light retry still covers a cold first worker. Everything AFTER the role page (KC/prep, which
// write per-participant docs — no shared-doc transaction) is driven concurrently.
async function ensureOnRolePage(page, pid) {
  let onRole = false
  for (let attempt = 1; attempt <= 6 && !onRole; attempt++) {
    await page.goto(studentUrl(pid))
    onRole = await page.waitForSelector('p:has-text("Your role")', { timeout: 20_000 }).then(() => true).catch(() => false)
    if (!onRole) { log(pid, `role-assign attempt ${attempt} not ready — reloading`); await sleep(1500) }
  }
  if (!onRole) throw new Error(`${pid} never reached the role page`)
}

// Drive the REAL KC (Slice 6): the single-option role gate + 5 graded statics. Selects
// options by UNIQUE label text (immune to the per-student option shuffle). Captures each
// question's shuffled option order (for the shuffle assertion) and returns it.
async function driveKnowledgeCheck(page, pid, correctSet) {
  // ── Gate (Q0): one option "Bidder" — always the true role → passes on the first click ──
  await page.waitForSelector('p:has-text("Knowledge check")', { timeout: 30_000 })
  await page.locator('main label', { hasText: 'Bidder' }).first().click()
  await page.locator('button:has-text("Submit")').click()

  // ── 5 graded statics (stepper "Concept check — N of 5") ──
  const orders = {}
  let staticsSeen = 0
  for (let i = 0; i < KC_FIELDS.length; i++) {
    const field = KC_FIELDS[i]
    // Regex (dash-agnostic) so the em-dash in "Concept check — N of 5" can't miss.
    await page.locator('p', { hasText: new RegExp(`Concept check.*${i + 1} of 5`) }).first().waitFor({ timeout: 30_000 })
    staticsSeen++
    // This student's SHUFFLED option order (label text, DOM order) for the shuffle proof.
    orders[field] = (await page.locator('main label').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim())
    const pick = correctSet.has(field) ? KC_CORRECT[field] : KC_WRONG[field]
    await page.locator('main label', { hasText: pick }).first().click()
    await page.locator('button:has-text("Submit")').click()
    // Post-answer: ✓/✗ + explanation, then Continue (a wrong answer NEVER blocks progress).
    await page.waitForSelector('button:has-text("Continue")', { timeout: 15_000 })
    await page.locator('button:has-text("Continue")').click()
  }
  return { orders, staticsSeen, sawGate: true }
}

async function driveSetup(page, pid) {
  // SINGLE ROLE: everyone is a Bidder (the info page shows "Your role: Bidder").
  const roleLabel = ((await page.locator('h1').first().textContent()) ?? '').trim()
  log(pid, `info: "${roleLabel}" (bidder)`)

  // Info-document phase: the ONE shared case PDF, eBay.pdf, for the single role.
  const sheetLink = page.locator('a', { hasText: 'Role sheet' }).first()
  await sheetLink.waitFor({ timeout: 15_000 })
  const href = await sheetLink.getAttribute('href')
  assert(href === '/role-info/eBay.pdf',
    `Info doc — the bidder role sheet link points at the shared eBay.pdf (href=${href})`)

  await page.click('button:has-text("Continue")')

  // Slice 6: the REAL KC — single-option role gate ("What is your role?" → Bidder, always
  // true → passes first click) then 5 graded MC. Options shuffle per student, so the drive
  // picks by unique label text. stu-1 gets 3/5, stu-2 gets 0/5, everyone else 5/5.
  const kc = await driveKnowledgeCheck(page, pid, kcPlanFor(pid))

  // Reflection (ungraded, category 'preparation') — kept so the prep phase + Reports
  // text tile still have content.
  await page.waitForSelector('p:has-text("Preparation — 1 of 1")', { timeout: 30_000 })
  await page.locator('textarea').fill(`Bidder plan: bid to my value, avoid the winner's curse.`)
  await page.click('button:has-text("Complete")')

  await page.waitForSelector('h1:has-text("Preparation complete")', { timeout: 30_000 })
  log(pid, '◆ hold screen')
  return { page, pid, role: 'bidder', kc }
}

// ── Phase 1b: hold → confirmation → attendance code → waiting room ──────────────

async function driveToWaiting(s, code) {
  const { page, pid } = s
  await page.click('button:has-text("in class")')
  await page.waitForSelector('h1:has-text("Ready to negotiate?")', { timeout: 20_000 })
  await page.click("button:has-text(\"Yes, I'm ready\")")
  await page.waitForSelector('h1:has-text("Enter attendance code")', { timeout: 20_000 })
  await page.locator('input').fill(code)
  await page.click('button[type="submit"]')
  await page.waitForSelector('h1:has-text("Waiting to be matched")', { timeout: 30_000 })
  log(pid, '★ waiting room')
}

// ── Instructor Settings: save the live-auction duration + increment (REAL page) ──
// Exercises the STORED-override path (Part-2 handoff flagged it as never covered):
// the instructor changes duration in Settings, and startAuction must pick it up.
async function saveAuctionSettings(page, durationSeconds, increment = 1) {
  await page.goto(`${FE}/settings?_dev_game_instance_id=${encodeURIComponent(GID)}&_session=tab`)
  await page.waitForSelector('button:has-text("Auction")', { timeout: 30_000 })
  const durInput = page.locator('#cfg-duration_seconds')
  if (!(await durInput.isVisible().catch(() => false))) {
    await page.locator('button', { hasText: 'Auction' }).first().click()
  }
  await durInput.waitFor({ state: 'visible', timeout: 10_000 })
  // Inputs are disabled until the session is ready + config loaded.
  await page.waitForFunction(() => {
    const el = document.querySelector('#cfg-duration_seconds')
    return el && !el.disabled
  }, { timeout: 20_000 })
  await durInput.fill(String(durationSeconds))
  await page.locator('#cfg-bid_increment').fill(String(increment))   // section save validates BOTH fields
  const body = durInput.locator('xpath=ancestor::div[3]')
  await body.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForSelector('span:has-text("Saved ")', { timeout: 15_000 }).catch(() => {})
}

// ── Group reveal → off-platform → (report form ready) ───────────────────────────

async function startGroupToReport(members) {
  // One "Start negotiation" click → the rest auto-advance to "Go negotiate".
  await members[0].page.waitForSelector('h1:has-text("Your negotiation group")', { timeout: 60_000 })
  await members[0].page.click('button:has-text("Start negotiation")')
  await members[0].page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 20_000 })
  for (const m of members.slice(1)) {
    const flipped = await m.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 15_000 })
      .then(() => true).catch(() => false)
    if (!flipped) { await m.page.click('button:has-text("Start negotiation")'); await m.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 15_000 }) }
  }
  // Everyone taps "We've finished — report our outcome".
  await Promise.all(members.map(m => m.page.click("button:has-text(\"We've finished\")").catch(() => {})))
}

/** Lead fills the placeholder price + submits a deal; non-leads all Confirm. */
async function reportPriceDeal(members, price) {
  const lead = members.find(m => m.is_lead) ?? members[0]
  const nonLeads = members.filter(m => m !== lead)
  await lead.page.waitForSelector('h1:has-text("Report outcome")', { timeout: 30_000 })
  await lead.page.locator('input[type="number"]').fill(String(price))
  await lead.page.click('button:has-text("Review & submit")')
  await lead.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
  await lead.page.click('button:has-text("Yes, submit")')
  // Confirm one at a time — submitConfirmation is a transaction on the shared group doc, and the
  // Firestore emulator lock-times-out under concurrent transactions on one doc (same failure mode
  // as role_counts). Sequential confirms keep it deterministic.
  for (const m of nonLeads) {
    await m.page.waitForSelector('h1:has-text("Confirm the outcome")', { timeout: 30_000 })
    await m.page.click('button:has-text("Confirm")')
  }
}

/** Lead reports NO DEAL (walk-away); all non-leads Confirm. Present-but-no-bid case. */
async function reportNoDeal(members) {
  const lead = members.find(m => m.is_lead) ?? members[0]
  const nonLeads = members.filter(m => m !== lead)
  await lead.page.waitForSelector('h1:has-text("Report outcome")', { timeout: 30_000 })
  await lead.page.click('button:has-text("No deal")')
  await lead.page.waitForSelector('h1:has-text("Confirm no deal")', { timeout: 10_000 })
  await lead.page.click('button:has-text("Yes, no deal")')
  for (const m of nonLeads) {
    await m.page.waitForSelector('h1:has-text("Confirm the outcome")', { timeout: 30_000 })
    await m.page.click('button:has-text("Confirm")')
  }
}

/** One reject cycle: lead reports a price, one non-lead REJECTS → group resets. */
async function rejectCycle(members, price) {
  const lead = members.find(m => m.is_lead) ?? members[0]
  const rejecter = members.find(m => m !== lead)
  await lead.page.waitForSelector('h1:has-text("Report outcome")', { timeout: 30_000 })
  await lead.page.locator('input[type="number"]').fill(String(price))
  await lead.page.click('button:has-text("Review & submit")')
  await lead.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
  await lead.page.click('button:has-text("Yes, submit")')
  await rejecter.page.waitForSelector('h1:has-text("Confirm the outcome")', { timeout: 30_000 })
  await rejecter.page.click('button:has-text("Reject")')
}

// ── Local stack lifecycle (unconditional clean-start) ───────────────────────────

const children = []
function freePorts() {
  for (const p of PORTS) {
    // -sTCP:LISTEN so we kill only the SERVER on each port — not client sockets connected to it.
    // (Plain `lsof -ti tcp:P` also lists this harness's own fetch connections to 5005/8082/…, so
    // an unfiltered kill -9 would SIGKILL the harness itself during teardown → spurious exit 137.)
    try { execSync(`lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9`, { stdio: 'ignore' }) } catch { /* none */ }
  }
}
// Readiness via HTTP against the SAME localhost URLs the harness/browser use — avoids
// the IPv4(127.0.0.1)/IPv6(::1) loopback mismatch a raw TCP probe hits with Vite on macOS.
async function waitHttp(url, label, maxMs = 90_000) {
  const start = Date.now()
  for (;;) {
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.status > 0) return
    } catch { /* not up yet */ }
    if (Date.now() - start > maxMs) throw new Error(`${label} (${url}) never became ready`)
    await sleep(700)
  }
}
function spawnLogged(cmd, args, cwd, logFile) {
  const out = openSync(logFile, 'a')
  const child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', out, out] })
  children.push(child)
  return child
}

async function startMockCallback() {
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      try { received.push({ auth: req.headers.authorization, result: JSON.parse(body) }) }
      catch { received.push({ auth: req.headers.authorization, result: body }) }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}')
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return { port, received, close: () => new Promise(r => server.close(r)) }
}

async function bringUpStack(mockPort) {
  banner('CLEAN-START — tear down + rebuild the local stack (unconditional)')
  freePorts()
  await sleep(1200)

  // Wire the mock classroom callback into the emulator BEFORE it boots, so the real
  // dashboard "Score & Record" push lands on our observer (functions/.env.local is
  // gitignored + emulator-only; the prod callback URL in functions/.env is untouched).
  const cb = `http://127.0.0.1:${mockPort}/receiveGameResult`
  writeFileSync(path.join(ROOT, 'functions/.env.local'),
    `CLASSROOM_CALLBACK_URL=${cb}\nCLASSROOM_ROSTER_URL=http://127.0.0.1:${mockPort}/getCourseRoster\n`)

  // Frontend dev/emulator config (vite loads .env.local in all modes; .env.production is
  // production-only). Real values are irrelevant — connectXxxEmulator overrides every
  // connection — but projectId MUST match so the frontend writes to the same emulator
  // namespace the harness reads. Mirrors Baxter's committed frontend/.env.local.
  writeFileSync(path.join(ROOT, 'frontend/.env.local'),
    [
      'VITE_FIREBASE_API_KEY=dev-placeholder',
      `VITE_FIREBASE_PROJECT_ID=${PROJECT}`,
      `VITE_FIREBASE_AUTH_DOMAIN=${PROJECT}.firebaseapp.com`,
      `VITE_FIREBASE_STORAGE_BUCKET=${PROJECT}.firebasestorage.app`,
      'VITE_FIREBASE_MESSAGING_SENDER_ID=000000000000',
      'VITE_FIREBASE_APP_ID=1:000000000000:web:000000000000000000000000',
      `VITE_FIREBASE_DATABASE_URL=https://${PROJECT}-default-rtdb.firebaseio.com`,
      '',
    ].join('\n'))

  console.log('▶ Building Cloud Functions…')
  execSync('npm run build', { cwd: path.join(ROOT, 'functions'), stdio: 'inherit' })

  console.log('▶ Starting emulators + Vite…')
  const emuLog  = path.join(ROOT, 'playthrough-emu.log')
  const viteLog = path.join(ROOT, 'playthrough-vite.log')
  spawnLogged('firebase', ['emulators:start', '--only', 'auth,functions,firestore,database', '--project', PROJECT], ROOT, emuLog)
  spawnLogged('npm', ['run', 'dev'], path.join(ROOT, 'frontend'), viteLog)

  console.log('▶ Waiting for all emulators + Vite…')
  // assignRole needs Firestore (role_counts tx) + Auth (createCustomToken); the functions
  // /health endpoint answers before those are serving, so wait for EVERY emulator, not just
  // functions, or the first assignRole cold-starts into an 'internal' error.
  await waitHttp('http://localhost:9101/', 'auth emulator')
  await waitHttp('http://localhost:8082/', 'firestore emulator')
  await waitHttp('http://localhost:9002/.json', 'database emulator')
  await waitHttp(`${FUNCTIONS}/health`, 'functions emulator')
  await waitHttp(`${FE}/`, 'Vite dev server')
  await sleep(6000)
  console.log('  Stack ready ✅')
}

function tearDownStack() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { /* gone */ } }
  freePorts()
}

// ── MAIN ────────────────────────────────────────────────────────────────────────

async function main() {
  const mock = await startMockCallback()
  await bringUpStack(mock.port)

  browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO })

  // Warm up the DEV stack before the real run: Vite transforms the whole module graph
  // on-demand on first hit (React + firebase + game-ui — tens of seconds cold), and the
  // functions emulator cold-starts on its first callable. Drive ONE throwaway student to
  // "Your role" so that one-time cost is paid before the concurrent 8 launch (else their
  // first waitForSelector races the cold transform).
  banner('Warmup — priming Vite transform + spinning up function workers')
  {
    // Warm ONE page to pay the Vite first-transform + first assignRole cold-start (with retry).
    const warmOne = async (tag) => {
      const wctx = await browser.newContext()
      const wpage = await wctx.newPage()
      wpage.setDefaultTimeout(30_000)
      let ok = false
      for (let attempt = 1; attempt <= 8 && !ok; attempt++) {
        // Fresh throwaway instance id per attempt so a partial assignRole never skews a reused
        // instance's role_counts.
        await wpage.goto(`${FE}/?_pid=warm-${tag}&_gid=warmup-${GID}-${tag}-${attempt}&_session=tab`)
        ok = await wpage.waitForSelector('p:has-text("Your role")', { timeout: 20_000 }).then(() => true).catch(() => false)
        if (!ok) { log('warmup', `${tag} cold-start attempt ${attempt} not ready — retrying`); await sleep(2000) }
      }
      await wctx.close()
      return ok
    }
    if (!(await warmOne('a'))) throw new Error('warmup never reached "Your role" after retries')
    // Then a small CONCURRENT burst so the emulator spins up several function workers before the
    // real 8 launch (a single warm page only warms one worker; the 8 otherwise cold-start the rest).
    await Promise.all(['b', 'c', 'd'].map(t => warmOne(t)))
    log('warmup', 'stack warm ✅')
  }

  // ── Launch all students; each drives info → (KC auto-skips) → reflection → hold ──
  banner(`Phase 1 — ${PIDS.length} students: info → reflection → hold (single role)`)
  for (const pid of PIDS) {
    const ctx  = await browser.newContext()
    const page = await ctx.newPage()
    page.setDefaultTimeout(60_000)
    students.push({ page, pid })
  }
  // Step 1 — assign roles SEQUENTIALLY (one assignRole transaction at a time → no role_counts
  // lock-timeout contention in the Firestore emulator). Fast: each is a single page load.
  for (const s of students) await ensureOnRolePage(s.page, s.pid)
  // Step 2 — drive the rest (info assert → reflection → hold) CONCURRENTLY: these write
  // per-participant docs only, so there is no shared-doc transaction to contend on.
  await Promise.all(students.map(async s => {
    const r = await driveSetup(s.page, s.pid)
    s.role = r.role
    s.kc   = r.kc
  }))
  const bidderCount = students.filter(s => s.role === 'bidder').length
  assert(bidderCount === PIDS.length,
    `Roles assigned — all ${PIDS.length} students launch as the single role \`bidder\` (got ${bidderCount})`)

  // ── Slice 6 KC: gate seen + passed, all 5 graded rendered, options shuffle per student ──
  assert(students.every(s => s.kc?.sawGate),
    `KC — every student saw the role gate ("What is your role in this auction?") and passed on the first click`)
  assert(students.every(s => s.kc?.staticsSeen === 5),
    `KC — all 5 graded questions rendered + submitted for every student (got [${[...new Set(students.map(s => s.kc?.staticsSeen))].join(',')}])`)
  // Option order shuffles per student (seed = djb2(participantId + ':' + field)): two
  // different students differ on ≥1 of the 5 questions' option orders.
  const kcFlat = s => KC_FIELDS.map(f => (s.kc?.orders?.[f] ?? []).join('|')).join(' || ')
  const sA = students.find(s => s.pid === 'stu-3'), sB = students.find(s => s.pid === 'stu-4')
  assert(sA && sB && kcFlat(sA) !== kcFlat(sB),
    `KC — options shuffle per student: stu-3 and stu-4 see a different option order on ≥1 of the 5 questions`)

  // (4) The ONE shared case PDF must RESOLVE over the frontend origin (not 404 / SPA fallback).
  const pdf = await fetch(`${FE}/role-info/eBay.pdf`)
  const pdfCt = pdf.headers.get('content-type') ?? ''
  assert(pdf.status === 200 && !pdfCt.includes('text/html'),
    `Info doc — the shared /role-info/eBay.pdf resolves as a real file [${pdf.status} ${pdfCt}]`)
  // The removed Part-1 placeholders must be GONE (not lingering as real files).
  for (const gone of ['expert', 'nonexpert']) {
    const g = await fetch(`${FE}/role-info/${gone}.pdf`)
    const gCt = g.headers.get('content-type') ?? ''
    assert(!(g.status === 200 && !gCt.includes('text/html')),
      `Info doc — removed placeholder /role-info/${gone}.pdf no longer resolves as a real file [${g.status} ${gCt}]`)
  }
  const bad   = await fetch(`${FE}/role-info/__nope__.pdf`)
  const badCt = bad.headers.get('content-type') ?? ''
  assert(!(bad.status === 200 && !badCt.includes('text/html')),
    `Info doc — resolve check is real (bogus file does NOT resolve as a real file) [${bad.status} ${badCt}]`)

  // ── (1) Instructor dashboard: loads + roster visible ───────────────────────
  banner('Instructor — dashboard loads, roster visible, Generate Code, Match')
  const dctx = await browser.newContext()
  dash = await dctx.newPage()
  dash.setDefaultTimeout(60_000)
  await dash.goto(dashboardUrl())
  await dash.waitForSelector('h1:has-text("Instructor Dashboard — eBay")', { timeout: 60_000 })
  // Roster shows all participants (their pids/names appear in the roster table).
  const rosterReady = await dash.waitForSelector('table', { timeout: 30_000 }).then(() => true).catch(() => false)
  let rosterNames = 0
  for (const pid of PIDS) if (await dash.locator(`text=${pid}`).count() > 0) rosterNames++
  assert(rosterReady && rosterNames === PIDS.length,
    `Dashboard — roster visible with all ${PIDS.length} participants (found ${rosterNames}/${PIDS.length})`)

  // ── Generate attendance code (dashboard UI), read the value, drive to waiting ──
  await dash.click('button:has-text("Generate Code")')
  let code = null
  for (let i = 0; i < 20 && !code; i++) { code = await readAttendanceCode(); if (!code) await sleep(500) }
  assert(!!code, `Attendance — "Generate Code" produced a code (${code})`)
  // The TRUE NO-SHOW (stu-13) completed KC but does NOT attend — held back here.
  const attendees = students.filter(s => s.pid !== NOSHOW_PID)
  await Promise.all(attendees.map(s => driveToWaiting(s, code)))
  log(NOSHOW_PID, '⊘ TRUE NO-SHOW — completed KC, will NOT attend class')

  // ── (5) Match (dashboard UI) → single-role tiling: 12 attendees → [4,4,4] (spec §2b) ──
  banner('Match — single-role tiling: 12 attendees → [4,4,4] (1 true no-show held back)')
  await dash.waitForSelector('button:has-text("Match Now"):not([disabled])', { timeout: 30_000 })
  await dash.click('button:has-text("Match Now")')
  await pollGroups(gs => gs.length === 3, 30_000)
  const groups0 = await readGroups()
  assert(groups0.length === 3, `Matching — exactly 3 groups formed (got ${groups0.length})`)
  const sizes = groups0.map(g => g.bidders.length).sort((a, b) => a - b)
  assert(JSON.stringify(sizes) === JSON.stringify([4, 4, 4]),
    `Matching — sizes tile to [4,4,4] (12 attendees) (got [${sizes.join(',')}])`)
  const totalPlaced = groups0.reduce((n, g) => n + g.bidders.length, 0)
  assert(totalPlaced === ATTEND_PIDS.length,
    `Matching (R1) — every ATTENDEE placed, no orphans (${totalPlaced}/${ATTEND_PIDS.length})`)
  // vCommon must NOT be on any client-readable group doc.
  assert(groups0.every(g => !g.vCommonOnGroup),
    `Endowment — vCommon is absent from every client-readable group doc (server-only truth)`)

  // Map browser students → their group (+ is_lead) from Firestore truth. WAIT for the
  // async endowment trigger to stamp every matched participant before asserting.
  const parts = await pollParticipants(
    ps => {
      const matched = ps.filter(p => p.group_id)
      return matched.length === ATTEND_PIDS.length && matched.every(p => p.hasEndowment)
    },
    30_000,
  )
  const byPid = Object.fromEntries(parts.map(p => [p.id, p]))

  // The true no-show launched + has a role, but was never matched (never attended).
  assert(byPid[NOSHOW_PID] && byPid[NOSHOW_PID].role === 'bidder' && !byPid[NOSHOW_PID].group_id,
    `Matching — the true no-show ${NOSHOW_PID} has a role but NO group (held out of the match)`)
  const membersOf = gid => students
    .filter(s => byPid[s.pid]?.group_id === gid)
    .map(s => ({ ...s, is_lead: byPid[s.pid].is_lead, role: byPid[s.pid].role }))

  // (R2) Exactly one expert (bidderIndex 1) per group, guaranteed by construction; and
  // every matched student carries their OWN endowment (the client-readable payload).
  const everyoneEndowed = parts.filter(p => p.group_id).every(p => p.hasEndowment && p.bidderIndex >= 1)
  assert(everyoneEndowed,
    `Endowment — every matched student's payload carries their own auction_endowment (bidderIndex)`)
  const oneExpertEach = groups0.every(g => {
    const idx1 = g.bidders.map(pid => byPid[pid]?.bidderIndex).filter(i => i === 1)
    return idx1.length === 1
  })
  assert(oneExpertEach,
    `Endowment (R2) — exactly one expert (bidderIndex 1) per group (${groups0.map(g => g.bidders.map(pid => byPid[pid]?.bidderIndex).sort().join('')).join(' | ')})`)

  // Scenario allocation across the 3 groups (deterministic by sorted group id).
  const gids = groups0.map(g => g.id).sort()
  const happyGid    = gids[0]
  const deadlockGid = gids[1]
  const noDealGid   = gids[2]
  const happyMembers    = membersOf(happyGid)
  const deadlockMembers = membersOf(deadlockGid)
  const noDealMembers   = membersOf(noDealGid)
  const bidderIndexOf   = pid => byPid[pid]?.bidderIndex

  // ══════════════ SLICE 4 — LIVE AUCTION, driven through the REAL bidding UI ══════════════
  // Every student bid below is a real fill-field + click-Place-bid on the student's own
  // browser (the Slice 3 harness poked submitBid directly; those calls are GONE). The
  // instructor Start/Close are the real dashboard buttons.
  banner('Live auction — Start button + STORED duration override (90s, not 600)')

  // 90s: long enough that the (long) detailed bidding regression never races the deadline;
  // this DETAIL group then closes + resolves on its own clock, checked near the end.
  await saveAuctionSettings(dash, 90, 1)
  await dash.goto(dashboardUrl())
  await dash.waitForSelector('h1:has-text("Instructor Dashboard — eBay")', { timeout: 30_000 })
  await dash.waitForSelector(`[data-testid="start-auction-${happyGid}"]`, { timeout: 30_000 })
  await dash.locator(`[data-testid="start-auction-${happyGid}"]`).click()
  const aHappy = await pollAuction(happyGid, a => a?.status === 'open', 15_000)
  assert(aHappy?.status === 'open', `Auction — Start button opens the auction (status=${aHappy?.status})`)
  const span = aHappy ? (aHappy.endsAtMs - aHappy.startedAtMs) : 0
  assert(Math.abs(span - 90_000) <= 3_000,
    `Auction — endsAtMs reflects the STORED duration override 90s, not 600 (span=${span}ms)`)

  // Slice 5: the CLOCK closes the auction — there is NO instructor close control.
  const closeButtons = await dash.locator('[data-testid^="close-auction-"]').count()
  assert(closeButtons === 0, `Auction — NO instructor "Close Auction" control exists on the dashboard (found ${closeButtons})`)

  // Map the happy group's students by bidderIndex (expert = 1). uiBidderIndexOf drives
  // "the student holding index k" — its page shows k's private view.
  const happyByIdx = {}
  for (const m of happyMembers) happyByIdx[byPid[m.pid]?.bidderIndex] = m
  const B1 = happyByIdx[1], B2 = happyByIdx[2], B3 = happyByIdx[3], B4 = happyByIdx[4]
  assert(B1 && B2 && B3 && B4, `Auction UI — happy group has bidders 1..4 to drive (got [${Object.keys(happyByIdx).sort().join(',')}])`)

  // Every happy student's browser flips from group-reveal to the live bidding screen.
  banner('Live auction UI — every student reaches the bidding screen; clock counts down')
  const reached = await Promise.all(happyMembers.map(m => waitAuctionScreen(m.page).then(() => true).catch(() => false)))
  assert(reached.every(Boolean), `Auction UI — all ${happyMembers.length} students reach the live bidding screen after Start`)

  // Clock counts down from the STORED 60s (cosmetic, server-clock offset). Read it twice.
  const clock0 = await B1.page.locator('[data-testid="auction-clock"]').innerText()
  await sleep(1500)
  const clock1 = await B1.page.locator('[data-testid="auction-clock"]').innerText()
  const toSecs = t => { const [m, s] = t.split(':').map(Number); return m * 60 + s }
  const s0 = toSecs(clock0), s1 = toSecs(clock1)
  assert(Number.isFinite(s0) && Number.isFinite(s1) && s1 < s0 && s0 >= 1 && s0 <= 90,
    `Auction UI — clock counts DOWN from the 90s server deadline (${clock0} → ${clock1})`)

  // ── Private-info panel per role + the CROWN JEWEL: no non-expert ever sees 2650 ──
  banner('Live auction UI — private-info panel per role; NO non-expert sees the expert value (2650)')
  const expertBody = await bodyText(B1.page)
  assert(/expert/i.test(expertBody) && expertBody.includes('$2,650') && /exactly/i.test(expertBody),
    `Auction UI — the EXPERT (bidder 1) sees "$2,650 … exactly" in their private info`)

  // SCOPED TO THE PRE-CLOSE BIDDING SCREEN (Slice 5 note): a non-expert may legitimately
  // see 2650 ONLY after close, on the reveal. Here, on the live bidding screen, each
  // non-expert sees their OWN signal + the ±1000 statement + their own use value, and NO
  // "2650" in any form. (Skip index 5, whose OWN signal is legitimately 2650 — the leak we
  // guard against is the EXPERT's exact value reaching someone whose own signal is not 2650.)
  let noLeak = true, leakWho = ''
  for (const idx of [2, 3, 4]) {
    const m = happyByIdx[idx]; if (!m) continue
    const t = await bodyText(m.page)
    const ownOk = t.includes(dollars(EBAY_SIGNAL[idx])) && t.includes('$1,000') && t.includes(dollars(EBAY_USE[idx]))
    const clean = !t.includes('2650') && !t.includes('2,650')
    if (!ownOk || !clean) { noLeak = false; leakWho = `bidder ${idx} (ownOk=${ownOk}, clean=${clean})` }
  }
  assert(noLeak, `Auction UI (PRE-CLOSE) — every non-expert sees their OWN signal + ±$1,000 + own use value, and NEVER 2650 before close ${leakWho}`)

  // ── Status line + one-row-per-bid history + no losing max + personal messages ──
  banner('Live auction UI — sequential bids: status flips, history rows, no-leak (109/110), messages')

  // Pre-bid: nobody is winning; the status says so plainly.
  const pre = await B1.page.locator('[data-testid="auction-status"]').getAttribute('data-winning')
  assert(pre === 'none', `Auction UI — before any bid the status is "No bids yet" (data-winning=${pre})`)

  // Bid 1 — expert bids 109 (first bid sits at the $0 starting price; expert now leads).
  await uiBid(B1.page, 109)
  await pollAuction(happyGid, a => a?.highBidderIndex === 1, 10_000)
  await B1.page.waitForSelector('[data-testid="auction-status"][data-winning="true"]', { timeout: 10_000 })
  await B2.page.waitForSelector('[data-testid="auction-status"][data-winning="false"]', { timeout: 10_000 })
  assert(true, `Auction UI — status flips: bidder 1 "WINNING", bidder 2 "NOT WINNING" after the first bid`)
  assert((await historyRows(B1.page)) === 1, `Auction UI — one row after 1 submitted bid`)

  // Bid 2 — bidder 2 bids 150 → overtakes at $110 (= 109 + increment). The LOSING max
  // 109 must never render; bidder 1 gets the honest "at least $109" outbid sentence.
  await uiBid(B2.page, 150)
  await pollAuction(happyGid, a => a?.currentAmount === 110 && a?.highBidderIndex === 2, 10_000)
  await B2.page.waitForSelector('[data-testid="auction-status"][data-winning="true"]', { timeout: 10_000 })
  // 109 (bidder 1's exhausted max) appears NOWHERE on any OTHER bidder's screen.
  let no109 = true
  for (const m of [B2, B3, B4]) if ((await bodyText(m.page)).includes('109')) no109 = false
  assert(no109, `Auction UI — the losing max 109 renders NOWHERE (only the $110 price shows) — the old two-row leak is gone`)
  // The personal outbid message on bidder 1's screen, with the lower-bound wording.
  await B1.page.waitForSelector('[data-testid="auction-message"][data-kind="outbid"]', { timeout: 10_000 })
  const outbidTxt = await B1.page.locator('[data-testid="auction-message"]').innerText()
  assert(/outbid/i.test(outbidTxt) && outbidTxt.includes('Bidder 2') && outbidTxt.includes('$110') && outbidTxt.includes('at least $109'),
    `Auction UI — outbid message names the leader + price + honest lower bound ("${outbidTxt.replace(/\s+/g, ' ').trim()}")`)
  assert((await historyRows(B1.page)) === 2, `Auction UI — two rows after 2 submitted bids`)

  // Bid 3 — bidder 3 bids 130 (below bidder 2's max 150) → incumbent holds, proxy raises
  // to $131. Bidder 2 sees the "defended" message; three bids → three rows.
  await uiBid(B3.page, 130)
  await pollAuction(happyGid, a => a?.currentAmount === 131 && a?.highBidderIndex === 2, 10_000)
  await B2.page.waitForSelector('[data-testid="auction-message"][data-kind="defended"]', { timeout: 10_000 })
  const defTxt = await B2.page.locator('[data-testid="auction-message"]').innerText()
  assert(defTxt.includes('$131') && /still winning/i.test(defTxt),
    `Auction UI — "defended" message: proxy raised your bid to $131, still winning ("${defTxt.replace(/\s+/g, ' ').trim()}")`)
  assert((await historyRows(B2.page)) === 3, `Auction UI — exactly 3 rows after 3 submitted bids (one row per bid, no cascade)`)

  // Raise-only — bidder 3 tries 130 again (≤ own previous max) → rejected with a clear message.
  await uiBid(B3.page, 130)
  await B3.page.waitForSelector('[data-testid="auction-error"]', { timeout: 10_000 })
  const rrErr = await B3.page.locator('[data-testid="auction-error"]').innerText()
  assert(/higher than your previous/i.test(rrErr),
    `Auction UI — raise-only: a bid ≤ your own previous max is rejected ("${rrErr.replace(/\s+/g, ' ').trim()}")`)
  assert((await historyRows(B3.page)) === 3, `Auction UI — the rejected raise adds NO history row (still 3)`)

  // Fat-finger — bidder 4 fat-fingers 26500 (>2× current AND ≥ $10,000) → confirmation
  // fires; Cancel does NOT submit and keeps the typed value intact.
  banner('Live auction UI — fat-finger guard: >2× current & ≥$10,000 → confirm; Cancel does not submit')
  await B4.page.locator('[data-testid="auction-max-input"]').fill('26500')
  await B4.page.locator('[data-testid="auction-place-bid"]').click()
  await B4.page.waitForSelector('[data-testid="auction-confirm-dialog"]', { timeout: 8_000 })
  const dlgTxt = await B4.page.locator('[data-testid="auction-confirm-dialog"]').innerText()
  assert(dlgTxt.includes('26,500') && /binding/i.test(dlgTxt),
    `Auction UI — fat-finger confirmation shows the $26,500 amount + "binding" warning`)
  await B4.page.locator('[data-testid="auction-confirm-cancel"]').click()
  await B4.page.waitForSelector('[data-testid="auction-confirm-dialog"]', { state: 'detached', timeout: 8_000 })
  const b4Val = await B4.page.locator('[data-testid="auction-max-input"]').inputValue()
  const afterCancel = await readAuction(happyGid)
  assert(b4Val === '26500' && afterCancel?.currentAmount === 131 && (await historyRows(B4.page)) === 3,
    `Auction UI — Cancel does NOT submit: price stays $131, no new row, field keeps 26500`)

  // ── Concurrency THROUGH THE UI: 4 simultaneous real clicks settle on one price ──
  banner('Live auction UI — 4 simultaneous UI bids → exact proxy price 3001, no lost updates')
  const CMAXES = [1000, 2000, 3000, 5000]      // all < $10,000 floor → no fat-finger dialog
  await Promise.all([uiBid(B1.page, 1000), uiBid(B2.page, 2000), uiBid(B3.page, 3000), uiBid(B4.page, 5000)])
  const aConc = await pollAuction(happyGid, a => a?.currentAmount === 3001, 20_000)
  assert(aConc?.currentAmount === 3001,
    `Auction concurrency (UI) — 4 simultaneous bids settle at the exact proxy price 3001 (got ${aConc?.currentAmount})`)
  assert(aConc?.highBidderIndex === 4,
    `Auction concurrency (UI) — high bidder is the top-max bidder (index 4), no lost update (got ${aConc?.highBidderIndex})`)

  // No confidential max — neither the concurrency maxes nor the sequential ones — appears
  // anywhere in the RTDB subtree the client can read.
  const FORBIDDEN = new Set([1000, 2000, 3000, 5000, 109, 150, 130])
  const leaked = numericLeaves(await readAuction(happyGid)).filter(v => FORBIDDEN.has(v))
  assert(leaked.length === 0,
    `Auction — NO confidential max appears anywhere under auctions/${happyGid} (leaked: [${leaked.join(',')}])`)

  // NO close button — the DETAIL group's auction stays OPEN and the CLOCK will close +
  // resolve it (checked near the end, by which time its 60s deadline has passed).

  // ══════════════════ SLICE 5 — CLOSE ON DEADLINE → RESOLVE → FULL REVEAL ══════════════════

  // ── CONFORMANCE case 3, END TO END through the real UI (THE key Part-3 assertion) ──
  // Real UI bids 2000 / 2100 / 2900 / 3300 → Bidder 4 wins at $2,901, profit −$151.
  banner('Slice 5 — CONFORMANCE case 3 end-to-end: real UI bids → deadline → resolve → results')
  const confGid = deadlockGid
  const confMembers = membersOf(confGid)
  const confByIdx = {}
  for (const m of confMembers) confByIdx[byPid[m.pid]?.bidderIndex] = m
  const C1 = confByIdx[1], C2 = confByIdx[2], C3 = confByIdx[3], C4 = confByIdx[4]
  assert(C1 && C2 && C3 && C4, `Conformance — group has bidders 1..4 to drive (got [${Object.keys(confByIdx).sort().join(',')}])`)

  await saveAuctionSettings(dash, 25, 1)                       // 25s: room to place 4 UI bids, then expire
  await dash.goto(dashboardUrl())
  await dash.waitForSelector(`[data-testid="start-auction-${confGid}"]`, { timeout: 30_000 })
  await dash.locator(`[data-testid="start-auction-${confGid}"]`).click()
  await pollAuction(confGid, a => a?.status === 'open', 15_000)
  await Promise.all(confMembers.map(m => waitAuctionScreen(m.page)))

  // Sequential bids (each registers before the next → all four maxes are stored).
  await uiBid(C1.page, 2000); await pollAuction(confGid, a => a?.highBidderIndex === 1, 10_000)
  await uiBid(C2.page, 2100); await pollAuction(confGid, a => a?.currentAmount === 2001, 10_000)
  await uiBid(C3.page, 2900); await pollAuction(confGid, a => a?.currentAmount === 2101, 10_000)
  await uiBid(C4.page, 3300); await pollAuction(confGid, a => a?.currentAmount === 2901 && a?.highBidderIndex === 4, 10_000)

  // Let the CLOCK expire — nobody clicks close. Every student lands on the reveal.
  banner('Conformance — clock expires → deadline close → all students land on results')
  const confReached = await Promise.all(confMembers.map(m => waitResults(m.page, 40_000).then(() => true).catch(() => false)))
  assert(confReached.every(Boolean), `Conformance — all ${confMembers.length} students land on the results screen via the DEADLINE close (real UI)`)

  // THE assertion: winner Bidder 4, clearing $2,901, winner profit −$151.
  const cWinner = await dataAttr(C4.page, 'results-headline', 'data-winner')
  const cClear  = await dataAttr(C4.page, 'results-headline', 'data-clearing')
  const cProfit = await dataAttr(C4.page, 'results-my-profit', 'data-profit')
  assert(cWinner === '4' && cClear === '2901' && cProfit === '-151',
    `Conformance E2E (real UI → callable → RTDB → proxy → resolver → results): winner Bidder ${cWinner}, clearing $${cClear}, winner profit ${cProfit} (expect 4 / 2901 / −151)`)
  // The NEGATIVE profit is rendered unmistakably (a real minus sign) on the winner's screen.
  assert((await bodyText(C4.page)).includes('−$151'),
    `Conformance — the winner's NEGATIVE profit −$151 is shown unmistakably (the winner's curse lands)`)

  // The REVEAL: every student now sees the true value 2650 (the FIRST legit 2650 for non-experts).
  const revealOk = await Promise.all(confMembers.map(async m => (await dataAttr(m.page, 'results-reveal', 'data-true-value')) === '2650'))
  assert(revealOk.every(Boolean), `Conformance — the REVEAL shows the true resale value $2,650 on EVERY student's results screen`)

  // ALL maxes visible in the reveal table.
  const cRows = await readResultRows(C1.page)
  const maxOf = i => cRows.find(r => r.bidder === i)?.max
  assert(maxOf(1) === '2000' && maxOf(2) === '2100' && maxOf(3) === '2900' && maxOf(4) === '3300',
    `Conformance — ALL maxes visible at close: [${cRows.map(r => `${r.bidder}:${r.max}`).join(' ')}]`)

  // ── IDEMPOTENCY: repeat/concurrent close triggers → exactly ONE resolution ──
  banner('Slice 5 — idempotency: concurrent close triggers → one resolution, one winner, one price')
  const stored1 = await pollStoredResult(C1.pid)
  await Promise.all([checkCloseFn(C1.pid, confGid), checkCloseFn(C2.pid, confGid)])
  const stored2 = await readStoredResult(C1.pid)
  assert(stored1 && stored2 && stored1.resolvedAtMs === stored2.resolvedAtMs && stored2.winner === 4 && stored2.clearing === 2901,
    `Idempotency — repeat close triggers do NOT re-resolve: one resolvedAt (${stored1?.resolvedAtMs}===${stored2?.resolvedAtMs}), one winner (4), one price (2901)`)

  // ── ADVERSARIAL / SECURITY (5d): a post-deadline submitBid, BYPASSING THE UI, is
  // server-REJECTED and never enters the resolution. Do NOT convert this to a UI click —
  // a sniper with a browser console does not use the button; this proves the SERVER guard. ──
  banner('Slice 5 — ADVERSARIAL sniping: a direct post-deadline submitBid is server-REJECTED')
  const nodeBefore = await readAuction(confGid)
  const snipe = await submitBidFn(C2.pid, confGid, 99999)     // legit member, huge max, AFTER the deadline
  assert(!snipe.ok, `ADVERSARIAL — the SERVER rejects a direct post-deadline bid (status=${snipe.status})`)
  const nodeAfter = await readAuction(confGid)
  assert(nodeAfter?.currentAmount === nodeBefore?.currentAmount && nodeAfter?.highBidderIndex === nodeBefore?.highBidderIndex,
    `ADVERSARIAL — the rejected late bid did NOT alter currentAmount/highBidderIndex (${nodeAfter?.currentAmount}/${nodeAfter?.highBidderIndex})`)
  const storedAdv = await readStoredResult(C1.pid)
  assert(storedAdv?.winner === 4 && storedAdv?.clearing === 2901 && storedAdv?.perBidder.find(b => b.bidderIndex === 2)?.maxAmount === 2100,
    `ADVERSARIAL — the late bid does NOT enter the resolution (winner 4, price 2901, bidder 2 max still 2100, not 99999)`)

  // ── NO-SALE + "NOBODY WATCHING": the deadline passes with no active client, then a
  // student loads the page and STILL sees results (not a dead clock). ──
  banner('Slice 5 — NO-SALE + nobody-watching: deadline passes unobserved → late load → resolve → results')
  const nsGid = noDealGid
  const nsMembers = membersOf(nsGid)

  // Guard (kept): an auction cannot start while a member is un-endowed. Null one, assert
  // Start is rejected, restore verbatim — BEFORE opening the no-sale auction.
  const guardPid = nsMembers[0].pid
  const guardRaw = (await fsGetDoc(`participants/${guardPid}`))?.fields?.auction_endowment ?? null
  await patchEndowment(guardPid, null)
  const guardRes = await startAuctionFn(nsGid)
  assert(!guardRes.ok, `Auction guard — startAuction REJECTED while a member lacks an endowment (status=${guardRes.status})`)
  assert((await readAuction(nsGid)) == null, `Auction guard — no auction node created for the un-ready group`)
  await patchEndowment(guardPid, guardRaw)

  await saveAuctionSettings(dash, 10, 1)                       // 10s auction, nobody will bid
  await dash.goto(dashboardUrl())
  await dash.waitForSelector(`[data-testid="start-auction-${nsGid}"]`, { timeout: 30_000 })
  await dash.locator(`[data-testid="start-auction-${nsGid}"]`).click()
  await pollAuction(nsGid, a => a?.status === 'open', 15_000)
  await Promise.all(nsMembers.map(m => waitAuctionScreen(m.page).catch(() => {})))

  // Nobody bids. Navigate EVERY member's page AWAY so NO client observes the deadline.
  await Promise.all(nsMembers.map(m => m.page.goto('about:blank').catch(() => {})))
  await sleep(11_000)   // the SERVER deadline passes while the node is still 'open', unobserved
  assert((await readAuction(nsGid))?.status === 'open' && (await readStoredResult(nsMembers[0].pid)) == null,
    `Nobody-watching — the deadline passed but NOTHING resolved it (no scheduled fn, no observer)`)

  // A student loads the page LATE → the client observes the passed deadline → resolves.
  const ns0 = nsMembers[0]
  await ns0.page.goto(studentUrl(ns0.pid))
  await waitResults(ns0.page, 40_000)
  const nsWinner = await dataAttr(ns0.page, 'results-headline', 'data-winner')
  const nsReveal = await dataAttr(ns0.page, 'results-reveal', 'data-true-value')
  const nsBody = await bodyText(ns0.page)
  assert(nsWinner === '' && nsReveal === '2650' && !/NaN|Bidder null|undefined/.test(nsBody),
    `Nobody-watching / NO-SALE — a LATE page load resolves + renders the no-sale reveal gracefully (winner=∅, true value 2650, no NaN/"Bidder null")`)

  // ── DETAIL group: the CLOCK closes+resolves it too. Wait out its (longer) deadline,
  // then confirm resolution. (Deadline-close via the client is already proven by the
  // conformance group; here we just wait out the 90s clock and belt-and-suspenders the
  // trigger against headless background-timer throttling.) ──
  banner('Slice 5 — the DETAIL group closes + resolves on its deadline too')
  const detailEnds = aHappy.endsAtMs
  while (Date.now() <= detailEnds + 1000) await sleep(1000)   // wait out the 90s deadline
  await checkCloseFn(B1.pid, happyGid).catch(() => {})        // ensure resolution past the deadline
  const detailStored = await pollStoredResult(B1.pid, 30_000)
  await waitResults(B1.page, 30_000)
  const dReveal = await dataAttr(B1.page, 'results-reveal', 'data-true-value')
  assert(detailStored && detailStored.winner === 4 && detailStored.clearing === 3001 && dReveal === '2650',
    `DETAIL — resolved on the clock: winner ${detailStored?.winner}, clearing ${detailStored?.clearing} (concurrency maxes), reveal ${dReveal} (expect 4 / 3001 / 2650)`)

  // ══════════════════ SLICE 6 — PARTICIPATION + KC GRADING → GRADEBOOK PUSH ══════════════════
  // Grading is PARTICIPATION + KC only (spec §7). PROFIT IS NEVER GRADED: every present
  // bidder gets the SAME flat raw_score → degenerate single-role pool → normalized 0. The
  // true no-show → raw null / z −2. KC score (0–1) rides as its own gradebook field.
  banner('Finalize — Score & Record → participation+KC grading → grade push (POST + 200)')
  await dash.click('button:has-text("Score & Record")')
  const isResult = r => r.result && typeof r.result === 'object' && typeof r.result.participant_id === 'string'
  const start = Date.now()
  while (mock.received.filter(isResult).length < PIDS.length && Date.now() - start < 30_000) await sleep(500)
  const pushed = mock.received.filter(isResult)
  log('push', `mock received ${mock.received.length} request(s); ${pushed.length} are GameResult POSTs`)
  assert(pushed.length >= PIDS.length,
    `Grade push — the classroom callback received ${pushed.length} GameResult POSTs (one per participant; push fired)`)
  assert(pushed.length > 0 && pushed.every(r => typeof r.result.normalized_score === 'number' || r.result.normalized_score === null),
    `Grade push — every pushed GameResult carries a normalized_score field`)
  assert(pushed.length > 0 && pushed.every(r => typeof r.auth === 'string' && r.auth.startsWith('Bearer ')),
    `Grade push — every push is authenticated with the callback Bearer secret`)

  const pushedById  = Object.fromEntries(pushed.map(r => [r.result.participant_id, r.result]))
  const pushedPids  = new Set(pushed.map(r => r.result.participant_id))

  // NOBODY DROPPED — every one of the 13 (winners, losers, silent bidders, the no-show).
  assert(PIDS.every(p => pushedPids.has(p)) && pushedPids.size === PIDS.length,
    `Grade push — EVERY participant lands in the payload, nobody dropped: ${pushedPids.size}/${PIDS.length} (incl. the no-show)`)

  // knowledge_check_score rides as its OWN 0–1 field — a REAL varying number now.
  assert(pushed.every(r => r.result.knowledge_check_score === null ||
      (typeof r.result.knowledge_check_score === 'number' && r.result.knowledge_check_score >= 0 && r.result.knowledge_check_score <= 1)),
    `Grade push — knowledge_check_score rides as its own 0–1 field on every record`)
  assert(pushedById[KC_THREE_PID]?.knowledge_check_score === 0.6 && pushedById[KC_ZERO_PID]?.knowledge_check_score === 0,
    `Grade push — the real KC values reach the gradebook (3/5 → 0.6, 0/5 → 0) [got ${pushedById[KC_THREE_PID]?.knowledge_check_score} / ${pushedById[KC_ZERO_PID]?.knowledge_check_score}]`)

  // PROFIT IS NOT IN THE PAYLOAD in ANY form — not scored, not metadata.
  const profitLeak = pushed.find(r => {
    const res = r.result
    if ('profit' in res || 'auction_result' in res || 'raw_score' in res) return true
    return Object.keys(res.details ?? {}).length !== 0
  })
  assert(!profitLeak,
    `Grade push — PROFIT is NOT in the payload (no profit/auction_result/raw_score field; details empty) — profit never graded`)

  // ── Participation: every PRESENT student has the IDENTICAL flat raw_score → z 0 ──
  const partsFinal  = await readParticipants()
  const byPidFinal  = Object.fromEntries(partsFinal.map(p => [p.id, p]))
  const present     = partsFinal.filter(p => p.group_id)          // the 12 matched
  const nsParts     = partsFinal.filter(p => p.group_id === nsGid)
  const noShow      = byPidFinal[NOSHOW_PID]

  const rawSet = new Set(present.map(p => p.raw_score))
  assert(present.length === ATTEND_PIDS.length && rawSet.size === 1 && [...rawSet][0] === 1,
    `Scoring — every present student has the IDENTICAL flat participation raw_score (=1), profit-independent [${[...rawSet].join(',')}]`)
  assert(present.every(p => p.normalized_score === 0),
    `Scoring — degenerate single-role pool: every present student normalizes to 0 (SD=0 guard) [${[...new Set(present.map(p => p.normalized_score))].join(',')}]`)

  // ── THE key assertion: PROFIT has ZERO effect on the participation grade ──
  // In the conformance group C4 WON at a LOSS (game-profit −$151) while C1–C3 lost
  // (game-profit $0). Their participation raw + normalized are IDENTICAL.
  const winRes       = await readStoredResult(C4.pid)
  const winnerProfit = winRes?.perBidder.find(b => b.bidderIndex === 4)?.profit
  const loserProfit  = winRes?.perBidder.find(b => b.bidderIndex === 1)?.profit
  const wF = byPidFinal[C4.pid], lF = byPidFinal[C1.pid]
  assert(winnerProfit === -151 && loserProfit === 0 &&
         wF && lF && wF.raw_score === lF.raw_score && wF.normalized_score === lF.normalized_score,
    `Scoring — PROFIT NOT GRADED: the CURSED winner (profit ${winnerProfit}) and a LOSING bidder (profit ${loserProfit}) get the SAME participation raw (${wF?.raw_score}=${lF?.raw_score}) + normalized (${wF?.normalized_score}=${lF?.normalized_score})`)

  // ── GRADING TRAP: silent bidders (attended, reached the auction, NEVER bid) are PRESENT ──
  assert(nsParts.length === nsMembers.length && nsParts.every(p => p.raw_score === 1),
    `Scoring TRAP — silent bidders (present, no bid) score the participation point (raw 1), NOT the no-show −2 [${nsParts.map(p => p.raw_score).join(',')}]`)
  assert(nsParts.every(p => p.normalized_score === 0),
    `Scoring TRAP — silent bidders get a PRESENT z-score (0), never −2 [${nsParts.map(p => p.normalized_score).join(',')}]`)

  // ── The TRUE no-show: never attended → raw null, z −2, EXCLUDED from the pool ──
  assert(noShow && noShow.raw_score == null && noShow.normalized_score === -2,
    `Scoring — the TRUE no-show ${NOSHOW_PID} (never attended): raw_score null, normalized_score −2, EXCLUDED [raw=${noShow?.raw_score}, z=${noShow?.normalized_score}]`)
  assert(pushedById[NOSHOW_PID]?.normalized_score === -2 && pushedById[NOSHOW_PID]?.status === 'no_show',
    `Grade push — the true no-show is delivered with normalized_score −2 / status no_show`)

  // ── KC scores land per spec (denominator 5): 3/5 → 0.6, 0/5 → 0, all-correct → 1.0 ──
  const kcOf = pid => byPidFinal[pid]?.knowledge_check_score
  assert(kcOf(KC_THREE_PID) === 0.6,
    `KC score — the 3-of-5 student ${KC_THREE_PID} finalizes with knowledge_check_score 0.6 (got ${kcOf(KC_THREE_PID)})`)
  assert(kcOf(KC_ZERO_PID) === 0,
    `KC score — the all-wrong student ${KC_ZERO_PID} STILL finalizes, score 0 (a wrong answer never blocks progress) (got ${kcOf(KC_ZERO_PID)})`)
  assert(kcOf('stu-3') === 1,
    `KC score — an all-correct student (stu-3) finalizes with score 1.0 (got ${kcOf('stu-3')})`)
  assert(kcOf(NOSHOW_PID) === 1,
    `KC score — the no-show completed KC before leaving: score 1.0 still rides to the gradebook (got ${kcOf(NOSHOW_PID)})`)

  // ── (9) REPORTS page — renders for a RESOLVED auction (never exercised before) ──
  banner('Reports — instructor Reports page loads for a resolved auction (KC column, no negotiation-era crash)')
  await dash.goto(`${FE}/reports?_dev_game_instance_id=${encodeURIComponent(GID)}&_session=tab`)
  await dash.waitForSelector('h2:has-text("Reports — eBay")', { timeout: 30_000 })
  // Wait for getReportData to load — the tile enables + shows "N participants finalized"
  // (until then the tile card is disabled and clicking it is a no-op).
  await dash.waitForSelector('text=participants finalized', { timeout: 20_000 })
  // Open the "Contract Outcomes" tile (a clickable card div, not a button).
  await dash.getByText('Contract Outcomes — per participant', { exact: true }).first().click()
  await dash.waitForSelector('table', { timeout: 15_000 })
  const reportBody = await dash.locator('body').innerText()
  const kcTexts    = await dash.locator('[data-testid="report-kc"]').allInnerTexts()
  assert(/KC score/.test(reportBody) && kcTexts.length === ATTEND_PIDS.length,
    `Reports — the page renders a per-participant table with a KC-score column for all ${ATTEND_PIDS.length} present students (got ${kcTexts.length})`)
  assert(kcTexts.some(t => t.includes('3 / 5')) && kcTexts.some(t => t.includes('0 / 5')) && kcTexts.some(t => t.includes('5 / 5')),
    `Reports — the KC column shows the real varying scores (3/5, 0/5, 5/5) [${[...new Set(kcTexts)].join(', ')}]`)
  assert(!/NaN|undefined|Bidder null/.test(reportBody),
    `Reports — no NaN / undefined / negotiation-era leftovers for a resolved auction`)
}

// ── Entry point ─────────────────────────────────────────────────────────────────

;(async () => {
  try {
    await main()
  } catch (err) {
    FAIL++
    console.error('\n✗ FATAL:', err?.message ?? err)
    try { await dumpDiagnostics('fatal error') } catch { /* best effort */ }
  } finally {
    // Print the summary FIRST so it always lands in the log, even if teardown misbehaves.
    banner(`RESULT — ${PASS}/${PASS + FAIL} green${FAIL ? `  (${FAIL} FAILED)` : ''}`)
    await new Promise(res => setTimeout(res, 150))  // flush stdout to a redirected log
    if (browser) { try { await browser.close() } catch { /* */ } }
    tearDownStack()
    process.exit(FAIL ? 1 : 0)
  }
})()
