import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { InstructorDashboard as SharedDashboard, type DeadlockResolutionProps, type OutcomeFields } from '@mygames/game-ui'
import { auth, functions, rtdb } from '../firebase'
import { ebayConfig } from '../gameConfig'

const roleLabels = Object.fromEntries(
  ebayConfig.roles.map(r => [r.key, r.label])
)

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
    <SharedDashboard
      title="Instructor Dashboard — eBay"
      roleLabels={roleLabels}
      // CRITICAL: pass composition so canMatch gates on ≥1 expert + ≥3 nonexpert
      composition={{ expert: 1, nonexpert: 3 }}
      DeadlockResolutionControl={EbayDeadlockControl}
      submitInstructorOutcome={submitInstructorOutcome}
      functions={functions}
      auth={auth}
      rtdb={rtdb}
      settingsRoute="/settings"
      reportsRoute="/reports"
      scoreAndRecord={{ callableName: 'scoreAndRecord', label: 'Score & Record' }}
    />
  )
}
