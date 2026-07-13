// ═══════════════════════════════════════════════════════════════════════════════
// AUCTION BIDDING SCREEN — the generic, parameterized live-bidding component.
//
// EXTRACTION CANDIDATE. This file is DOMAIN-FREE: no eBay wording, no "horn", no
// "resale", no hardcoded "higher is better". Every string arrives via `labels`; the
// item image via `labels.itemImageUrl`; the private-information panel is an opaque
// ReactNode slot (`privateInfo`) the domain fills; `direction` is a parameter. When
// the auction engine is extracted, this component moves with it unchanged and eBay
// keeps only its labels file (see ../ebayAuctionLabels.tsx).
//
// It reads live state (from RTDB, passed in as `live`) and calls `onPlaceBid(max)`.
// It never writes to the auction node and never sees a confidential max but its own
// input. The countdown is COSMETIC — rendered against a server-clock offset; the
// server owns the real deadline.
// ═══════════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'

// ── Generic shapes (no domain vocabulary) ──────────────────────────────────────

export type AuctionDirection = 'ascending' | 'descending'

export interface AuctionHistoryRow {
  key: string
  bidderIndex: number   // the resulting high bidder recorded for this step
  amount: number        // the resulting standing price (NEVER a confidential max)
  atMs: number
}

export interface AuctionLive {
  status: 'open' | 'closed'
  currentAmount: number
  highBidderIndex: number | null
  startedAtMs: number
  endsAtMs: number
  increment: number
  history: AuctionHistoryRow[]
}

/** All human-facing copy. The domain supplies this; the component only reads it. */
export interface AuctionLabels {
  itemName: string
  itemImageUrl: string
  winning: string
  notWinning: string
  noBids: string
  currentBidLabel: string
  timeLeftLabel: string
  biddersLabel: (n: number) => string
  closedTitle: string
  closedSubtext: string
  privateInfoHeading: string
  placeBidHeading: string
  maxFieldLabel: string
  minHint: (nextMin: number) => string
  placeBidButton: string
  proxyExplainer: React.ReactNode   // the three load-bearing facts (ceiling / pay-less / confidential)
  bindingNote: React.ReactNode
  confirmTitle: string
  confirmBody: (amount: number, currentAmount: number) => React.ReactNode
  confirmYes: string
  confirmCancel: string
  historyHeading: string
  historyCols: { bidder: string; bid: string; time: string }
  // Personal event sentences (the part that actually teaches proxy bidding).
  msgTookLead: (amount: number) => string
  msgDefended: (amount: number) => string
  msgOutbid: (leaderLabel: string, amount: number, lowerBound: number) => string
}

export interface AuctionBiddingProps {
  labels: AuctionLabels
  direction: AuctionDirection
  live: AuctionLive
  myBidderIndex: number
  numBidders: number
  serverOffsetMs: number
  privateInfo: React.ReactNode
  bidderLabel: (bidderIndex: number) => string
  /** Fat-finger guard: confirm when amount > multiple × current AND amount ≥ floor. */
  confirm: { multiple: number; floor: number }
  onPlaceBid: (maxAmount: number) => Promise<void>
}

// ── Formatting (generic) ────────────────────────────────────────────────────────

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

