import React, { useEffect, useRef, useState } from 'react'
import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, rtdb, functions } from '../firebase'
import { assignRole, confirmReady, verifyAttendanceCode, submitBid, checkAuctionClose, CLASSROOM_URL } from '../api'
import AuctionBidding from '../auction/AuctionBidding'
import AuctionResults, { type AuctionResult } from '../auction/AuctionResults'
import { useAuctionNode } from '../auction/useAuctionNode'
import { ebayAuctionLabels, ebayAuctionResultsLabels, ebayBidderLabel, ebayPrivateInfo, EBAY_CONFIRM, type EbayEndowment } from '../ebayAuctionLabels'
import {
  useStudentSession,
  KnowledgeCheck,
  InfoPage,
  PrepQuestions,
  GameHeader,
  WaitingRoom,
  typography,
  colors,
  layout,
  spacing,
} from '@mygames/game-ui'
import type { BootstrapArgs, InfoPageLink } from '@mygames/game-ui'

// ── Phase state ───────────────────────────────────────────────────────────────

// eBay is a self-resolving AUCTION — there is NO negotiation, no group-reveal, no outcome
// report, no confirmation handshake, no deadlock. Once a student is matched they wait in
// the auction room; the live-auction overlay (useEbayAuction) takes over the screen when
// the instructor starts the auction and again when it resolves (full-reveal results). So
// the phase machine ends at 'matched' — everything after is the overlay.
type GamePhase =
  | { name: 'loading' }
  | { name: 'error';           message: string }
  | { name: 'info';            roleLabel: string; links: InfoPageLink[]; publicLink: { label: string; url: string } | null }
  | { name: 'kc' }
  | { name: 'prep' }
  | { name: 'hold' }
  | { name: 'confirmation' }
  | { name: 'attendance-code' }
  | { name: 'waiting-room' }
  | { name: 'placement-absent' }
  | { name: 'matched';         groupId: string }

// ── Phase routing ─────────────────────────────────────────────────────────────

type GetInfoUrlsResult = {
  ok: boolean
  roleLabel: string
  links: InfoPageLink[]
  publicLink: { label: string; url: string } | null
}

async function routeToPhase(participantId: string, gameInstanceId: string): Promise<GamePhase> {
  const snap = await getDoc(
    doc(db, 'game_instances', gameInstanceId, 'participants', participantId),
  )
  const d = snap.data() ?? {}

  if (d.prep_status !== 'complete') {
    if (d.knowledge_check_score != null) return { name: 'prep' }
    const fn = httpsCallable<object, GetInfoUrlsResult>(functions, 'getInfoUrls')
    const { data } = await fn({})
    return {
      name:       'info',
      roleLabel:  data.roleLabel,
      links:      data.links,
      publicLink: data.publicLink ?? null,
    }
  }

  // prep_status === 'complete' — Phase 2 routing
  if (!d.confirmed_ready_at)      return { name: 'hold' }
  if (!d.attendance_confirmed_at) return { name: 'confirmation' }
  if (!d.group_id)                return { name: 'waiting-room' }

  // Matched. The auction overlay (useEbayAuction) owns bidding + results from here — it
  // renders ON TOP of this phase the instant the RTDB node opens or auction_result lands.
  // Until then, 'matched' is a sensible "waiting for the auction to start" room. There is
  // NO group status branch: no 'matched' reveal, no 'negotiating'/'reporting'/'deadlocked'.
  return { name: 'matched', groupId: d.group_id as string }
}

// ── Live-auction overlay (Slice 4) ────────────────────────────────────────────
// Subscribes to the student's OWN participant doc (group_id + endowment), the group
// doc (static bidder count), and the group's RTDB auction node. When the instructor
// opens the auction, `active` flips true and the bidding screen takes over the phase
// UI — until the auction is no longer open, when normal routing resumes.

