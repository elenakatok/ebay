// ═══════════════════════════════════════════════════════════════════════════════
// AUCTION RESULTS — the generic, parameterized full-reveal / debrief screen.
//
// DOMAIN-FREE (extraction candidate). No eBay word: item name, "resale", the
// winner's-curse copy, and the "(exact)" expert annotation all arrive via `labels`
// (see ../ebayAuctionLabels.tsx). This is where the winner's curse LANDS, so a
// negative profit is rendered unmistakably (red, a real minus sign).
//
// The reveal data is handed in whole (`result`) — the component reads no confidential
// source. Maxes and the true common value are already revealable at close (copied
// server-side into auction_result); this screen just displays them.
// ═══════════════════════════════════════════════════════════════════════════════

import type { AuctionHistoryRow } from './AuctionBidding'

export interface AuctionResultBidder {
  bidderIndex: number
  signal: number
  privateValue: number
  signalHalfWidth: number      // 0 ⇒ expert (their signal is exact)
  maxAmount: number | null     // null ⇒ never bid → dash
  realizedValue: number
  profit: number
}

export interface AuctionResult {
  winnerBidderIndex: number | null
  clearingPrice: number | null
  vCommon: number
  perBidder: AuctionResultBidder[]
  resolvedAtMs: number
}

export interface AuctionResultsLabels {
  title: string
  headline: (winnerLabel: string | null, clearingPrice: number | null) => string
  youWon: string
  youLost: string
  youDidNotBid: string
  yourProfitLabel: string
  trueValueReveal: (vCommon: number) => React.ReactNode
  tableCols: { bidder: string; estimate: string; useValue: string; maxBid: string; trueValue: string; profit: string }
  estimateCell: (signal: number, isExpert: boolean) => string
  historyHeading: string
  historyCols: { bidder: string; bid: string; time: string }
  /** Plain-language debrief line (winner's curse / profit / no-sale). eBay copy. */
  summaryText: (result: AuctionResult) => React.ReactNode
}

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
// Signed money with a REAL minus sign so a loss is unmistakable: −$151, not $-151.
const signedMoney = (n: number) => (n < 0 ? '−$' + Math.abs(Math.round(n)).toLocaleString('en-US') : '$' + Math.round(n).toLocaleString('en-US'))

