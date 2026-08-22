/**
 * Interaction-actor durable codec and actor-qualified grant predicates.
 * @module @deepseek-ai/dsh-user-approval/actor
 */

import type {
  ApprovalDecision,
  ApprovalOutcome,
  InteractionActor,
  RequiredInteractionActor,
} from './types.ts'

/**
 * Return whether an actor satisfies one required actor kind.
 * @param actor - actor attached by a trusted Host ingress, when present.
 * @param requirement - actor kind demanded by the requesting consumer.
 * @returns whether no requirement exists or the actor has its exact kind.
 */
export function actorSatisfiesRequirement(
  actor: InteractionActor | undefined,
  requirement: RequiredInteractionActor | undefined,
): boolean {
  return requirement === undefined || actor?.kind === requirement
}

/**
 * Return whether a persisted decision is an actor-qualified one-shot grant.
 * @param decision - durable or replay-projected approval decision.
 * @param requirement - actor kind required for authority.
 * @returns whether the outcome grants once and its actor satisfies the requirement.
 */
export function isActorQualifiedApprovalGrant(
  decision: Pick<ApprovalDecision, 'outcome' | 'decidedBy'> | { readonly outcome: ApprovalOutcome; readonly decidedBy?: InteractionActor },
  requirement: RequiredInteractionActor,
): boolean {
  return decision.outcome === 'allowed-once' && actorSatisfiesRequirement(decision.decidedBy, requirement)
}

/**
 * Validate, detach, and freeze one actor before it reaches durable state.
 * @param value - untrusted candidate actor.
 * @returns the closed frozen snapshot, or undefined for any malformed value.
 */
export function snapshotInteractionActor(value: unknown): InteractionActor | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  try {
    const record = readRecordOnce(value as Record<string, unknown>)
    switch (record.values.kind) {
      case 'interactive-user': {
        const principalId = optionalIdentity(record, 'principalId', ['kind', 'channel', 'principalId'])
        const channel = record.values.channel
        if (principalId === INVALID_IDENTITY || (channel !== 'web' && channel !== 'cli')) return undefined
        return Object.freeze({
          kind: 'interactive-user' as const,
          channel,
          ...principalId === undefined ? {} : { principalId },
        })
      }
      case 'external-client': {
        const clientId = optionalIdentity(record, 'clientId', ['kind', 'channel', 'clientId'])
        const channel = record.values.channel
        if (clientId === INVALID_IDENTITY || (channel !== 'api' && channel !== 'acp')) return undefined
        return Object.freeze({
          kind: 'external-client' as const,
          channel,
          ...clientId === undefined ? {} : { clientId },
        })
      }
      case 'automation': {
        const provider = requiredIdentity(record, 'provider', ['kind', 'provider'])
        return provider === undefined ? undefined : Object.freeze({ kind: 'automation' as const, provider })
      }
      case 'policy': {
        const policy = requiredIdentity(record, 'policy', ['kind', 'policy'])
        return policy === undefined ? undefined : Object.freeze({ kind: 'policy' as const, policy })
      }
      case 'system':
        return exactKeys(record, ['kind']) ? Object.freeze({ kind: 'system' as const }) : undefined
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

/**
 * Return whether a durable value is one closed interaction actor record.
 * @param value - candidate durable value.
 * @returns whether a detached actor snapshot can be produced.
 */
export function isInteractionActor(value: unknown): value is InteractionActor {
  return snapshotInteractionActor(value) !== undefined
}

const INVALID_IDENTITY = Symbol('invalid interaction actor identity')

interface RecordSnapshot {
  readonly keys: readonly string[]
  readonly values: Readonly<Record<string, unknown>>
}

/** Read every enumerable own field exactly once before interpreting any value. */
function readRecordOnce(record: Record<string, unknown>): RecordSnapshot {
  const keys = Object.keys(record)
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys) values[key] = record[key]
  return { keys, values }
}

function optionalIdentity(
  record: RecordSnapshot,
  key: 'principalId' | 'clientId',
  keys: readonly string[],
): string | undefined | typeof INVALID_IDENTITY {
  const present = record.keys.includes(key)
  if (!exactKeys(record, present ? keys : keys.filter(candidate => candidate !== key))) return INVALID_IDENTITY
  if (!present) return undefined
  const value = record.values[key]
  return validIdentity(value) ? value : INVALID_IDENTITY
}

function requiredIdentity(record: RecordSnapshot, key: 'provider' | 'policy', keys: readonly string[]): string | undefined {
  const value = record.values[key]
  return exactKeys(record, keys) && validIdentity(value) ? value : undefined
}

function exactKeys(record: RecordSnapshot, keys: readonly string[]): boolean {
  return record.keys.length === keys.length && record.keys.every(key => keys.includes(key))
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !value.includes('\0')
}
