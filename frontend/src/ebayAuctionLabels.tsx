// ═══════════════════════════════════════════════════════════════════════════════
// eBay AUCTION — the DOMAIN copy layer for the generic AuctionBidding component.
//
// Every eBay word lives here: the item, the French-horn image, the "Bidder N
// (Expert)" labels, the private-information wording, the proxy explainer, and the
// personal-event sentences. The generic component (auction/AuctionBidding.tsx) reads
// this; it contains none of it. When the auction engine is extracted, THIS file
// stays behind in eBay and the component moves out clean.
//
// The private-information panel is rendered here (from the student's OWN endowment)
// and handed to the component as an opaque ReactNode. The confidential common value
// reaches the client ONLY as the EXPERT's own endowment.signal — never for a
// non-expert, never from truth/, never in a shared payload.
// ═══════════════════════════════════════════════════════════════════════════════

import type { AuctionLabels } from './auction/AuctionBidding'

/** The student's own, client-readable endowment (participant doc `auction_endowment`). */
export interface EbayEndowment {
  bidderIndex: number
  signal: number
  privateValue: number
  signalHalfWidth: number   // 0 ⇒ this bidder is the expert (signal IS the truth)
}

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

/** In-auction label for a bidder slot. Bidder 1 is openly the expert (a deliberate leak). */
export function ebayBidderLabel(bidderIndex: number): string {
  return bidderIndex === 1 ? 'Bidder 1 (Expert)' : `Bidder ${bidderIndex}`
}

/** Fat-finger guard: confirm a bid that is > 2× the current bid AND at least $10,000 —
 *  a five-figure bid on a horn worth ~$2,650 is almost certainly an extra-zero typo. */
export const EBAY_CONFIRM = { multiple: 2, floor: 10_000 }

export const ebayAuctionLabels: AuctionLabels = {
  itemName: 'Vintage French Horn',
  itemImageUrl: '/frenchHorn.jpg',
  winning: 'YOU ARE WINNING',
  notWinning: 'YOU ARE NOT WINNING',
  noBids: 'No bids yet',
  currentBidLabel: 'Current bid',
  timeLeftLabel: 'Time left',
  biddersLabel: (n) => `${n} bidders in this auction`,
  closedTitle: 'Auction closed.',
  closedSubtext: 'Results coming.',
  privateInfoHeading: 'Your private information',
  placeBidHeading: 'Place your bid',
  maxFieldLabel: 'Your maximum bid',
  minHint: (nextMin) => `Enter ${money(nextMin)} or more`,
  placeBidButton: 'Place bid',
  proxyExplainer: (
    <span>
      <strong>This is your maximum.</strong> The system bids for you only as much as needed
      to stay ahead — <strong>you may pay less than your maximum</strong>. <strong>No one else can see it.</strong>
    </span>
  ),
  bindingNote: <span>Bids are <strong>binding</strong>. You cannot lower or withdraw a bid.</span>,
  confirmTitle: 'Are you sure?',
  confirmBody: (amount, currentAmount) => (
    <span>
      You&apos;re about to bid <strong>{money(amount)}</strong>. The current bid is {money(currentAmount)}.
      Bids are <strong>binding and cannot be lowered or withdrawn.</strong>
    </span>
  ),
  confirmYes: 'Yes, place bid',
  confirmCancel: 'Cancel',
  historyHeading: 'Bid history',
  historyCols: { bidder: 'Bidder', bid: 'Bid', time: 'Time' },
  msgTookLead: (amount) => `You are winning at ${money(amount)}.`,
  msgDefended: (amount) => `A competing bid raised your bid to ${money(amount)}. You are still winning.`,
  msgOutbid: (leaderLabel, amount, lowerBound) =>
    `You were outbid. ${leaderLabel} is winning at ${money(amount)}. ` +
    `Their maximum is at least ${money(lowerBound)} — you don't know how much more.`,
}

/** Render the always-visible private-info panel from the student's OWN endowment. */
export function ebayPrivateInfo(e: EbayEndowment): React.ReactNode {
  const isExpert = e.signalHalfWidth === 0
  const line: React.CSSProperties = { margin: '0.2rem 0' }
  if (isExpert) {
    return (
      <div>
        <p style={{ ...line, fontWeight: 700 }}>You are the expert.</p>
        <p style={line}>The resale value is <strong>{money(e.signal)}</strong> — you know this exactly.</p>
        <p style={line}>Your private use value: <strong>{money(e.privateValue)}</strong>.</p>
        <p style={line}>If you win, the horn is worth <strong>{money(e.signal + e.privateValue)}</strong> to you.</p>
      </div>
    )
  }
  return (
    <div>
      <p style={line}>Your estimate of the resale value: <strong>{money(e.signal)}</strong></p>
      <p style={line}>The true resale value is within <strong>{money(e.signalHalfWidth)}</strong> of your estimate.</p>
      <p style={line}>Your private use value: <strong>{money(e.privateValue)}</strong> — this is yours alone and you know it exactly.</p>
      <p style={line}>
        If you win, the horn is worth: <em>your estimate is uncertain</em> — the true resale value
        plus your {money(e.privateValue)} use value.
      </p>
    </div>
  )
}
