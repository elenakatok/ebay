import type { Outcome, OutcomeSchema, RoleConfig } from '@mygames/game-engine'
import type { GameDefinition, PrepTextQuestion } from '@mygames/game-server'

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
// plus 11 graded MC (kc_* fields, per eBay_KC_Questions_v2.md — 7 general auction-theory
// questions + 4 French-horn-case questions). The shared KC flow is gate-driven at BOTH ends
// (the KnowledgeCheck UI needs a gate question to render; the graded-static submit needs the
// gate's completed_at marker), so the gate is REQUIRED to grade — no shared-package change,
// no participant preset. KC score = correct statics / 11 (0.0–1.0; the shared grader counts
// grading:'static' dynamically), pushed to the gradebook as its OWN field.
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

// ── Graded-KC data-object helper ──────────────────────────────────────────────
// Every graded static question is built via gq() as a DATA OBJECT (the admin-defaults
// screen is a future addition and must stay small — never hand-write inline literals).
// grading 'static' + a locked correct_value keyed to option CONTENT (value), never a
// letter position (getStudentPrepQuestions shuffles the options per student).
const gq = (
  field: string, order: number, correct_value: string,
  prompt: string, options: { value: string; label: string }[], explanation: string,
): PrepTextQuestion => ({
  field, type: 'mc', system: false, category: 'knowledge_check', format: 'multiple_choice',
  grading: 'static', correct_value, role_target: 'bidder', prompt,
  placeholder: '', order, hidden: false, deletable: false, options, explanation,
})

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

  // ── prepDefaults: KC gate + 11 graded statics + 1 ungraded reflection ─────────
  // AUTHORITY: eBay_KC_Questions_v2.md (FINAL, supersedes v1's 5). The gate (Q0) is a
  // single-option role question — eBay has ONE role, so "Bidder" is always the true answer
  // and it passes on the first click; graded 'assigned_role' (server-side, against the real
  // role) and NOT part of the KC score. Q1–Q11 are graded MC built via gq() as DATA OBJECTS:
  //   • Q1–Q7  general auction theory (Gary's new questions; Q7 replaces v1's private-vs-common)
  //   • Q8–Q11 the French horn case (v1 Q2–Q5, unchanged)
  // KC score = correct statics / 11 (the shared grader counts grading:'static' dynamically —
  // no hardcoded denominator). Q9 (second price) keeps the corrected 2×2 option set — the
  // source's duplicate-distractor typo is gone (four DISTINCT options); Q11 has 3 options
  // (deliberate, per source). Options shuffle per student (getStudentPrepQuestions); grading
  // is content-keyed (option value), so source letter clustering is irrelevant. Explanations
  // name the concept, never a slot. PROFIT IS NEVER GRADED — Q11 asks the student to DEFINE
  // profit; it does not make their profit a grade. One ungraded reflection (participation) is
  // kept so the prep phase + Reports text tile still have content.
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

    // ── Part I — general auction theory (Q1–Q7) ──────────────────────────────────
    gq('kc_format_dimensions', 1, 'fmt_price_determined',
      'The auction video classifies auction formats along three dimensions. Which of the following is one of those three dimensions?',
      [
        { value: 'fmt_num_bidders',      label: 'The number of bidders allowed to participate' },
        { value: 'fmt_price_determined', label: 'How price is determined' },
        { value: 'fmt_venue',            label: 'Whether the auction is held online or in person' },
        { value: 'fmt_reserve',          label: 'The minimum reserve price set by the seller' },
      ],
      'The three dimensions are how bids are collected, bidder valuation type, and how price is determined. Note what is not on the list: venue, participant count, and reserve are parameters within a format, not ways of classifying formats.'),

    gq('kc_english_vs_sealed', 2, 'eng_observe_others',
      'In an English (ascending-bid) auction, compared to a sealed-bid auction, bidders:',
      [
        { value: 'eng_fixed_price',    label: 'pay a fixed price regardless of other bids' },
        { value: 'eng_observe_others', label: 'can observe the bids placed by others as the auction proceeds' },
        { value: 'eng_one_bid',        label: 'must submit only one bid before the auction opens' },
        { value: 'eng_know_winner',    label: 'know in advance who the winner will be' },
      ],
      'The distinction is information. In an ascending-bid auction you watch other bids arrive and can revise; in sealed-bid and Dutch auctions you cannot. Everything else about the formats follows from that one difference.'),

    gq('kc_dutch_auction', 3, 'dutch_high_falls',
      'In a Dutch (descending-bid) auction, such as the flower auction at Aalsmeer:',
      [
        { value: 'dutch_low_rises',    label: 'the price starts low and rises until a bidder accepts' },
        { value: 'dutch_sealed',       label: 'bidders submit sealed bids that are opened simultaneously' },
        { value: 'dutch_high_falls',   label: 'the price starts high and falls until a bidder stops the clock' },
        { value: 'dutch_second_price', label: 'the highest bidder pays the second-highest bid' },
      ],
      'The price descends from a high opening. The first bidder to stop the clock wins and pays that price. The consequence: you get one decision, and taking it early costs money while waiting risks losing the item entirely.'),

    gq('kc_second_price_truthful', 4, 'sp_true_value',
      "According to the video, in a second-price, sealed-bid auction, a bidder's best bid is:",
      [
        { value: 'sp_as_low',        label: 'as low as possible, to protect potential profit' },
        { value: 'sp_true_value',    label: 'exactly their true valuation' },
        { value: 'sp_average',       label: 'the average of what they expect others to bid' },
        { value: 'sp_above_highest', label: 'slightly above the highest valuation they think anyone could have' },
      ],
      "Your bid determines whether you win, not what you pay — the second-highest bid sets the price. Shading down only loses you auctions you wanted; bidding up only wins you auctions you didn't. Truthful bidding is a dominant strategy: right regardless of what anyone else does."),

    gq('kc_first_price_shading', 5, 'fp_below',
      "In a Dutch auction or a first-price sealed-bid auction, a bidder's optimal bid, compared to their true valuation, is typically:",
      [
        { value: 'fp_equal',     label: 'equal to the valuation' },
        { value: 'fp_below',     label: 'below the valuation (a "shave")' },
        { value: 'fp_above',     label: 'above the valuation' },
        { value: 'fp_unrelated', label: 'unrelated to the valuation' },
      ],
      'Here the winner pays their own bid — so bidding your true value guarantees zero profit even when you win. You shave below your valuation to leave a margin, trading a lower chance of winning against a better price when you do. This is exactly the tension second-price removes.'),

    gq('kc_revenue_equivalence', 6, 're_all_four',
      'Under the revenue equivalence result presented in the video, when bidders have private valuations, which auction formats yield the same expected revenue for the seller?',
      [
        { value: 're_english_dutch', label: 'Only English and Dutch auctions' },
        { value: 're_two_sealed',    label: 'Only the two sealed-bid formats (first-price and second-price)' },
        { value: 're_all_four',      label: 'English, Dutch, first-price sealed-bid, and second-price sealed-bid auctions' },
        { value: 're_none',          label: 'No two formats yield the same expected revenue' },
      ],
      'All four. Expected revenue equals the expected valuation of the second-highest bidder in every case. Bidding behavior differs wildly (truthful vs shaved) but the effects cancel exactly. This is why format choice must be justified on grounds other than revenue: speed, transparency, collusion-resistance, information leakage.'),

    gq('kc_private_vs_common', 7, 'private_learn_nothing',
      'The difference between a private-value auction and a common-value auction is:',
      [
        { value: 'common_more_bidders',   label: 'Common-value auctions attract more bidders.' },
        { value: 'private_negotiations',  label: 'Private-value auctions are better done as negotiations.' },
        { value: 'private_learn_nothing', label: "Private-value bidders learn nothing about the value of the item from learning others' bids." },
        { value: 'private_raise_more',    label: 'Private-value auctions raise more money from the bidders.' },
      ],
      "A bidder has a private valuation when their value is unaffected by what others think it's worth — so another's bid carries no information. In the common-value case, bidders share the same underlying valuation but are uncertain what it is, so others' bids are informative. That difference is the entire source of the winner's curse."),

    // ── Part II — the French horn case (Q8–Q11; v1 Q2–Q5, unchanged) ─────────────
    gq('kc_information_structure', 8, 'expert_uncertain_use',
      'In the French horn auction you will participate in:',
      [
        { value: 'all_uncertain',        label: 'All bidders have uncertain information about the resale value of the horn, as well as uncertain information about the private use values for the horn.' },
        { value: 'expert_knows_all',     label: "There is one expert bidder who knows the resale value of the horn for certain, and also knows each non-expert bidder's private use value for certain. There are also several non-experts who have uncertain information about the resale value but certain information about their own private use value." },
        { value: 'expert_uncertain_use', label: "There is one expert bidder who knows the resale value of the horn for certain but has uncertain information about the non-expert bidders' private use values. There are also several non-experts who have uncertain information about the resale value but certain information about their own private use value." },
        { value: 'seller',               label: 'You will be a seller looking to sell a French horn to the highest bidder.' },
      ],
      "The expert knows the resale value exactly — the common component, identical for everyone. The expert does not know the non-experts' private use values. Each non-expert is in the mirror position. This is a hybrid of Q7's two pure cases, which is what makes the auction interesting."),

    gq('kc_second_price', 9, 'highest_pays_second',
      'The auction is "second price." This means the winner of the auction is:',
      [
        { value: 'second_pays_own',     label: 'The person who makes the second highest bid. They pay their own bid.' },
        { value: 'second_pays_highest', label: 'The person who makes the second highest bid. They pay the highest bid.' },
        { value: 'highest_pays_own',    label: 'The person who makes the highest bid. They pay their own bid.' },
        { value: 'highest_pays_second', label: 'The person who makes the highest bid. They pay the second highest bid.' },
      ],
      'The highest bidder wins but pays only what it took to beat the runner-up. Winning and paying are decided by two different bids. That separation is the whole mechanism, and it is why truthful bidding is optimal.'),

    gq('kc_hard_close', 10, 'prespecified_time',
      'The auction ends:',
      [
        { value: 'prespecified_time', label: 'At a pre-specified time.' },
        { value: 'no_buyer',          label: 'When no buyer wants to bid any further.' },
        { value: 'after_proxy',       label: 'After each bidder has entered a proxy bid.' },
        { value: 'seller_announces',  label: 'When the seller announces it is closed.' },
      ],
      "This auction has a hard close — a fixed deadline set when the auction opens. It doesn't wait for bidding to go quiet, and the seller doesn't decide when to stop. The clock does. That's what makes sniping a live strategic question rather than a curiosity."),

    gq('kc_profit_definition', 11, 'neither',
      'The objective of non-expert buyers in this auction is to maximize their profit =',
      [
        { value: 'use_minus_price',    label: 'Use value − price paid' },
        { value: 'resale_minus_price', label: 'Resale value − price paid' },
        { value: 'neither',            label: 'Neither of the above' },
      ],
      'Profit is use value + resale value − price paid. Both components count. Dropping either one understates what winning is worth — and a bidder who drops one will systematically underbid.'),

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
