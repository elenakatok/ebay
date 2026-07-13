import { type RoleConfig } from '@mygames/game-engine/roles'
import { type OutcomeField, type OutcomeSchema } from '@mygames/game-engine/outcome'

export type { RoleConfig, OutcomeField, OutcomeSchema }

// SINGLE-ROLE — mirrors functions/src/gameDefinition.ts. One role `bidder`;
// expertise is an endowment assigned at match, not an identity. The outcome schema
// is a PLACEHOLDER (single dummy field); the live auction replaces it in Part 3.

export const ebayConfig: RoleConfig = {
  roles: [
    { key: 'bidder', label: 'Bidder', short: 'B' },
  ],
}

// Outcome schema — mirrors functions/src/gameDefinition.ts. Key 'price' matches scoring.
export const ebaySchema: OutcomeSchema = [
  { key: 'price', type: 'decimal', min: 0, max: 10000, step: 1 },  // placeholder final price ($)
  { key: 'notes', type: 'text' },  // optional free-text; blank = '', excluded from scoring
]

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  price: 'Final price ($)',
  notes: 'Notes',
}

export function formatField(field: OutcomeField, value: unknown): string {
  if (field.type === 'integer') return (value as number).toLocaleString('en-US')
  if (field.type === 'decimal') return (value as number).toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (field.type === 'enum')    return value as string
  if (field.type === 'boolean') return (value as boolean) ? 'Yes' : 'No'
  return String(value)
}
