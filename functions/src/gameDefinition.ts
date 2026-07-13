import type { Outcome, OutcomeSchema, RoleConfig } from '@mygames/game-engine'
import type { GameDefinition } from '@mygames/game-server'

// ═══════════════════════════════════════════════════════════════════════════════
// eBay — SINGLE-ROLE game (Part 3).
//
// There is ONE role: `bidder`. Expertise is NOT an identity — it is an information
// endowment assigned at MATCH time (assignEndowments trigger): whoever draws
// bidderIndex 1 IS the expert. Students launch, do prep, and attend as generic
// bidders and do not learn they are the expert until the auction begins.
//
// GRADING (Part 3, Slice 6 — spec §7): PARTICIPATION + KC only. PROFIT IS NEVER
// GRADED. computeScoreBreakdown returns a FLAT participation point for every present
// bidder regardless of the auction outcome, so the single-role z-score pool is
// intentionally DEGENERATE (sample SD 0 → every present student normalizes to 0);
// true no-shows are handled by the engine (status no_show → −2), never here. Profit
// is a displayed game outcome / debrief payoff only — it never enters raw_score,
// normalized_score, or the gradebook.
//
// KC (Slice 6 — Option (b)): a single-option role gate ("What is your role?" →
// Bidder, which is always true for the single role, so it passes on the first click)
// plus Gary's 5 graded MC (kc_* fields, verbatim from eBay_KC_Questions_v1.md). The
// shared KC flow is gate-driven at BOTH ends (the KnowledgeCheck UI needs a gate
// question to render; the graded-static submit needs the gate's completed_at marker),
// so the gate is REQUIRED to grade — no shared-package change, no participant preset.
// KC score = correct statics / 5 (0.0–1.0), pushed to the gradebook as its OWN field.
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

// ── Scoring (Part 3, Slice 6 — PARTICIPATION only; profit NEVER graded) ────────
// Every PRESENT bidder earns the SAME flat participation point (1), independent of
// the auction outcome, the clearing price, and their profit. This is deliberate
// (spec §7): grading is participation + KC only. Consequences, all intended:
//   • The single-role z-score pool is DEGENERATE — every present raw is identical, so
//     sample SD = 0 and the engine's zero-SD guard normalizes every present student
//     to 0. A "suspiciously uniform" report is CORRECT, not broken.
//   • Profit has PROVABLY zero effect on the grade — the cursed winner (−$151) and a
//     losing bidder ($0) and a profitable winner all get the identical raw_score.
//   • There is no "walked away" state in eBay: a matched student who never bids is
//     PRESENT (still scores 1, stays in the pool). A true no-show (no role / never
//     matched) is handled by the engine (status no_show → raw null, z = −2), not here.
// The `outcome` argument is intentionally ignored for `bidder` — reading price/profit
// out of it would be exactly the leak §7 forbids.

