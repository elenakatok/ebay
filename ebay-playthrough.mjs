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
 *   3. KC has NO role gate: the KnowledgeCheck UI auto-skips to the reflection.
 *   4. Info-document phase: the role sheet link is present AND resolves (shared eBay.pdf).
 *   5. Matching: 13 → [5,4,4] — R1 all placed, 4→5 flex, R2 exactly one expert
 *      (bidderIndex 1) per group, each student's payload carries their own endowment,
 *      and vCommon is absent from every client-readable group doc.
 *   6. Outcome: a `price` deal is accepted + persisted (schema-valid).
 *   7. Deadlock override: the dashboard control submits { price } (NOT { placeholder }) —
 *      locks in the Part-1 fix of the latent Hawks-scaffold bug.
 *   8. No-deal walk-away: present-but-no-bid students score raw 0 (present), NOT −2.
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
 *  10. Finalize: Score & Record → stub scoring runs → real grade push fires (POST + 200).
 *
 * REMOVED vs the 2-role baseline (obsolete under single role): the "2 expert + 6
 * nonexpert" role-count assertion, the KC role-gate assertion, and the KC graded-MC
 * "✓ Correct" assertion (there is no gate and no graded MC anymore).
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
// 13 students → single-role matching tiles to [5,4,4] (spec §2b): a flex group of 5
// plus two of 4 — enough to exercise happy-deal + deadlock-override + no-deal (the
// present-but-no-bid case) in one run, and to prove the 4→5 flex places everyone.
const PIDS = Array.from({ length: 13 }, (_, i) => `stu-${i + 1}`)