function mmss(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function clockTime(atMs: number): string {
  const d = new Date(atMs)
  const hh = d.getHours()
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AuctionBidding(props: AuctionBiddingProps) {
  const { labels, direction, live, myBidderIndex, numBidders, serverOffsetMs,
          privateInfo, bidderLabel, confirm, onPlaceBid } = props

  // Cosmetic countdown: tick locally, render against the server-clock offset so a
  // skewed client still shows the right remaining time. The SERVER owns the deadline.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250)
    return () => clearInterval(id)
  }, [])
  const msLeft = Math.max(0, live.endsAtMs - (nowMs + serverOffsetMs))
  const timeUp = msLeft <= 0
  const closed = live.status === 'closed' || timeUp
  const urgent = !closed && msLeft <= 60_000

  // Status line — the most important element on the screen.
  const amWinning = live.highBidderIndex !== null && live.highBidderIndex === myBidderIndex
  const noBids = live.highBidderIndex === null
  const statusText = noBids ? labels.noBids : amWinning ? labels.winning : labels.notWinning
  const statusColor = noBids ? '#555' : amWinning ? '#137333' : '#c5221f'

  // Personal event message — derived purely from PUBLIC transitions (never a max).
  const prev = useRef<{ high: number | null; amount: number } | null>(null)
  const [message, setMessage] = useState<{ kind: string; text: string } | null>(null)
  useEffect(() => {
    const cur = { high: live.highBidderIndex, amount: live.currentAmount }
    const p = prev.current
    if (p) {
      if (p.high === myBidderIndex && cur.high !== myBidderIndex && cur.high !== null) {
        // Overtaken. The honest lower bound on the leader's max is currentAmount −
        // increment (i.e. your own beaten max): all the price reveals is that they
        // beat you — not how much more they'd pay.
        const lb = cur.amount - live.increment
        setMessage({ kind: 'outbid', text: labels.msgOutbid(bidderLabel(cur.high), cur.amount, lb) })
      } else if (cur.high === myBidderIndex && p.high === myBidderIndex && cur.amount > p.amount) {
        // Still winning, but a competitor pushed my proxy up (I can't self-raise the
        // price while leading, so a rise while I lead means someone else bid).
        setMessage({ kind: 'defended', text: labels.msgDefended(cur.amount) })
      } else if (cur.high === myBidderIndex && p.high !== myBidderIndex) {
        setMessage({ kind: 'lead', text: labels.msgTookLead(cur.amount) })
      }
    }
    prev.current = cur
  }, [live.currentAmount, live.highBidderIndex])   // eslint-disable-line react-hooks/exhaustive-deps

  // Place-bid form.
  const [bidText, setBidText] = useState('')
  const [pending, setPending] = useState<number | null>(null)   // awaiting fat-finger confirm
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nextMin = direction === 'ascending'
    ? live.currentAmount + live.increment
    : live.currentAmount - live.increment

  const doSubmit = (amount: number) => {
    setPending(null)
    setSubmitting(true)
    setError(null)
    onPlaceBid(amount)
      .then(() => setBidText(''))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Bid failed. Please try again.'))
      .finally(() => setSubmitting(false))
  }

  const onPlace = () => {
    const amount = Number(bidText)
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter a valid amount.'); return }
    // Fat-finger guard: an order-of-magnitude typo is binding and unrecoverable.
    if (amount > confirm.multiple * live.currentAmount && amount >= confirm.floor) {
      setPending(amount)
      return
    }
    doSubmit(amount)
  }

  const cell: React.CSSProperties = { padding: '0.35rem 0.6rem', borderBottom: '1px solid #eee', textAlign: 'left' }

  return (
    <main
      data-testid="auction-screen"
      style={{ maxWidth: 760, margin: '0 auto', padding: '1rem 1.25rem', fontFamily: 'inherit' }}
    >
      {/* 1 — Item header (no shipping / item number / payment / legal) */}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '0.5rem' }}>
        <img
          src={labels.itemImageUrl}
          alt={labels.itemName}
          style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 6, border: '1px solid #ddd' }}
        />
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>{labels.itemName}</h1>
      </div>

      {/* 2 — THE STATUS LINE */}
      <div
        data-testid="auction-status"
        data-winning={noBids ? 'none' : amWinning ? 'true' : 'false'}
        style={{
          fontSize: '1.6rem', fontWeight: 800, letterSpacing: '0.02em',
          color: statusColor, padding: '0.5rem 0.75rem', margin: '0.25rem 0 0.75rem',
          border: `2px solid ${statusColor}`, borderRadius: 8, textAlign: 'center',
        }}
      >
        {statusText}
      </div>

      {/* 3 — Current bid + clock + static bidder count */}
      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'baseline', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <div>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>{labels.currentBidLabel}</div>
          <div data-testid="auction-current-amount" style={{ fontSize: '1.9rem', fontWeight: 700 }}>
            {money(live.currentAmount)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>{labels.timeLeftLabel}</div>
          <div
            data-testid="auction-clock"
            style={{
              fontSize: urgent ? '2.3rem' : '1.9rem', fontWeight: 700,
              color: closed ? '#666' : urgent ? '#c5221f' : '#111',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {closed ? '0:00' : mmss(msLeft)}
          </div>
        </div>
        <div data-testid="auction-bidders-count" style={{ color: '#444', fontSize: '0.95rem' }}>
          {labels.biddersLabel(numBidders)}
        </div>
      </div>

      {/* 4 — PRIVATE INFORMATION (always visible, domain-provided) */}
      <section
        data-testid="auction-private-info"
        style={{ background: '#f6f8fa', border: '1px solid #d0d7de', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '0.75rem' }}
      >
        <div style={{ fontWeight: 700, marginBottom: '0.4rem' }}>{labels.privateInfoHeading}</div>
        {privateInfo}
      </section>

      {/* 5 — PLACE YOUR BID (inline, always visible) */}
      <section style={{ border: '1px solid #d0d7de', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '0.75rem' }}>
        <div style={{ fontWeight: 700, marginBottom: '0.4rem' }}>{labels.placeBidHeading}</div>
        <div style={{ fontSize: '0.9rem', color: '#333', marginBottom: '0.5rem' }}>{labels.proxyExplainer}</div>
        {closed ? (
          <div data-testid="auction-closed" style={{ padding: '0.5rem 0', color: '#666' }}>
            <strong>{labels.closedTitle}</strong> {labels.closedSubtext}
          </div>
        ) : (
          <>
            <label style={{ display: 'block', fontSize: '0.9rem', marginBottom: '0.25rem' }}>
              {labels.maxFieldLabel}
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                data-testid="auction-max-input"
                type="number" min={0} step={1} inputMode="numeric"
                value={bidText}
                placeholder={String(nextMin)}
                disabled={submitting}
                onChange={e => setBidText(e.target.value)}
                style={{ fontSize: '1.1rem', padding: '0.35rem 0.5rem', width: '9rem', borderRadius: 4, border: '1px solid #ccc' }}
              />
              <button data-testid="auction-place-bid" onClick={onPlace} disabled={submitting || bidText === ''}>
                {submitting ? '…' : labels.placeBidButton}
              </button>
              <span style={{ fontSize: '0.85rem', color: '#666' }}>{labels.minHint(nextMin)}</span>
            </div>
            <div style={{ fontSize: '0.85rem', color: '#8a6d00', marginTop: '0.4rem' }}>{labels.bindingNote}</div>
            {error && (
              <div data-testid="auction-error" style={{ color: '#c5221f', fontSize: '0.9rem', marginTop: '0.4rem' }}>{error}</div>
            )}
          </>
        )}
      </section>

      {/* 7 — PERSONAL EVENT MESSAGE */}
      {message && (
        <div
          data-testid="auction-message"
          data-kind={message.kind}
          style={{
            padding: '0.6rem 0.9rem', borderRadius: 8, marginBottom: '0.75rem', fontSize: '0.95rem',
            background: message.kind === 'outbid' ? '#fce8e6' : '#e6f4ea',
            border: `1px solid ${message.kind === 'outbid' ? '#f5b5b0' : '#a8d5b5'}`,
          }}
        >
          {message.text}
        </div>
      )}

      {/* 6 — BID HISTORY (one row per submitted bid; never a losing max) */}
      <section>
        <div style={{ fontWeight: 700, marginBottom: '0.4rem' }}>{labels.historyHeading}</div>
        <table data-testid="auction-history" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr>
              <th style={{ ...cell, color: '#666', fontWeight: 600 }}>{labels.historyCols.bidder}</th>
              <th style={{ ...cell, color: '#666', fontWeight: 600 }}>{labels.historyCols.bid}</th>
              <th style={{ ...cell, color: '#666', fontWeight: 600 }}>{labels.historyCols.time}</th>
            </tr>
          </thead>
          <tbody>
            {live.history.length === 0 ? (
              <tr><td style={cell} colSpan={3}>{labels.noBids}</td></tr>
            ) : (
              live.history.map(row => (
                <tr key={row.key} data-testid="auction-history-row">
                  <td style={cell}>{bidderLabel(row.bidderIndex)}</td>
                  <td style={cell}>{money(row.amount)}</td>
                  <td style={cell}>{clockTime(row.atMs)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {/* Fat-finger confirmation (client-side guard on a binding, unrecoverable typo) */}
      {pending !== null && (
        <div
          data-testid="auction-confirm-dialog"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
          }}
        >
          <div style={{ background: '#fff', borderRadius: 10, padding: '1.25rem 1.5rem', maxWidth: 420, boxShadow: '0 8px 30px rgba(0,0,0,0.25)' }}>
            <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: '0.5rem' }}>{labels.confirmTitle}</div>
            <div style={{ fontSize: '0.95rem', marginBottom: '1rem' }}>
              {labels.confirmBody(pending, live.currentAmount)}
            </div>
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
              <button data-testid="auction-confirm-cancel" onClick={() => setPending(null)} style={{ background: 'none', border: '1px solid #ccc' }}>
                {labels.confirmCancel}
              </button>
              <button data-testid="auction-confirm-yes" onClick={() => doSubmit(pending)}>
                {labels.confirmYes}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