function clockTime(atMs: number): string {
  const d = new Date(atMs)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export interface AuctionResultsProps {
  labels: AuctionResultsLabels
  result: AuctionResult
  myBidderIndex: number
  bidderLabel: (bidderIndex: number) => string
  history: AuctionHistoryRow[]
}

export default function AuctionResults({ labels, result, myBidderIndex, bidderLabel, history }: AuctionResultsProps) {
  const { winnerBidderIndex, clearingPrice, vCommon, perBidder } = result
  const winnerLabel = winnerBidderIndex !== null ? bidderLabel(winnerBidderIndex) : null
  const me = perBidder.find(b => b.bidderIndex === myBidderIndex)
  const iWon = winnerBidderIndex !== null && winnerBidderIndex === myBidderIndex
  const iBid = me?.maxAmount != null

  const cell: React.CSSProperties = { padding: '0.4rem 0.6rem', borderBottom: '1px solid #e3e3e3', textAlign: 'right', whiteSpace: 'nowrap' }
  const cellL: React.CSSProperties = { ...cell, textAlign: 'left' }

  return (
    <main data-testid="auction-results" style={{ maxWidth: 820, margin: '0 auto', padding: '1rem 1.25rem' }}>
      {/* 1 — Headline */}
      <h1 data-testid="results-headline" data-winner={winnerBidderIndex ?? ''} data-clearing={clearingPrice ?? ''}
          style={{ marginTop: 0, fontSize: '1.5rem' }}>
        {labels.headline(winnerLabel, clearingPrice)}
      </h1>
      <div
        data-testid="results-you"
        data-won={iWon ? 'true' : 'false'}
        style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem', color: iWon ? '#137333' : '#444' }}
      >
        {iWon ? labels.youWon : iBid ? labels.youLost : labels.youDidNotBid}
        {me && (
          <span data-testid="results-my-profit" data-profit={me.profit} style={{ marginLeft: '0.75rem', color: me.profit < 0 ? '#c5221f' : '#137333' }}>
            {labels.yourProfitLabel} <strong>{signedMoney(me.profit)}</strong>
          </span>
        )}
      </div>

      {/* 2 — THE REVEAL */}
      <div
        data-testid="results-reveal"
        data-true-value={vCommon}
        style={{ background: '#fffbe6', border: '2px solid #f0c000', borderRadius: 8, padding: '0.75rem 1rem', margin: '0.5rem 0 1rem', fontSize: '1.15rem' }}
      >
        {labels.trueValueReveal(vCommon)}
      </div>

      {/* 3 — The full reveal table */}
      <div style={{ overflowX: 'auto', marginBottom: '1rem' }}>
        <table data-testid="results-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr>
              <th style={{ ...cellL, color: '#666' }}>{labels.tableCols.bidder}</th>
              <th style={{ ...cell, color: '#666' }}>{labels.tableCols.estimate}</th>
              <th style={{ ...cell, color: '#666' }}>{labels.tableCols.useValue}</th>
              <th style={{ ...cell, color: '#666' }}>{labels.tableCols.maxBid}</th>
              <th style={{ ...cell, color: '#666' }}>{labels.tableCols.trueValue}</th>
              <th style={{ ...cell, color: '#666' }}>{labels.tableCols.profit}</th>
            </tr>
          </thead>
          <tbody>
            {perBidder.map(b => {
              const isWinner = winnerBidderIndex !== null && b.bidderIndex === winnerBidderIndex
              const isExpert = b.signalHalfWidth === 0
              const neg = b.profit < 0
              return (
                <tr
                  key={b.bidderIndex}
                  data-testid="results-row"
                  data-bidder={b.bidderIndex}
                  data-max={b.maxAmount ?? ''}
                  data-profit={b.profit}
                  data-won={isWinner ? 'true' : 'false'}
                  style={{ background: isWinner ? '#e6f4ea' : b.bidderIndex === myBidderIndex ? '#f2f6ff' : 'transparent', fontWeight: isWinner ? 700 : 400 }}
                >
                  <td style={cellL}>{bidderLabel(b.bidderIndex)}{isWinner ? ' — WON' : ''}</td>
                  <td style={cell}>{labels.estimateCell(b.signal, isExpert)}</td>
                  <td style={cell}>{money(b.privateValue)}</td>
                  <td style={cell}>{b.maxAmount != null ? money(b.maxAmount) : '—'}</td>
                  <td style={cell}>{money(b.realizedValue)}</td>
                  <td style={{ ...cell, color: neg ? '#c5221f' : '#137333', fontWeight: neg ? 800 : 400 }}>
                    {signedMoney(b.profit)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 4 — Plain-language debrief line */}
      <div data-testid="results-summary" style={{ background: '#f6f8fa', border: '1px solid #d0d7de', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem', lineHeight: 1.5 }}>
        {labels.summaryText(result)}
      </div>

      {/* 5 — Bid history (static; one row per submitted bid; never a losing max) */}
      <section>
        <div style={{ fontWeight: 700, marginBottom: '0.4rem' }}>{labels.historyHeading}</div>
        <table data-testid="results-history" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr>
              <th style={{ ...cellL, color: '#666' }}>{labels.historyCols.bidder}</th>
              <th style={{ ...cell, color: '#666' }}>{labels.historyCols.bid}</th>
              <th style={{ ...cell, color: '#666' }}>{labels.historyCols.time}</th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 ? (
              <tr><td style={cellL} colSpan={3}>—</td></tr>
            ) : (
              history.map(row => (
                <tr key={row.key}>
                  <td style={cellL}>{bidderLabel(row.bidderIndex)}</td>
                  <td style={cell}>{money(row.amount)}</td>
                  <td style={cell}>{clockTime(row.atMs)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  )
}