function useEbayAuction(iid: string | null, pid: string | null) {
  const [groupId, setGroupId]     = useState<string | null>(null)
  const [endowment, setEndowment] = useState<EbayEndowment | null>(null)
  const [numBidders, setNumBidders] = useState(0)
  const [result, setResult]       = useState<AuctionResult | null>(null)

  useEffect(() => {
    if (!iid || !pid) return
    const off = onSnapshot(doc(db, 'game_instances', iid, 'participants', pid), snap => {
      const d = snap.data() ?? {}
      setGroupId(typeof d.group_id === 'string' && d.group_id ? d.group_id : null)
      const e = d.auction_endowment
      if (e && typeof e.bidderIndex === 'number') setEndowment(e as EbayEndowment)
      // The full reveal lands on the student's OWN participant doc at resolution
      // (member-only read; vCommon/maxes are copied here, never un-denied at source).
      setResult((d.auction_result as AuctionResult | undefined) ?? null)
    })
    return () => off()
  }, [iid, pid])

  useEffect(() => {
    if (!iid || !groupId) return
    const off = onSnapshot(doc(db, 'game_instances', iid, 'groups', groupId), snap => {
      const arr = snap.data()?.bidder_participants
      if (Array.isArray(arr)) setNumBidders(arr.length)
    })
    return () => off()
  }, [iid, groupId])

  const { live, serverOffsetMs } = useAuctionNode(rtdb, iid, groupId)

  // CLOSE TRIGGER: no scheduled function — whoever observes the passed deadline drives
  // resolution. Fire checkAuctionClose at the deadline (or immediately if we loaded
  // after it), once, until the result lands. Concurrent members racing here is fine —
  // the server election is idempotent.
  const firedRef = useRef(false)
  useEffect(() => {
    firedRef.current = false   // reset when the group/auction identity changes
  }, [groupId, live?.endsAtMs])
  useEffect(() => {
    if (!iid || !groupId || !live || result) return
    if (live.status !== 'open' && live.status !== 'closed') return
    const fire = () => {
      if (firedRef.current) return
      firedRef.current = true
      checkAuctionClose({}, groupId).catch(() => { firedRef.current = false })
    }
    const msLeft = live.endsAtMs - (Date.now() + serverOffsetMs)
    if (msLeft <= 0) { fire(); return }
    const t = setTimeout(fire, msLeft + 400)
    return () => clearTimeout(t)
  }, [iid, groupId, live, serverOffsetMs, result])

  return {
    result,
    showBidding: !result && live?.status != null,
    live, serverOffsetMs, endowment, numBidders, groupId,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Play() {
  const p       = new URLSearchParams(window.location.search)
  const token   = p.get('token')
  const testPid = import.meta.env.DEV ? p.get('_pid') : null
  const testGid = import.meta.env.DEV ? p.get('_gid') : null

  const [phase, setPhase]             = useState<GamePhase>({ name: 'loading' })
  const [headerLinks, setHeaderLinks] = useState<InfoPageLink[] | null>(null)
  const [confError,   setConfError]   = useState<string | null>(null)
  const [confLoading, setConfLoading] = useState(false)
  const [codeValue,   setCodeValue]   = useState('')
  const [codeError,   setCodeError]   = useState<string | null>(null)
  const [codeLoading, setCodeLoading] = useState(false)

  // ── Session lifecycle ────────────────────────────────────────────────────

  const session = useStudentSession({
    auth,
    token,
    testIds: (testPid && testGid) ? { participantId: testPid, gameInstanceId: testGid } : null,
    bootstrap: async (args: BootstrapArgs) => {
      const r = await assignRole(args)
      return {
        participantId:  r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken:    r.customToken,
      }
    },
  })

  // Live-auction overlay — driven independently of the phase machine (RTDB).
  const sessIid = session.kind === 'ready' ? session.gameInstanceId : null
  const sessPid = session.kind === 'ready' ? session.participantId  : null
  const auction = useEbayAuction(sessIid, sessPid)

  // ── Phase routing + header-link population ────────────────────────────────

  useEffect(() => {
    if (session.kind !== 'ready') return
    const { participantId, gameInstanceId } = session
    let cancelled = false

    const run = async () => {
      let p: GamePhase
      try {
        p = await routeToPhase(participantId, gameInstanceId)
      } catch (err) {
        if (!cancelled) setPhase({ name: 'error', message: err instanceof Error ? err.message : 'Failed to load session.' })
        return
      }
      if (cancelled) return
      setPhase(p)

      if (p.name === 'info') {
        if (!cancelled) setHeaderLinks(p.links)
      } else {
        const fn = httpsCallable<object, GetInfoUrlsResult>(functions, 'getInfoUrls')
        fn({}).then(({ data }) => { if (!cancelled) setHeaderLinks(data.links) }).catch(() => {})
      }
    }

    void run()
    return () => { cancelled = true }
  }, [session])

  // ── Latecomer placement outcome (Latecomer_Placement_Spec_v1 §3–§4) ────────
  // While waiting, watch our own participant doc. A normally-matched student gets
  // a group_id (WaitingRoom advances to 'matched'); a latecomer for whom no group
  // was joinable gets latecomer_absent → the clear terminal message below, never
  // an endless spinner. Server-side placement runs during verifyAttendanceCode, so
  // the outcome is usually already present the moment this mounts.
  useEffect(() => {
    if (phase.name !== 'waiting-room' || !sessPid || !sessIid) return
    const ref = doc(db, 'game_instances', sessIid, 'participants', sessPid)
    return onSnapshot(ref, (snap) => {
      if (snap.data()?.latecomer_absent === true) setPhase({ name: 'placement-absent' })
    })
  }, [phase.name, sessPid, sessIid])

  // ── Render: pre-session states (no header) ────────────────────────────────

  if (session.kind === 'loading' || (session.kind === 'ready' && phase.name === 'loading')) {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p>Loading…</p>
      </main>
    )
  }

  if (session.kind === 'no-token') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily, maxWidth: '480px', margin: '2rem auto' }}>
        <h2 style={{ marginBottom: '0.75rem' }}>eBay</h2>
        <p>Please launch eBay from the classroom to join a session.</p>
        <p style={{ marginTop: '1.5rem' }}><a href={CLASSROOM_URL}>← Go to classroom</a></p>
      </main>
    )
  }

  if (session.kind === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p style={{ color: '#c00' }}>{session.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  if (phase.name === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p style={{ color: '#c00' }}>{phase.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  const { participantId, gameInstanceId } = session

  // ── Live-auction overlay: takes over the screen from open bidding through the
  // full-reveal results. `result` (on the student's own participant doc) wins; while
  // an auction node exists but is unresolved we stay on the bidding screen (which shows
  // "Auction closed. Results coming." once the clock is up) — never a flicker to routing.
  if (auction.result && auction.endowment) {
    return (
      <div style={{ fontFamily: typography.fontFamily }}>
        <GameHeader studentLinks={headerLinks} />
        <AuctionResults
          labels={ebayAuctionResultsLabels}
          result={auction.result}
          myBidderIndex={auction.endowment.bidderIndex}
          bidderLabel={ebayBidderLabel}
          history={auction.live?.history ?? []}
        />
      </div>
    )
  }
  if (auction.showBidding && auction.live && auction.endowment && auction.groupId) {
    const gid = auction.groupId
    return (
      <div style={{ fontFamily: typography.fontFamily }}>
        <GameHeader studentLinks={headerLinks} />
        <AuctionBidding
          labels={ebayAuctionLabels}
          direction="ascending"
          live={auction.live}
          myBidderIndex={auction.endowment.bidderIndex}
          numBidders={auction.numBidders}
          serverOffsetMs={auction.serverOffsetMs}
          privateInfo={ebayPrivateInfo(auction.endowment)}
          bidderLabel={ebayBidderLabel}
          confirm={EBAY_CONFIRM}
          onPlaceBid={(maxAmount) => submitBid({}, gid, maxAmount).then(() => {})}
        />
      </div>
    )
  }

  // ── P2 inline handlers ────────────────────────────────────────────────────

  const handleConfirmReady = () => {
    setConfLoading(true)
    setConfError(null)
    confirmReady({})
      .then(() => setPhase({ name: 'attendance-code' }))
      .catch((err: unknown) => {
        setConfError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setConfLoading(false)
      })
  }

  const handleAttendanceCode = (e: React.FormEvent) => {
    e.preventDefault()
    const code = codeValue.trim()
    if (code.length < 4) return
    setCodeLoading(true)
    setCodeError(null)
    verifyAttendanceCode({}, code)
      .then(() => setPhase({ name: 'waiting-room' }))
      .catch((err: unknown) => {
        setCodeError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setCodeLoading(false)
      })
  }

  // ── Render: session ready — header persists across all phases ─────────────

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <GameHeader studentLinks={headerLinks} />

      {phase.name === 'info' && (
        <InfoPage
          roleLabel={phase.roleLabel}
          links={phase.links}
          publicLink={phase.publicLink}
          onContinue={() => setPhase({ name: 'kc' })}
        />
      )}

      {phase.name === 'kc' && (
        <KnowledgeCheck
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          functions={functions}
          db={db}
          onComplete={() => setPhase({ name: 'prep' })}
        />
      )}

      {phase.name === 'prep' && (
        <PrepQuestions
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          functions={functions}
          db={db}
          onComplete={() => setPhase({ name: 'hold' })}
        />
      )}

      {phase.name === 'hold' && (
        <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Preparation complete</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            When class begins and your instructor starts the session, you&apos;ll be placed
            in an auction and the bidding will begin.
          </p>
          <p style={{ color: colors.textSecondary, marginBottom: layout.pagePad }}>
            You can close this tab and come back later — your work has been saved.
          </p>
          <button onClick={() => setPhase({ name: 'confirmation' })}>
            I&apos;m in class — continue
          </button>
        </main>
      )}

      {phase.name === 'confirmation' && (
        <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Ready to join the auction?</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            You&apos;ll be placed into an auction with other bidders. Only continue if you are
            in class and ready to bid right now.
          </p>
          {confError && (
            <p style={{ color: '#c00', marginBottom: spacing.gapSm }}>{confError}</p>
          )}
          <div style={{ display: 'flex', gap: spacing.gapBtn }}>
            <button onClick={handleConfirmReady} disabled={confLoading}>
              {confLoading ? 'Confirming…' : "Yes, I'm ready"}
            </button>
            <button
              onClick={() => setPhase({ name: 'hold' })}
              disabled={confLoading}
              style={{ background: 'none', border: '1px solid #ccc' }}
            >
              Not now
            </button>
          </div>
        </main>
      )}

      {phase.name === 'attendance-code' && (
        <main style={{ padding: layout.pagePad, maxWidth: '540px', margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Enter attendance code</h1>
          <p style={{ lineHeight: 1.6, marginBottom: layout.pagePad }}>
            Enter the code your instructor is displaying.
          </p>
          <form onSubmit={handleAttendanceCode}>
            <input
              value={codeValue}
              onChange={e => setCodeValue(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="e.g. ABJKM"
              autoFocus
              autoCapitalize="characters"
              spellCheck={false}
              disabled={codeLoading}
              style={{
                fontSize:     '2rem',
                letterSpacing: '0.25em',
                width:         '100%',
                padding:       '0.5rem 0.75rem',
                boxSizing:     'border-box',
                fontFamily:    'monospace',
                textTransform: 'uppercase',
              }}
            />
            {codeError && (
              <p style={{ color: '#c00', marginTop: '0.75rem' }}>{codeError}</p>
            )}
            <button
              type="submit"
              disabled={codeLoading || codeValue.trim().length < 4}
              style={{ marginTop: spacing.gapMd }}
            >
              {codeLoading ? 'Checking…' : 'Submit'}
            </button>
          </form>
        </main>
      )}

      {phase.name === 'waiting-room' && (
        <WaitingRoom
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          db={db}
          rtdb={rtdb}
          onMatched={(groupId) => setPhase({ name: 'matched', groupId })}
        />
      )}

      {phase.name === 'placement-absent' && (
        <main data-testid="placement-absent" style={{ padding: layout.pagePad, maxWidth: '540px', margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Class has already started</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            There is no auction available to join right now. Please speak to your instructor.
          </p>
          <p style={{ color: colors.textSecondary }}>
            <a href={CLASSROOM_URL}>← Return to classroom</a>
          </p>
        </main>
      )}

      {phase.name === 'matched' && (
        <main data-testid="auction-room" style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>You&apos;re in the auction room</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            You&apos;ve been placed in an auction. The bidding will begin the moment your
            instructor starts it — stay on this page and it will open automatically.
          </p>
          <p style={{ color: colors.textSecondary }}>
            Keep this tab open. When the auction opens you&apos;ll see the item and be able to bid.
          </p>
        </main>
      )}
    </div>
  )
}
