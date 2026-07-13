import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth, functions } from '../firebase'
import {
  SortableTable,
  ReportBoard,
  GameHeader,
  ExportModal,
  buildStudentTextExport,
  type SortableColumn,
  type ReportTileConfig,
  type AiTextRow,
} from '@mygames/game-ui'
import PriceOverTimeSVG from '../components/PriceOverTimeSVG'
import type { ReportData, GroupReport, StudentReportRow, MemberOutcome } from '../api'

// ── Formatting ──────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = { bidder: 'Bidder' }

const money = (n: number | null) => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US')
const signedMoney = (n: number | null) =>
  n == null ? '—' : (n < 0 ? '−$' + Math.abs(Math.round(n)).toLocaleString('en-US') : '$' + Math.round(n).toLocaleString('en-US'))
const secs = (n: number | null) => n == null ? '—' : `${n}s`
const fmtKc = (n: number | null) => n == null ? '—' : `${Math.round(n * 5)} / 5`
const nameLabel = (name: string | null, label: string | null) => name && label ? `${name}: ${label}` : (name ?? label ?? '—')

const OUTCOME_COLOR: Record<MemberOutcome, string> = { 'Won': '#137333', 'Lost': '#5f6368', 'No bid': '#8a6d00', '—': '#9aa0a6' }

// ── Report 1 — per-group summary ──────────────────────────────────────────────────

type GroupSortKey = 'group' | 'highest' | 'price' | 'profit' | 'high_bidder' | 't_high' | 'second' | 't_second' | 'expert'

const GROUP_COLUMNS: readonly SortableColumn<GroupReport, GroupSortKey>[] = [
  { key: 'group', label: 'Group', sticky: 'left', headerStyle: { minWidth: 64 },
    render: r => r.group_number ?? '—',
    compare: (a, b) => (a.group_number ?? Infinity) - (b.group_number ?? Infinity) },
  { key: 'highest', label: 'Highest Bid', nullsLast: true, isNull: r => r.highest_bid == null,
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.highest_bid)}</span>,
    compare: (a, b) => (a.highest_bid ?? 0) - (b.highest_bid ?? 0) },
  { key: 'price', label: 'Auction Price', nullsLast: true, isNull: r => r.no_sale,
    render: r => r.no_sale ? <span style={{ color: '#8a6d00' }}>No sale</span> : <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.auction_price)}</span>,
    compare: (a, b) => (a.auction_price ?? 0) - (b.auction_price ?? 0) },
  { key: 'profit', label: 'Winner Profit', nullsLast: true, isNull: r => r.winner_profit == null,
    render: r => r.winner_profit == null ? '—'
      : <span style={{ fontVariantNumeric: 'tabular-nums', color: r.winner_profit < 0 ? '#c5221f' : '#137333', fontWeight: r.winner_profit < 0 ? 700 : 400 }}>{signedMoney(r.winner_profit)}</span>,
    compare: (a, b) => (a.winner_profit ?? 0) - (b.winner_profit ?? 0) },
  { key: 'high_bidder', label: 'High Bidder',
    render: r => nameLabel(r.high_bidder_name, r.high_bidder_label),
    compare: (a, b) => (a.high_bidder_name ?? '').localeCompare(b.high_bidder_name ?? '') },
  { key: 't_high', label: 'Time: Highest', nullsLast: true, isNull: r => r.time_highest_sec == null,
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{secs(r.time_highest_sec)}</span>,
    compare: (a, b) => (a.time_highest_sec ?? 0) - (b.time_highest_sec ?? 0) },
  { key: 'second', label: 'Second Bidder',
    render: r => nameLabel(r.second_bidder_name, r.second_bidder_label),
    compare: (a, b) => (a.second_bidder_name ?? '').localeCompare(b.second_bidder_name ?? '') },
  { key: 't_second', label: 'Time: Second', nullsLast: true, isNull: r => r.time_second_sec == null,
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{secs(r.time_second_sec)}</span>,
    compare: (a, b) => (a.time_second_sec ?? 0) - (b.time_second_sec ?? 0) },
  { key: 'expert', label: 'Expert Name',
    render: r => r.expert_name ?? '—',
    compare: (a, b) => (a.expert_name ?? '').localeCompare(b.expert_name ?? '') },
]

