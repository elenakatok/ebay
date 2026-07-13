import { useEffect, useState } from 'react'
import { InstructorDashboard as SharedDashboard } from '@mygames/game-ui'
import { auth, functions, rtdb } from '../firebase'
import { ebayConfig } from '../gameConfig'
import { startAuction, getReportData, type GroupReport, type MemberOutcome } from '../api'

const roleLabels = Object.fromEntries(
  ebayConfig.roles.map(r => [r.key, r.label])
)

// ── eBay AUCTION PANEL (top of the dashboard) ────────────────────────────────────
// eBay is single-role, so the shared dashboard's `renderRoundControls` slot never
// renders (it's multi-round only) and the fixed action bar exposes no slot — so the
// per-group Start Auction controls cannot be injected INTO the shared top bar without a
// game-ui change (deny-listed). Instead this eBay-local panel is rendered ABOVE the
// shared dashboard, giving the Start Auction controls the TOP position (spec §7d Fix 1),
// alongside the auction OUTCOME per student (Won / Lost / No bid — spec §7d Fix 2).
//
// NOTE on the shared roster's "Outcome" column: it renders participant.raw_score (the flat
// participation point, "+1") and is hard-coded in shared game-ui RosterTable — it cannot be
// changed from eBay's side without a shared-package edit. This panel surfaces the REAL game
// outcome (Won/Lost/No bid) instead; the roster's generic column is left as the shared
// component ships it.

const OUTCOME_STYLE: Record<MemberOutcome, React.CSSProperties> = {
  'Won':    { background: '#e6f4ea', color: '#137333', border: '1px solid #a8d5b5' },
  'Lost':   { background: '#f1f3f4', color: '#5f6368', border: '1px solid #dadce0' },
  'No bid': { background: '#fef7e0', color: '#8a6d00', border: '1px solid #f0d98a' },
  '—':      { background: 'transparent', color: '#9aa0a6', border: '1px solid #e0e0e0' },
}
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const signedMoney = (n: number) => (n < 0 ? '−$' + Math.abs(Math.round(n)).toLocaleString('en-US') : '$' + Math.round(n).toLocaleString('en-US'))

function OutcomeChip({ outcome }: { outcome: MemberOutcome }) {
  return (
    <span data-testid="dash-member-outcome" data-outcome={outcome}
      style={{ ...OUTCOME_STYLE[outcome], fontSize: '0.78rem', fontWeight: 600, padding: '0.1rem 0.5rem', borderRadius: 10, whiteSpace: 'nowrap' }}>
      {outcome}
    </span>
  )
}

function EbayAuctionPanel() {
  const [groups, setGroups] = useState<GroupReport[]>([])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [msg, setMsg] = useState<Record<string, string>>({})

  // Poll getReportData: it returns the group list + per-group auction status + per-member
  // Won/Lost/No bid (all without requiring finalize), so this one source drives everything.
  useEffect(() => {
    let alive = true
    const tick = () =>
      getReportData()
        .then(r => { if (alive) setGroups(r.groupReports) })
        .catch(() => { /* session not ready / no groups yet — retry on the interval */ })
    tick()
    const id = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const run = (gid: string) => {
    setBusy(b => ({ ...b, [gid]: true }))
    setMsg(m => ({ ...m, [gid]: '' }))
    startAuction(gid)
      .then(r => setMsg(m => ({ ...m, [gid]: r.alreadyStarted ? 'already open' : 'started ✓' })))
      .catch((e: unknown) => setMsg(m => ({ ...m, [gid]: e instanceof Error ? e.message : 'error' })))
      .finally(() => setBusy(b => ({ ...b, [gid]: false })))
  }

  if (groups.length === 0) return null

  return (
    <div data-testid="auction-controls" style={{ maxWidth: 1100, margin: '1rem auto 0', padding: '0.75rem 1rem', border: '1px solid #d0d7de', borderRadius: 8, background: '#fbfcfd' }}>
      <div style={{ fontWeight: 700, marginBottom: '0.5rem', fontSize: '1.05rem' }}>Live auctions</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {groups.map((g, i) => {
          const num = g.group_number ?? i + 1
          return (
            <div key={g.group_id} data-testid={`auction-row-${g.group_id}`}
              style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', padding: '0.5rem 0.6rem', borderBottom: '1px solid #eef1f4' }}>
              <span style={{ minWidth: 70, fontWeight: 600 }}>Group {num}</span>

              {g.auction_status === 'not-started' && (
                <>
                  <button data-testid={`start-auction-${g.group_id}`} disabled={busy[g.group_id]} onClick={() => run(g.group_id)}>
                    Start Auction
                  </button>
                  <span style={{ fontSize: '0.8rem', color: '#888' }}>closes automatically at its deadline</span>
                </>
              )}
              {g.auction_status === 'open' && (
                <span style={{ fontSize: '0.9rem', color: '#137333', fontWeight: 600 }}>● Auction open — closes at its deadline</span>
              )}
              {g.auction_status === 'closed' && (
                <span style={{ fontSize: '0.9rem', color: '#8a6d00' }}>Closed — resolving…</span>
              )}
              {g.auction_status === 'resolved' && (
                <span data-testid={`auction-result-${g.group_id}`} style={{ fontSize: '0.9rem' }}>
                  {g.no_sale
                    ? <strong style={{ color: '#8a6d00' }}>No sale — nobody bid</strong>
                    : <>Sold — <strong>{g.high_bidder_label}</strong> won at <strong>{g.auction_price != null ? money(g.auction_price) : '—'}</strong>
                        {g.winner_profit != null && <span style={{ color: g.winner_profit < 0 ? '#c5221f' : '#137333', marginLeft: '0.4rem' }}>(profit {signedMoney(g.winner_profit)})</span>}</>}
                </span>
              )}

              {msg[g.group_id] && <span style={{ fontSize: '0.85rem', color: '#555' }}>{msg[g.group_id]}</span>}

              {/* Per-student GAME outcome (never a grade) — Won / Lost / No bid */}
              {g.members.length > 0 && (
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginLeft: 'auto' }}>
                  {g.members.map(m => (
                    <span key={m.participant_id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem' }}>
                      <span style={{ color: '#5f6368' }}>{m.name}</span>
                      <OutcomeChip outcome={m.outcome} />
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function InstructorDashboard() {
  return (
    <>
      {/* Auction controls + outcomes at the TOP (spec §7d). */}
      <EbayAuctionPanel />
      <SharedDashboard
        title="Instructor Dashboard — eBay"
        roleLabels={roleLabels}
        // CRITICAL: pass composition so canMatch gates on ≥4 bidders (single role)
        composition={{ bidder: 4 }}
        functions={functions}
        auth={auth}
        rtdb={rtdb}
        settingsRoute="/settings"
        reportsRoute="/reports"
        scoreAndRecord={{ callableName: 'scoreAndRecord', label: 'Score & Record' }}
      />
    </>
  )
}
