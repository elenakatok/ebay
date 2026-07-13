import { useEffect, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { InstructorDashboard as SharedDashboard, type DeadlockResolutionProps, type OutcomeFields } from '@mygames/game-ui'
import { auth, functions, rtdb } from '../firebase'
import { ebayConfig } from '../gameConfig'
import { startAuction, closeAuction, getRoster } from '../api'

const roleLabels = Object.fromEntries(
  ebayConfig.roles.map(r => [r.key, r.label])
)

// ── Minimal live-auction controls (Slice 3) ──────────────────────────────────
// Per-group Start / Close Auction buttons, rendered BELOW the shared dashboard
// (the shared round-controls slot only renders for multi-round games; eBay is
// single-round). Self-fetches the groups via getRoster once the instructor session
// is established. Bare minimum to drive the auction — the student bidding UI + live
// board arrive in Slice 4.

function EbayAuctionControls() {
  const [groups, setGroups] = useState<{ group_id: string }[]>([])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [msg, setMsg] = useState<Record<string, string>>({})

  // Poll the roster until the session is ready and groups exist (they appear at match).
  useEffect(() => {
    let alive = true
    const tick = () =>
      getRoster()
        .then(r => { if (alive && r.groups) setGroups(r.groups.map(g => ({ group_id: g.group_id }))) })
        .catch(() => { /* session not ready yet — retry on the interval */ })
    tick()
    const id = setInterval(tick, 2500)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const run = (gid: string, fn: () => Promise<{ ok: boolean; endsAtMs?: number; alreadyStarted?: boolean }>, verb: string) => {
    setBusy(b => ({ ...b, [gid]: true }))
    setMsg(m => ({ ...m, [gid]: '' }))
    fn()
      .then(r => setMsg(m => ({ ...m, [gid]: r.alreadyStarted ? 'already open' : `${verb} ✓` })))
      .catch((e: unknown) => setMsg(m => ({ ...m, [gid]: e instanceof Error ? e.message : 'error' })))
      .finally(() => setBusy(b => ({ ...b, [gid]: false })))
  }

  if (groups.length === 0) return null
  return (
    <div data-testid="auction-controls" style={{ maxWidth: 900, margin: '1rem auto', padding: '0.75rem 1rem', border: '1px solid #d0d7de', borderRadius: 6 }}>
      <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Live auction</div>
      {groups.map((g, i) => (
        <div key={g.group_id} data-testid={`auction-row-${g.group_id}`} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.2rem 0' }}>
          <span style={{ minWidth: 72 }}>Group {i + 1}</span>
          <button
            data-testid={`start-auction-${g.group_id}`}
            disabled={busy[g.group_id]}
            onClick={() => run(g.group_id, () => startAuction(g.group_id), 'started')}
          >Start Auction</button>
          <button
            data-testid={`close-auction-${g.group_id}`}
            disabled={busy[g.group_id]}
            onClick={() => run(g.group_id, () => closeAuction(g.group_id), 'closed')}
          >Close Auction</button>
          {msg[g.group_id] && <span style={{ fontSize: '0.85rem', color: '#555' }}>{msg[g.group_id]}</span>}
        </div>
      ))}
    </div>
  )
}

// ── Deadlock resolution control (PLACEHOLDER — real deal fields in Part 3) ────
// Submits the single placeholder 'price' field from ebaySchema (validated
// server-side against def.outcomeSchema), or { no_deal: true } for a walk-away.

function EbayDeadlockControl({ submitting, error, onSubmit }: DeadlockResolutionProps) {
  const [price, setPrice] = useState('')
  const [noDeal, setNoDeal] = useState(false)

  const handleSubmit = () => {
    if (noDeal) { onSubmit({ no_deal: true }); return }
    const n = parseInt(price, 10)
    if (isNaN(n)) return
    const outcome: OutcomeFields = { price: n }
    onSubmit(outcome)
  }

  const inputStyle: React.CSSProperties = {
    fontSize: '0.875rem', padding: '0.3rem 0.5rem', borderRadius: 3, border: '1px solid #ccc',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {!noDeal && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '0.875rem', minWidth: '7rem' }}>Final price ($)</label>
          <input
            type="number" min={0} max={10000} step={1}
            placeholder="0" value={price}
            onChange={e => setPrice(e.target.value)}
            style={{ ...inputStyle, width: '6rem' }}
            disabled={submitting}
          />
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem' }}>
        <button
          onClick={handleSubmit}
          disabled={submitting || (!noDeal && price === '')}
        >
          {submitting ? '…' : noDeal ? 'Confirm No Deal' : 'Lock Deal'}
        </button>
        <button
          onClick={() => setNoDeal(v => !v)}
          disabled={submitting}
          style={{ background: 'none', border: '1px solid #ccc' }}
        >
          {noDeal ? 'Enter deal terms instead' : 'No deal'}
        </button>
      </div>
      {error && <p style={{ color: '#c00', fontSize: '0.8rem', margin: 0 }}>{error}</p>}
    </div>
  )
}

async function submitInstructorOutcome(groupId: string, outcome: OutcomeFields): Promise<void> {
  const fn = httpsCallable(functions, 'submitInstructorOutcome')
  await fn({ group_id: groupId, outcome })
}

export default function InstructorDashboard() {
  return (
    <>
    <SharedDashboard
      title="Instructor Dashboard — eBay"
      roleLabels={roleLabels}
      // CRITICAL: pass composition so canMatch gates on ≥4 bidders (single role)
      composition={{ bidder: 4 }}
      DeadlockResolutionControl={EbayDeadlockControl}
      submitInstructorOutcome={submitInstructorOutcome}
      functions={functions}
      auth={auth}
      rtdb={rtdb}
      settingsRoute="/settings"
      reportsRoute="/reports"
      scoreAndRecord={{ callableName: 'scoreAndRecord', label: 'Score & Record' }}
    />
    <EbayAuctionControls />
    </>
  )
}