// ── Report 3 — per-student (PROFIT is a game outcome, NEVER a grade) ───────────────

type StudentSortKey = 'name' | 'group' | 'role' | 'bidder' | 'outcome' | 'profit' | 'participation' | 'kc'

const STUDENT_COLUMNS: readonly SortableColumn<StudentReportRow, StudentSortKey>[] = [
  { key: 'name', label: 'Name', sticky: 'left', headerStyle: { minWidth: 140 },
    render: r => r.display_name, compare: (a, b) => a.display_name.localeCompare(b.display_name) },
  { key: 'group', label: 'Group #',
    render: r => r.group_number ?? '—', compare: (a, b) => (a.group_number ?? Infinity) - (b.group_number ?? Infinity) },
  { key: 'role', label: 'Role',
    render: r => ROLE_LABELS[r.role] ?? r.role, compare: (a, b) => a.role.localeCompare(b.role) },
  { key: 'bidder', label: 'Bidder',
    render: r => r.bidder_label ?? '—', compare: (a, b) => (a.bidder_label ?? '').localeCompare(b.bidder_label ?? '') },
  // ── GAME outcome (not a grade) ──
  { key: 'outcome', label: 'Outcome', headerStyle: { minWidth: 72 },
    render: r => r.outcome_label
      ? <span style={{ color: OUTCOME_COLOR[r.outcome_label], fontWeight: 600 }}>{r.outcome_label}</span> : '—',
    compare: (a, b) => (a.outcome_label ?? '').localeCompare(b.outcome_label ?? '') },
  { key: 'profit', label: 'Profit ($) — game outcome, not a grade', nullsLast: true, isNull: r => r.profit == null,
    render: r => r.profit == null ? '—'
      : <span data-testid="report-profit" style={{ fontVariantNumeric: 'tabular-nums', color: r.profit < 0 ? '#c5221f' : '#137333', fontWeight: r.profit < 0 ? 700 : 400 }}>{signedMoney(r.profit)}</span>,
    compare: (a, b) => (a.profit ?? 0) - (b.profit ?? 0) },
  // ── GRADE ──
  { key: 'participation', label: 'Participation (grade)', nullsLast: true, isNull: r => r.participation == null,
    render: r => r.participation == null ? '—' : <span data-testid="report-participation" style={{ fontVariantNumeric: 'tabular-nums' }}>{r.participation}</span>,
    compare: (a, b) => (a.participation ?? 0) - (b.participation ?? 0) },
  { key: 'kc', label: 'KC score (grade)', nullsLast: true, isNull: r => r.knowledge_check_score == null,
    render: r => <span data-testid="report-kc" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtKc(r.knowledge_check_score)}</span>,
    compare: (a, b) => (a.knowledge_check_score ?? 0) - (b.knowledge_check_score ?? 0) },
]

// ── Modal shell ───────────────────────────────────────────────────────────────────

function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '3rem 1rem', zIndex: 1000, overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.25)', width: '100%', maxWidth: wide ? 'min(1200px, calc(100vw - 2rem))' : 'min(1000px, calc(100vw - 2rem))', minWidth: 0, boxSizing: 'border-box', maxHeight: 'calc(100vh - 6rem)', overflowY: 'auto', padding: '1.25rem 1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: '#666' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────────

type ReportKind = 'group' | 'chart' | 'student'