export function computeScoreBreakdown(
  roleKey: string,
  _outcome: Outcome | null,
  _configData?: Record<string, unknown>,
): { value_or_cost: number; raw_score: number } {
  // Flat participation point for every present bidder — outcome-independent by design.
  if (roleKey === 'bidder') return { value_or_cost: 1, raw_score: 1 }
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
    // Live-auction knobs (AuctionSettings.durationSeconds / increment) — instructor
    // editable, read by startAuction at start time. Falls back to compiled defaults.
    { key: 'duration_seconds',         kind: 'positiveInt', default: 600 },
    { key: 'bid_increment',            kind: 'positiveInt', default: 1 },
    // ONE shared case/instructions PDF (the case text covers the whole auction).
    // Per-participant private numbers are NOT in the PDF — they come from the
    // endowment shown in-game at match time (Part 3).
    { key: 'bidder_sheet_url',         kind: 'url',         default: '/role-info/eBay.pdf' },
  ],

  // Info page links — keys must appear in configFields above
  roleInfoLinks: [
    { roleKey: 'bidder', links: [{ key: 'bidder_sheet_url', label: 'Role sheet' }] },
  ],

  // ── prepDefaults: KC gate + 5 graded statics + 1 ungraded reflection ──────────
  // Slice 6 (Option (b)). The gate (Q0) is a single-option role question — eBay has
  // ONE role, so "Bidder" is always the true answer and it passes on the first click;
  // it is graded 'assigned_role' (against the student's real role, server-side) and is
  // NOT part of the KC score. Q1–Q5 are Gary's graded MC (verbatim from
  // eBay_KC_Questions_v1.md): category 'knowledge_check', system false, grading
  // 'static', each with a locked correct_value. KC score = correct statics / 5.
  // Q3 uses the corrected 2×2 option set (the source PDF's duplicate distractor is
  // fixed); Q5 has 3 options (deliberate, per source). Option order shuffles per
  // student (getStudentPrepQuestions); explanations name the concept, never a slot.
  // One ungraded free-response reflection (category 'preparation') is kept so the
  // prep phase and the Reports text tile still have content — the source has none,
  // so this is a platform-standard participation prompt, not from Gary's canvas.
  prepDefaults: [
    // ── Q0: role gate (system, ungraded — single option; always passes) ──────────
    {
      field: 'kc_gate_bidder', type: 'mc', system: true,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'assigned_role', role_target: 'bidder',
      prompt: 'What is your role in this auction?',
      placeholder: '', order: 0, hidden: false, deletable: false,
      options: [
        { value: 'bidder', label: 'Bidder' },
      ],
      explanation: 'You are a Bidder in the French horn auction.',
    },

    // ── Q1: private value vs. common value (graded) ──────────────────────────────
    {
      field: 'kc_private_vs_common', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'private_learn_nothing', role_target: 'bidder',
      prompt: 'According to the reading "Bidding in Competition," the difference between a private-value auction and a common-value auction is:',
      placeholder: '', order: 1, hidden: false, deletable: false,
      options: [
        { value: 'common_more_bidders',   label: 'Common-value auctions attract more bidders.' },
        { value: 'private_negotiations',  label: 'Private-value auctions are better done as negotiations.' },
        { value: 'private_learn_nothing', label: "Private-value bidders learn nothing about the value of the item from learning others' bids." },
        { value: 'private_raise_more',    label: 'Private-value auctions raise more money from the bidders.' },
      ],
      explanation: 'A bidder has a private valuation when their value for the item is unaffected by what others think it is worth — so another bidder’s bid carries no information about it. In the common-value case, bidders all share the same underlying valuation but are typically uncertain what it is, so others’ bids are informative.',
    },

    // ── Q2: the information structure of this auction (graded) ────────────────────
    {
      field: 'kc_information_structure', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'expert_uncertain_use', role_target: 'bidder',
      prompt: 'In the French horn auction you will participate in:',
      placeholder: '', order: 2, hidden: false, deletable: false,
      options: [
        { value: 'all_uncertain',        label: 'All bidders have uncertain information about the resale value of the horn, as well as uncertain information about the private use values for the horn.' },
        { value: 'expert_knows_all',     label: "There is one expert bidder who knows the resale value of the horn for certain, and also knows each non-expert bidder's private use value for certain. There are also several non-experts who have uncertain information about the resale value but certain information about their own private use value." },
        { value: 'expert_uncertain_use', label: "There is one expert bidder who knows the resale value of the horn for certain but has uncertain information about the non-expert bidders' private use values. There are also several non-experts who have uncertain information about the resale value but certain information about their own private use value." },
        { value: 'seller',               label: 'You will be a seller looking to sell a French horn to the highest bidder.' },
      ],
      explanation: 'The expert knows the resale value exactly — that is the common component, identical for everyone. The expert does NOT know the non-experts’ private use values. Each non-expert is in the mirror position: uncertain about the resale value, but certain about their own use value.',
    },

    // ── Q3: second-price rules (graded; corrected 2×2 option set) ─────────────────
    {
      field: 'kc_second_price', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'highest_pays_second', role_target: 'bidder',
      prompt: 'The auction is "second price." This means the winner of the auction is:',
      placeholder: '', order: 3, hidden: false, deletable: false,
      options: [
        { value: 'second_pays_own',     label: 'The person who makes the second highest bid. They pay their own bid.' },
        { value: 'second_pays_highest', label: 'The person who makes the second highest bid. They pay the highest bid.' },
        { value: 'highest_pays_own',    label: 'The person who makes the highest bid. They pay their own bid.' },
        { value: 'highest_pays_second', label: 'The person who makes the highest bid. They pay the second highest bid.' },
      ],
      explanation: 'The highest bidder wins, but pays only what it took to beat the runner-up — the second highest bid (plus the increment). Winning and paying are decided by two different bids.',
    },

    // ── Q4: hard close (graded) ──────────────────────────────────────────────────
    {
      field: 'kc_hard_close', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'prespecified_time', role_target: 'bidder',
      prompt: 'The auction ends:',
      placeholder: '', order: 4, hidden: false, deletable: false,
      options: [
        { value: 'prespecified_time', label: 'At a pre-specified time.' },
        { value: 'no_buyer',          label: 'When no buyer wants to bid any further.' },
        { value: 'after_proxy',       label: 'After each bidder has entered a proxy bid.' },
        { value: 'seller_announces',  label: 'When the seller announces it is closed.' },
      ],
      explanation: 'This auction has a hard close — a fixed deadline set when the auction opens. It does not wait for bidding to go quiet, and the seller does not decide when to stop. The clock does. That is what makes last-moment bidding (sniping) a live strategic question.',
    },

    // ── Q5: what profit actually is (graded; 3 options, per source) ──────────────
    {
      field: 'kc_profit_definition', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'neither', role_target: 'bidder',
      prompt: 'The objective of non-expert buyers in this auction is to maximize their profit =',
      placeholder: '', order: 5, hidden: false, deletable: false,
      options: [
        { value: 'use_minus_price',    label: 'Use value − price paid' },
        { value: 'resale_minus_price', label: 'Resale value − price paid' },
        { value: 'neither',            label: 'Neither of the above' },
      ],
      explanation: 'Profit is use value + resale value − price paid. Both components count: the horn is worth its resale value and whatever it is worth to you personally. Dropping either one understates what winning is worth.',
    },

    // ── Ungraded reflection (participation only) ──────────────────────────────────
    {
      field: 'prep_bidder_reflection', type: 'text', system: false,
      category: 'preparation', format: 'text', role_target: 'bidder',
      prompt: 'Before the auction opens: what is your going-in strategy, and how will you guard against the winner’s curse?',
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