// Placeholder prices: happy-path group vs deadlock-override group.
const HAPPY_PRICE    = 500
const DEADLOCK_PRICE = 777

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

  // KC has NO role gate now (single-role move). The shared KnowledgeCheck UI, finding
  // no gate question, auto-completes and advances straight to the reflection — there is
  // no gate screen and no graded MC to drive. Reflection (ungraded free text) only.
  await page.waitForSelector('p:has-text("Preparation — 1 of 1")', { timeout: 30_000 })
  await page.locator('textarea').fill(`Bidder plan: bid to my value, avoid the winner's curse.`)
  await page.click('button:has-text("Complete")')

  await page.waitForSelector('h1:has-text("Preparation complete")', { timeout: 30_000 })
  log(pid, '◆ hold screen')
  return { page, pid, role: 'bidder' }
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
  }))
  const bidderCount = students.filter(s => s.role === 'bidder').length
  assert(bidderCount === PIDS.length,
    `Roles assigned — all ${PIDS.length} students launch as the single role \`bidder\` (got ${bidderCount})`)

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
  await Promise.all(students.map(s => driveToWaiting(s, code)))

  // ── (5) Match (dashboard UI) → single-role tiling: 13 → [5,4,4] (spec §2b) ──
  banner('Match — single-role tiling: 13 students → [5,4,4] (4→5 flex, all placed)')
  await dash.waitForSelector('button:has-text("Match Now"):not([disabled])', { timeout: 30_000 })
  await dash.click('button:has-text("Match Now")')
  await pollGroups(gs => gs.length === 3, 30_000)
  const groups0 = await readGroups()
  assert(groups0.length === 3, `Matching — exactly 3 groups formed (got ${groups0.length})`)
  const sizes = groups0.map(g => g.bidders.length).sort((a, b) => a - b)
  assert(JSON.stringify(sizes) === JSON.stringify([4, 4, 5]),
    `Matching — sizes tile to [4,4,5] (4→5 flex) (got [${sizes.join(',')}])`)
  const totalPlaced = groups0.reduce((n, g) => n + g.bidders.length, 0)
  assert(totalPlaced === PIDS.length,
    `Matching (R1) — every student placed, no orphans (${totalPlaced}/${PIDS.length})`)
  // vCommon must NOT be on any client-readable group doc.
  assert(groups0.every(g => !g.vCommonOnGroup),
    `Endowment — vCommon is absent from every client-readable group doc (server-only truth)`)

  // Map browser students → their group (+ is_lead) from Firestore truth. WAIT for the
  // async endowment trigger to stamp every matched participant before asserting.
  const parts = await pollParticipants(
    ps => {
      const matched = ps.filter(p => p.group_id)
      return matched.length === PIDS.length && matched.every(p => p.hasEndowment)
    },
    30_000,
  )
  const byPid = Object.fromEntries(parts.map(p => [p.id, p]))
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
  banner('Live auction — Start button + STORED duration override (60s, not 600)')

  await saveAuctionSettings(dash, 60, 1)
  await dash.goto(dashboardUrl())
  await dash.waitForSelector('h1:has-text("Instructor Dashboard — eBay")', { timeout: 30_000 })
  await dash.waitForSelector(`[data-testid="start-auction-${happyGid}"]`, { timeout: 30_000 })
  await dash.locator(`[data-testid="start-auction-${happyGid}"]`).click()
  const aHappy = await pollAuction(happyGid, a => a?.status === 'open', 15_000)
  assert(aHappy?.status === 'open', `Auction — Start button opens the auction (status=${aHappy?.status})`)
  const span = aHappy ? (aHappy.endsAtMs - aHappy.startedAtMs) : 0
  assert(Math.abs(span - 60_000) <= 3_000,
    `Auction — endsAtMs reflects the STORED duration override 60s, not 600 (span=${span}ms)`)

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
  assert(Number.isFinite(s0) && Number.isFinite(s1) && s1 < s0 && s0 >= 1 && s0 <= 60,
    `Auction UI — clock counts DOWN from the 60s server deadline (${clock0} → ${clock1})`)

  // ── Private-info panel per role + the CROWN JEWEL: no non-expert ever sees 2650 ──
  banner('Live auction UI — private-info panel per role; NO non-expert sees the expert value (2650)')
  const expertBody = await bodyText(B1.page)
  assert(/expert/i.test(expertBody) && expertBody.includes('$2,650') && /exactly/i.test(expertBody),
    `Auction UI — the EXPERT (bidder 1) sees "$2,650 … exactly" in their private info`)

  // Each non-expert sees their OWN signal + the ±1000 statement + their own use value,
  // and their DOM contains NO "2650" in any form. (Skip index 5, whose OWN signal is
  // legitimately 2650 — the leak we guard against is the EXPERT's exact value reaching
  // someone whose own signal is not 2650.)
  let noLeak = true, leakWho = ''
  for (const idx of [2, 3, 4]) {
    const m = happyByIdx[idx]; if (!m) continue
    const t = await bodyText(m.page)
    const ownOk = t.includes(dollars(EBAY_SIGNAL[idx])) && t.includes('$1,000') && t.includes(dollars(EBAY_USE[idx]))
    const clean = !t.includes('2650') && !t.includes('2,650')
    if (!ownOk || !clean) { noLeak = false; leakWho = `bidder ${idx} (ownOk=${ownOk}, clean=${clean})` }
  }
  assert(noLeak, `Auction UI — every non-expert sees their OWN signal + ±$1,000 + own use value, and NEVER 2650 ${leakWho}`)

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

  // Close the happy auction via the real button → students fall back to normal routing.
  await dash.locator(`[data-testid="close-auction-${happyGid}"]`).click()
  const aClosed = await pollAuction(happyGid, a => a?.status === 'closed', 10_000)
  assert(aClosed?.status === 'closed', `Auction — Close button closes the auction (status=${aClosed?.status})`)

  // ── Guard: an auction cannot start while any member is un-endowed (server, via the
  // Start button). Null one noDeal member's endowment, click Start, assert rejection. ──
  banner('Live auction — startAuction guard (no start before endowments land)')
  const guardPid = noDealMembers[0].pid
  const guardRaw = (await fsGetDoc(`participants/${guardPid}`))?.fields?.auction_endowment ?? null
  await patchEndowment(guardPid, null)
  const guardRes = await startAuctionFn(noDealGid)
  assert(!guardRes.ok, `Auction guard — startAuction REJECTED while a member lacks an endowment (status=${guardRes.status})`)
  assert((await readAuction(noDealGid)) == null, `Auction guard — no auction node created for the un-ready group`)
  await patchEndowment(guardPid, guardRaw)   // restore verbatim

  // ── SNIPING through the UI: the SERVER clock owns the deadline. When it hits zero the
  // client (computed from the server's endsAtMs + offset) stops the clock, disables
  // bidding, and shows "Auction closed" — the student cannot snipe. ──
  banner('Live auction UI — SNIPING: at the server deadline the bid controls vanish, no late bid')
  await saveAuctionSettings(dash, 6, 1)                       // 6-second auction (long enough to render while open)
  await dash.goto(dashboardUrl())                            // restore the dashboard page off /settings
  await dash.waitForSelector(`[data-testid="start-auction-${deadlockGid}"]`, { timeout: 30_000 })
  await dash.locator(`[data-testid="start-auction-${deadlockGid}"]`).click()
  const snipe0 = await pollAuction(deadlockGid, a => a?.status === 'open', 15_000)
  assert(snipe0?.status === 'open', `Auction sniping — short 6s auction opened (endsAtMs ${snipe0?.endsAtMs})`)
  const snipeStu = deadlockMembers[0]
  await waitAuctionScreen(snipeStu.page)
  // While open, the student CAN bid (control present).
  const openHasInput = await snipeStu.page.locator('[data-testid="auction-place-bid"]').count()
  assert(openHasInput === 1, `Auction sniping — while OPEN the Place-bid control is present`)
  // Let the SERVER deadline pass; the client clock (server-offset) hits zero on its own.
  await snipeStu.page.waitForSelector('[data-testid="auction-closed"]', { timeout: 12_000 })
  const clockZero = await snipeStu.page.locator('[data-testid="auction-clock"]').innerText()
  const noBidControl = await snipeStu.page.locator('[data-testid="auction-place-bid"]').count()
  assert(clockZero === '0:00' && noBidControl === 0,
    `Auction SNIPING (UI) — at the deadline the clock stops at 0:00 and the bid control is GONE — no late bid possible (clock=${clockZero}, controls=${noBidControl})`)
  // Close server-side so the deadlock group returns to normal routing for its outcome flow.
  await dash.locator(`[data-testid="close-auction-${deadlockGid}"]`).click()
  await pollAuction(deadlockGid, a => a?.status === 'closed', 10_000)

  // ── (6) Happy group: a `price` deal, accepted + persisted ──────────────────
  banner(`Outcome — happy group: price ${HAPPY_PRICE} deal`)
  await startGroupToReport(happyMembers)
  await reportPriceDeal(happyMembers, HAPPY_PRICE)
  const gHappy = (await pollGroups(gs => gs.find(x => x.id === happyGid)?.status === 'completed', 30_000))
    .find(x => x.id === happyGid)
  assert(gHappy?.status === 'completed' && gHappy?.agreement === true && gHappy?.price === HAPPY_PRICE,
    `Outcome — placeholder price deal accepted + persisted (status=${gHappy?.status}, price=${gHappy?.price})`)

  // ── (7) Deadlock group: 5 rejects → deadlocked → dashboard override { price } ──
  banner(`Deadlock — 5 rejects → deadlocked → dashboard override price ${DEADLOCK_PRICE}`)
  await startGroupToReport(deadlockMembers)
  for (let i = 1; i <= 5; i++) {
    await rejectCycle(deadlockMembers, 100 + i)  // distinct price each cycle (immaterial; group never agrees)
    log(deadlockGid, `reject cycle ${i}/5`)
    if (i < 5) await pollGroups(gs => (gs.find(x => x.id === deadlockGid)?.status) === 'reporting', 15_000)
  }
  const gDead = (await pollGroups(gs => gs.find(x => x.id === deadlockGid)?.status === 'deadlocked', 30_000))
    .find(x => x.id === deadlockGid)
  assert(gDead?.status === 'deadlocked',
    `Deadlock — 5 rejects drive the group to 'deadlocked' (status=${gDead?.status})`)
  // Students see the instructor-intervention screen (real UI state).
  const anyIntervention = await deadlockMembers[0].page.waitForSelector('h1:has-text("Instructor intervention needed")', { timeout: 15_000 })
    .then(() => true).catch(() => false)
  assert(anyIntervention, `Deadlock — the group's students see "Instructor intervention needed"`)

  // Drive the REAL dashboard deadlock-override control: fill "Final price ($)" + Lock Deal.
  await dash.reload()
  await dash.waitForSelector('h2:has-text("Needs Resolution")', { timeout: 30_000 })
  await dash.locator('input[type="number"]').first().fill(String(DEADLOCK_PRICE))
  await dash.click('button:has-text("Lock Deal")')
  const gResolved = (await pollGroups(gs => gs.find(x => x.id === deadlockGid)?.status === 'completed', 20_000))
    .find(x => x.id === deadlockGid)
  // If the control had submitted { placeholder } (the latent Hawks bug), submitInstructorOutcome
  // would REJECT it against the schema → the group would NOT complete + no price would persist.
  assert(gResolved?.status === 'completed' && gResolved?.price === DEADLOCK_PRICE,
    `Deadlock override — control submits { price } (NOT { placeholder }): group completes with price=${gResolved?.price}`)

  // ── No-deal group: present students who walk away (the "present but no bid" case) ──
  banner('Outcome — no-deal group: lead reports NO DEAL, all confirm (present, zero outcome)')
  await startGroupToReport(noDealMembers)
  await reportNoDeal(noDealMembers)
  const gNoDeal = (await pollGroups(gs => gs.find(x => x.id === noDealGid)?.status === 'completed', 30_000))
    .find(x => x.id === noDealGid)
  assert(gNoDeal?.status === 'completed' && gNoDeal?.agreement === false,
    `Outcome — no-deal walk-away persisted (status=${gNoDeal?.status}, agreement=${gNoDeal?.agreement})`)

  // ── (8) Score & Record (dashboard UI) → stub scoring → grade push (POST + 200) ──
  banner('Finalize — Score & Record → stub scoring → grade push (POST + 200)')
  await dash.click('button:has-text("Score & Record")')
  // The push is async; wait for the mock to receive one GameResult per participant.
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

  // Stub scoring wrote raw_score = the group's price (single role → one z-score pool).
  const partsFinal = await readParticipants()
  const happyRaws = partsFinal.filter(p => p.group_id === happyGid).map(p => p.raw_score)
  const deadRaws  = partsFinal.filter(p => p.group_id === deadlockGid).map(p => p.raw_score)
  const noDealParts = partsFinal.filter(p => p.group_id === noDealGid)
  assert(happyRaws.length === happyMembers.length && happyRaws.every(s => s === HAPPY_PRICE),
    `Scoring — stub echoes price: happy group (${happyMembers.length}) raw_score all === ${HAPPY_PRICE}`)
  assert(deadRaws.length === deadlockMembers.length && deadRaws.every(s => s === DEADLOCK_PRICE),
    `Scoring — stub echoes price: deadlock group (${deadlockMembers.length}) raw_score all === ${DEADLOCK_PRICE}`)
  assert(partsFinal.every(p => typeof p.normalized_score === 'number'),
    `Scoring — every participant has a normalized (z) score`)

  // GRADING TRAP: a student who attended and reached the auction but placed NO bid
  // (the no-deal, zero-outcome group) is PRESENT, not a no-show. They score the
  // present-student floor (raw 0), NEVER the no-show −2.
  assert(noDealParts.length === noDealMembers.length && noDealParts.every(p => p.raw_score === 0),
    `Scoring — no-bid present students score raw 0 (walk-away), not treated as absent (${noDealParts.map(p => p.raw_score).join(',')})`)
  assert(noDealParts.every(p => typeof p.normalized_score === 'number' && p.normalized_score !== -2),
    `Scoring — no-bid present students get a present z-score, NOT the no-show −2 (${noDealParts.map(p => p.normalized_score).join(',')})`)
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
