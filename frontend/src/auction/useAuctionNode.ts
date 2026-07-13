// ═══════════════════════════════════════════════════════════════════════════════
// useAuctionNode — generic live subscription to a group's auction RTDB node.
//
// Domain-free. Reads ONLY (clients never write to auctions/**; rules enforce it).
// Subscribes to `auctions/{instanceId}/{groupId}` plus `.info/serverTimeOffset` so
// the consumer can render a countdown against the SERVER clock. Converts the raw
// history map into a sorted, typed row array. Returns null until the node exists.
// ═══════════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react'
import { ref, onValue, type Database } from 'firebase/database'
import type { AuctionLive, AuctionHistoryRow } from './AuctionBidding'

interface RawStep { bidderIndex: number; amount: number; atMs: number }
interface RawNode {
  status: 'open' | 'closed'
  currentAmount: number
  highBidderIndex: number | null
  startedAtMs: number
  endsAtMs: number
  increment: number
  history?: Record<string, RawStep>
}

function toLive(raw: RawNode): AuctionLive {
  const history: AuctionHistoryRow[] = Object.entries(raw.history ?? {})
    .map(([key, s]) => ({ key, bidderIndex: s.bidderIndex, amount: s.amount, atMs: s.atMs }))
    .sort((a, b) => (a.atMs - b.atMs) || a.key.localeCompare(b.key))
  return {
    status: raw.status,
    currentAmount: raw.currentAmount ?? 0,
    highBidderIndex: raw.highBidderIndex ?? null,
    startedAtMs: raw.startedAtMs,
    endsAtMs: raw.endsAtMs,
    increment: raw.increment ?? 1,
    history,
  }
}

export function useAuctionNode(
  rtdb: Database,
  instanceId: string | null,
  groupId: string | null,
): { live: AuctionLive | null; serverOffsetMs: number } {
  const [live, setLive] = useState<AuctionLive | null>(null)
  const [serverOffsetMs, setServerOffsetMs] = useState(0)

  // Server-clock offset — measured once the connection settles; keeps the cosmetic
  // countdown honest even on a skewed client.
  useEffect(() => {
    const off = onValue(ref(rtdb, '.info/serverTimeOffset'), snap => {
      const v = snap.val()
      if (typeof v === 'number') setServerOffsetMs(v)
    })
    return () => off()
  }, [rtdb])

  // The per-group read rule only permits members ONCE the auction is open (the
  // auctionMembers index is written at startAuction). Subscribing earlier yields a
  // permission-denied that CANCELS the listener — so we retry until it opens, then the
  // successful listener persists (and fires on every price change through to close).
  useEffect(() => {
    if (!instanceId || !groupId) { setLive(null); return }
    let cancelled = false
    let off: () => void = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined

    const subscribe = () => {
      if (cancelled) return
      off = onValue(
        ref(rtdb, `auctions/${instanceId}/${groupId}`),
        snap => {
          const raw = snap.val() as RawNode | null
          setLive(raw ? toLive(raw) : null)
        },
        () => {
          // Denied (auction not open yet). Listener is cancelled — retry shortly.
          off = () => {}
          if (!cancelled) timer = setTimeout(subscribe, 1500)
        },
      )
    }
    subscribe()

    return () => { cancelled = true; off(); if (timer) clearTimeout(timer) }
  }, [rtdb, instanceId, groupId])

  return { live, serverOffsetMs }
}
