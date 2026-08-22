/**
 * Durable command-source validation and actor projection.
 * @module @deepseek-ai/dsh-commands/codec
 */

import { snapshotInteractionActor } from '@deepseek-ai/dsh-user-approval/actor'
import type { InteractionActor } from '@deepseek-ai/dsh-user-approval/types'
import type { CommandSource } from './types.ts'

/**
 * Return the host-attested actor carried by an interaction source.
 * @param source - one closed command source.
 * @returns its actor, or undefined for legacy/unattributed sources.
 */
export function interactionActorFromCommandSource(source: CommandSource): InteractionActor | undefined {
  return source.kind === 'interaction' ? source.actor : undefined
}

/**
 * Return whether a durable command source uses one accepted closed record.
 * @param value - candidate durable source.
 * @returns whether the value matches the closed source vocabulary.
 */
export function isCommandSource(value: unknown): value is CommandSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!Object.hasOwn(record, 'kind')) return false
  if (record.kind === 'user' || record.kind === 'unattributed') {
    return Object.keys(record).length === 1
  }
  return record.kind === 'interaction'
    && Object.keys(record).length === 2
    && Object.hasOwn(record, 'actor')
    && snapshotInteractionActor(record.actor) !== undefined
}
