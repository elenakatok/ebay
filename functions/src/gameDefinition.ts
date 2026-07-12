import type { Outcome, OutcomeSchema, RoleConfig } from '@mygames/game-engine'
import type { GameDefinition } from '@mygames/game-server'

// ═══════════════════════════════════════════════════════════════════════════════
// eBay — PART 1 SKELETON (blank canvas).
//
// This file carries eBay's REAL identity (game_id, 2 roles, composition) but a
// PLACEHOLDER outcome form + STUB scoring + STUB KC. The entire outcome/scoring
// layer is REPLACED by the live real-time auction in Part 3 — do not invest here.
// Real role-targeted KC + role PDFs arrive in Part 2 (Gary's content).
// ═══════════════════════════════════════════════════════════════════════════════

// ── Role config (2 roles — real) ──────────────────────────────────────────────

export const ebayConfig: RoleConfig = {
  roles: [
    { key: 'expert',    label: 'Expert',     short: 'E' },
    { key: 'nonexpert', label: 'Non-Expert', short: 'N' },
  ],
}

// ── Outcome schema (PLACEHOLDER — single dummy field; replaced by the auction) ──
// Key 'price' matches exactly what computeRawScore / computeScoreBreakdown read.
export const ebaySchema: OutcomeSchema = [
  { key: 'price', type: 'decimal', min: 0, max: 10000, step: 1 },  // placeholder final price ($)
  { key: 'notes', type: 'text' },  // optional free-text; blank = '', excluded from scoring
]

// ── Score sense (both value-sense — real scoring in Part 3) ───────────────────

export const ebayScoreSense: Record<string, 'value' | 'cost'> = {
  expert:    'value',
  nonexpert: 'value',
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

  if (roleKey === 'expert' || roleKey === 'nonexpert') {
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
  composition: { expert: 1, nonexpert: 3 },
  outcomeSchema: ebaySchema,
  computeRawScore,
  computeScoreBreakdown,
  // reservations: PLACEHOLDER — real values in Part 3
  reservations: { expert: 0, nonexpert: 0 },
  corsOrigins: ['https://ebay.mygames.live'],
  classroom: { callbackSecretId: 'ebay_v1' },

  // perRoleCap = 4 → base group is {expert:1, nonexpert:3} (4 players); surplus
  // nonexperts fill to 4 per group, so a group can flex 4→5. This is the standard
  // shared matching path — the full 4↔5 remainder/flex rule and the small-class
  // (6/7/11) matching fallback are an OPEN item (spec §10), deliberately NOT built
  // in Part 1. TODO-Part-3: Elena to confirm the flex + small-class fallback.
  perRoleCap: 4,
  // deadlockThreshold omitted → 5

  // Settings page config fields (PLACEHOLDER — minimal; real sheet URLs in Part 2/3)
  configFields: [
    { key: 'expert_role_name',            kind: 'string',      default: 'Expert' },
    { key: 'nonexpert_role_name',         kind: 'string',      default: 'Non-Expert' },
    { key: 'expert_reservation_price',    kind: 'positiveInt', default: 0 },
    { key: 'nonexpert_reservation_price', kind: 'positiveInt', default: 0 },
    // Placeholder PDF URL fields — Elena drops real PDFs in public/role-info/ (Part 2)
    { key: 'expert_sheet_url',            kind: 'url',         default: '/role-info/expert.pdf' },
    { key: 'nonexpert_sheet_url',         kind: 'url',         default: '/role-info/nonexpert.pdf' },
  ],

  // Info page links — keys must appear in configFields above
  roleInfoLinks: [
    { roleKey: 'expert',    links: [{ key: 'expert_sheet_url',    label: 'Role sheet' }] },
    { roleKey: 'nonexpert', links: [{ key: 'nonexpert_sheet_url', label: 'Role sheet' }] },
  ],

  // ── prepDefaults: STUB KC (real role-targeted questions from Gary in Part 2) ──
  // Per role: Q1 role gate (system, assigned_role, ungraded) + 1 graded static MC
  // (denominator 1, role-filtered) + 1 ungraded free-response reflection.
  prepDefaults: [
    // ══ ROLE: expert ═════════════════════════════════════════════════════════
    {
      field: 'kc_gate_expert', type: 'mc', system: true,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'assigned_role', role_target: 'expert',
      prompt: 'What is your role in this auction?',
      placeholder: '', order: 0, hidden: false, deletable: false,
      options: [
        { value: 'expert',    label: 'Expert — you can appraise the item accurately' },
        { value: 'nonexpert', label: 'Non-Expert — you bid without expert appraisal' },
      ],
      explanation: 'You are the Expert. (Placeholder — Part 2 replaces this with Gary’s real role content.)',
    },
    {
      field: 'kc_expert_stub', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'a', role_target: 'expert',
      prompt: 'PLACEHOLDER knowledge-check question (real content in Part 2). Which option is marked correct in this stub?',
      placeholder: '', order: 10, hidden: false, deletable: false,
      options: [
        { value: 'a', label: 'This one (the stub’s correct answer).' },
        { value: 'b', label: 'Not this one.' },
        { value: 'c', label: 'Not this one either.' },
      ],
      explanation: 'This is a placeholder question so the KC flow has a graded item end-to-end; Part 2 replaces it.',
    },
    {
      field: 'prep_expert_reflection', type: 'text', system: false,
      category: 'preparation', format: 'text', role_target: 'expert',
      prompt: 'PLACEHOLDER reflection (real prompt in Part 2): what is your going-in strategy?',
      placeholder: '', order: 20, hidden: false, deletable: true,
    },

    // ══ ROLE: nonexpert ══════════════════════════════════════════════════════
    {
      field: 'kc_gate_nonexpert', type: 'mc', system: true,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'assigned_role', role_target: 'nonexpert',
      prompt: 'What is your role in this auction?',
      placeholder: '', order: 0, hidden: false, deletable: false,
      options: [
        { value: 'expert',    label: 'Expert — you can appraise the item accurately' },
        { value: 'nonexpert', label: 'Non-Expert — you bid without expert appraisal' },
      ],
      explanation: 'You are a Non-Expert. (Placeholder — Part 2 replaces this with Gary’s real role content.)',
    },
    {
      field: 'kc_nonexpert_stub', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'a', role_target: 'nonexpert',
      prompt: 'PLACEHOLDER knowledge-check question (real content in Part 2). Which option is marked correct in this stub?',
      placeholder: '', order: 10, hidden: false, deletable: false,
      options: [
        { value: 'a', label: 'This one (the stub’s correct answer).' },
        { value: 'b', label: 'Not this one.' },
        { value: 'c', label: 'Not this one either.' },
      ],
      explanation: 'This is a placeholder question so the KC flow has a graded item end-to-end; Part 2 replaces it.',
    },
    {
      field: 'prep_nonexpert_reflection', type: 'text', system: false,
      category: 'preparation', format: 'text', role_target: 'nonexpert',
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
