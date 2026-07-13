import type { Outcome, OutcomeSchema, RoleConfig } from '@mygames/game-engine'
import type { GameDefinition } from '@mygames/game-server'

// ═══════════════════════════════════════════════════════════════════════════════
// eBay — SINGLE-ROLE game (Part 3, Slice 2 redesign).
//
// There is ONE role: `bidder`. Expertise is NOT an identity — it is an information
// endowment assigned at MATCH time (assignEndowments trigger): whoever draws
// bidderIndex 1 IS the expert. Students launch, do prep, and attend as generic
// bidders and do not learn they are the expert until the auction begins.
//
// PLACEHOLDER outcome form + STUB scoring remain (replaced by the live auction in
// later Part 3 slices). KC is reflection-only for now — the graded role-gate KC was
// removed with the single-role move (Gary's real graded content is still pending).
// ═══════════════════════════════════════════════════════════════════════════════

// ── Role config (ONE role — `bidder`) ─────────────────────────────────────────

export const ebayConfig: RoleConfig = {
  roles: [
    { key: 'bidder', label: 'Bidder', short: 'B' },
  ],
}

// ── Outcome schema (PLACEHOLDER — single dummy field; replaced by the auction) ──
// Key 'price' matches exactly what computeRawScore / computeScoreBreakdown read.
export const ebaySchema: OutcomeSchema = [
  { key: 'price', type: 'decimal', min: 0, max: 10000, step: 1 },  // placeholder final price ($)
  { key: 'notes', type: 'text' },  // optional free-text; blank = '', excluded from scoring
]

// ── Score sense (value-sense — real scoring in Part 3) ────────────────────────

export const ebayScoreSense: Record<string, 'value' | 'cost'> = {
  bidder: 'value',
}

// ── Scoring (STUB — placeholder; real value model in Part 3) ──────────────────
// Both roles value-sense. A no-deal (null outcome) scores 0 and stays in the
// scored pool; a true no-show (raw null, z = −2) is handled by finalize, not here.
// The placeholder simply echoes the reported price so the z-score pipeline has a
// real distribution to normalize end-to-end. NOTE: the real game does NOT grade on
// profit — it grades on participation + KC only (spec §7) — so this stub is purely
// to prove the finalize/push wiring, and is discarded in Part 3.

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

export function computeScoreBreakdown(
  roleKey: string,
  outcome: Outcome | null,
  _configData?: Record<string, unknown>,
): { value_or_cost: number; raw_score: number } {
  // Walk-away / no-deal: zero surplus, stays in the scored pool.
  if (outcome === null) return { value_or_cost: 0, raw_score: 0 }

  const price = Number(outcome['price'] ?? 0)

  if (roleKey === 'bidder') {
    return { value_or_cost: round3(price), raw_score: round3(price) }
  }
  return { value_or_cost: 0, raw_score: 0 }
}

export function computeRawScore(
  roleKey: string,
  outcome: Outcome | null,
  configData?: Record<string, unknown>,
): number {
  return computeScoreBreakdown(roleKey, outcome, configData).raw_score
}

// ── GameDefinition ────────────────────────────────────────────────────────────

export const ebayGameDef: GameDefinition = {
  game_id: 'ebay',
  roles:   ebayConfig,
  scoreSense: ebayScoreSense,
  composition: { bidder: 4 },
  outcomeSchema: ebaySchema,
  computeRawScore,
  computeScoreBreakdown,
  // reservations: PLACEHOLDER — real values in Part 3
  reservations: { bidder: 0 },
  corsOrigins: ['https://ebay.mygames.live'],
  classroom: { callbackSecretId: 'ebay_v1' },

  // Single-role sizing (spec §2b): base group is {bidder:4}; perRoleCap 7 lets one
  // group absorb the remainder up to size 7, so the shared matcher realizes the
  // 4/5-else-oversize tiling for every turnout ≥ 4 (see auction/grouping.ts
  // planGroupSizes — 6→[6], 7→[7], 11→[6,5], 9→[5,4], never <4 unless turnout <4,
  // never >7). The endowment table defines exactly 7 bidder slots (ebayAuction.ts).
  perRoleCap: 7,
  // deadlockThreshold omitted → 5

  // Settings page config fields (ONE role — `bidder`; real sheet URLs in Part 2/3).
  configFields: [
    { key: 'bidder_role_name',         kind: 'string',      default: 'Bidder' },
    { key: 'bidder_reservation_price', kind: 'positiveInt', default: 0 },
    // ONE shared case/instructions PDF (the case text covers the whole auction).
    // Per-participant private numbers are NOT in the PDF — they come from the
    // endowment shown in-game at match time (Part 3).
    { key: 'bidder_sheet_url',         kind: 'url',         default: '/role-info/eBay.pdf' },
  ],

  // Info page links — keys must appear in configFields above
  roleInfoLinks: [
    { roleKey: 'bidder', links: [{ key: 'bidder_sheet_url', label: 'Role sheet' }] },
  ],

  // ── prepDefaults: reflection only ─────────────────────────────────────────────
  // The single-role move removed the KC role gate. The shared KC flow is
  // gate-driven (the KnowledgeCheck UI skips KC entirely with no gate, and the
  // graded-static submit requires the gate), so removing the gate also removes the
  // graded MC — KC is reflection-only until Gary's real graded content lands.
  // One ungraded free-response reflection for the `bidder` role remains.
  prepDefaults: [
    {
      field: 'prep_bidder_reflection', type: 'text', system: false,
      category: 'preparation', format: 'text', role_target: 'bidder',
      prompt: 'PLACEHOLDER reflection (real prompt in Part 2): what is your going-in strategy?',
      placeholder: '', order: 20, hidden: false, deletable: true,
    },
  ],

  // Legacy stub fields — must be present but content served via prepDefaults above
  content: {
    infoPDFs:      {} as Record<string, { private: string; public?: string }>,
    kcQuestions:   [],
    prepQuestions: [],
    scenarioText:  {},
  },
}