export default function Reports() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const devGameInstanceId = import.meta.env.DEV ? searchParams.get('_dev_game_instance_id') : null
  const tokenParam = searchParams.get('token')
  const gameInstanceIdParam = searchParams.get('game_instance_id')

  const [sessionReady, setSessionReady] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  const makeLink = (base: string): string => {
    if (devGameInstanceId) return `${base}?_dev_game_instance_id=${encodeURIComponent(devGameInstanceId)}`
    if (tokenParam && gameInstanceIdParam) return `${base}?token=${encodeURIComponent(tokenParam)}&game_instance_id=${encodeURIComponent(gameInstanceIdParam)}`
    return base
  }

  // ── Auth bootstrap ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const establish = async () => {
      await auth.authStateReady()
      if (cancelled) return
      if (auth.currentUser) {
        const expectedUid = devGameInstanceId ? `instructor_${devGameInstanceId}`
          : gameInstanceIdParam ? `instructor_${gameInstanceIdParam}` : null
        if (expectedUid && auth.currentUser.uid === expectedUid) { setSessionReady(true); return }
        await signOut(auth)
        if (cancelled) return
      }
      const args = devGameInstanceId ? { _dev: { game_instance_id: devGameInstanceId } } : tokenParam ? { token: tokenParam } : null
      if (!args) { setAuthError('No launch token found.'); return }
      try {
        const fn = httpsCallable<object, { customToken: string }>(functions, 'getInstructorSession')
        const res = await fn(args)
        if (cancelled) return
        await signInWithCustomToken(auth, res.data.customToken)
        if (cancelled) return
        setSessionReady(true)
      } catch (err) {
        if (cancelled) return
        setAuthError(err instanceof Error ? err.message : 'Failed to establish session.')
      }
    }
    void establish()
    return () => { cancelled = true }
  }, [devGameInstanceId, tokenParam]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Data ─────────────────────────────────────────────────────────────────────
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionReady) return
    setLoading(true); setError(null)
    const fn = httpsCallable<object, ReportData>(functions, 'getReportData')
    fn({}).then(r => { setData(r.data); setLoading(false) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Failed to load report data.'); setLoading(false) })
  }, [sessionReady])

  const [active, setActive] = useState<ReportKind | null>(null)
  const [activeExport, setActiveExport] = useState<{ title: string; text: string } | null>(null)
  const chartRef = useRef<SVGSVGElement>(null)

  const rows = data?.rows ?? []
  const groupReports = data?.groupReports ?? []
  const timeSeries = data?.timeSeries ?? []
  const questions = data?.questions ?? []

  const openProjector = () => {
    const svg = chartRef.current
    if (!svg) return
    const w = window.open('', '_blank')
    if (w) { w.document.write(`<!doctype html><title>Price over time</title><body style="margin:0;display:flex;justify-content:center">${svg.outerHTML}</body>`); w.document.close() }
  }

  const tiles: ReportTileConfig[] = [
    {
      id: 'group-summary', title: 'Group summary — one row per auction',
      preview: <span style={{ fontSize: '0.9rem', color: '#555' }}>{groupReports.length} group{groupReports.length !== 1 ? 's' : ''}</span>,
      onOpen: () => setActive('group'), disabled: groupReports.length === 0, actionLabel: 'Open ↗',
    },
    {
      id: 'price-chart', title: 'Price over time — by group',
      preview: <span style={{ fontSize: '0.9rem', color: '#555' }}>{timeSeries.length} auction line{timeSeries.length !== 1 ? 's' : ''}</span>,
      onOpen: () => setActive('chart'), disabled: timeSeries.length === 0, actionLabel: 'Open ↗',
    },
    {
      id: 'per-student', title: 'Per-student report (profit + grade)',
      preview: <span style={{ fontSize: '0.9rem', color: '#555' }}>{rows.length} student{rows.length !== 1 ? 's' : ''} finalized</span>,
      onOpen: () => setActive('student'), disabled: rows.length === 0, actionLabel: 'Open ↗',
    },
    ...questions.map(q => {
      const roleLabel = ROLE_LABELS[q.role_target] ?? q.role_target
      const tileTitle = `${roleLabel}: ${q.prompt}`
      const qRows: AiTextRow[] = rows.filter(r => r.role === q.role_target && r.text_answers[q.field])
        .map(r => ({ name: r.display_name, raw_score: r.participation, answer: r.text_answers[q.field] }))
      const text = buildStudentTextExport(tileTitle, qRows)
      return {
        id: q.field, title: tileTitle,
        preview: qRows.length === 0
          ? <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No responses yet.</span>
          : <span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#111' }}>{qRows.length} response{qRows.length !== 1 ? 's' : ''}</span>,
        onOpen: () => setActiveExport({ title: tileTitle, text }), disabled: rows.length === 0, actionLabel: 'Open ↗',
      } satisfies ReportTileConfig
    }),
  ]

  if (authError) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}><p style={{ color: '#c00' }}>{authError}</p></div>
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <GameHeader />
      <div style={{ padding: '1rem 1.5rem 0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button onClick={() => navigate(makeLink('/dashboard'))} style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '0.3rem 0.8rem', cursor: 'pointer', fontSize: '0.85rem' }}>← Dashboard</button>
        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Reports — eBay</h2>
      </div>

      <main style={{ flex: 1, padding: '1rem 1.5rem' }}>
        {error && <p style={{ color: '#c00', marginBottom: '1rem' }}>{error}</p>}
        {loading && !data && <p style={{ color: '#888' }}>Loading…</p>}
        <ReportBoard tiles={tiles} />
      </main>

      {/* Report 1 — group summary */}
      {active === 'group' && (
        <Modal title="Group summary — one row per auction" wide onClose={() => setActive(null)}>
          <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 14rem)', border: '1px solid #ddd', borderRadius: 6 }}>
            <SortableTable<GroupReport, GroupSortKey>
              rows={groupReports} columns={GROUP_COLUMNS}
              getRowKey={r => r.group_id} initialSortKey="group"
              emptyMessage="No auctions yet." wrapHeaders />
          </div>
        </Modal>
      )}

      {/* Report 2 — price over time */}
      {active === 'chart' && (
        <Modal title="Price over time — by group (elapsed seconds)" wide onClose={() => setActive(null)}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
            <button onClick={openProjector} style={{ fontSize: '0.85rem', padding: '0.3rem 0.75rem' }}>Open in projector ↗</button>
          </div>
          <div data-testid="price-chart" style={{ overflowX: 'auto' }}>
            <PriceOverTimeSVG series={timeSeries} svgRef={chartRef} />
          </div>
          <p style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.75rem' }}>
            X axis is elapsed seconds from each group&apos;s own auction start (0 → duration), so lines overlay for
            comparison. The staircase reflects the price holding flat between bids and jumping at each bid — a tall late
            step is a snipe.
          </p>
        </Modal>
      )}

      {/* Report 3 — per-student */}
      {active === 'student' && (
        <Modal title="Per-student report" wide onClose={() => setActive(null)}>
          <p style={{ fontSize: '0.85rem', color: '#444', margin: '0 0 0.75rem' }}>
            <strong>Outcome</strong> and <strong>Profit</strong> are game results — <em>not</em> grades. The grade is
            <strong> Participation</strong> (present = 1) + <strong>KC score</strong>. Profit never enters the grade.
          </p>
          <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 16rem)', border: '1px solid #ddd', borderRadius: 6 }}>
            <SortableTable<StudentReportRow, StudentSortKey>
              rows={rows} columns={STUDENT_COLUMNS}
              getRowKey={r => r.participant_id} initialSortKey="group"
              roleLabels={ROLE_LABELS} getRowRole={r => r.role}
              emptyMessage="No finalized participants yet." wrapHeaders />
          </div>
        </Modal>
      )}

      {activeExport && <ExportModal title={activeExport.title} text={activeExport.text} onClose={() => setActiveExport(null)} />}
    </div>
  )
}
