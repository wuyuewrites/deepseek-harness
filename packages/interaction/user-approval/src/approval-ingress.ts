/**
 * Module-private opaque approval ingress state shared by the service and Host adapters.
 * @module @deepseek-ai/dsh-user-approval/approval-ingress
 */

import { symbols } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { snapshotInteractionActor } from './actor.ts'
import type { ApprovalRequest } from './index.ts'
import type { ApprovalOutcome, InteractionActor, OpaqueApprovalAnswer } from './types.ts'

const OUTCOMES: ReadonlySet<ApprovalOutcome> = new Set([
  'allowed-once', 'rejected', 'cancelled', 'unavailable',
])

/** Host-only scoped answer factory; its actor is never exposed on a request or wire payload. */
export interface ApprovalIngress {
  /**
   * Mint one opaque answer bound to the exact frozen request and one closed outcome.
   * @param request - exact frozen request received by this listener invocation.
   * @param outcome - closed outcome selected by the Host adapter.
   * @returns a one-shot opaque answer consumable only by the issuing service.
   */
  answer(request: ApprovalRequest, outcome: ApprovalOutcome): OpaqueApprovalAnswer
}

interface ApprovalIngressState {
  readonly service: object
  readonly actor: InteractionActor
  readonly scope: object | undefined
  active: boolean
}

interface ApprovalAnswerState {
  readonly ingress: ApprovalIngressState
  readonly request: ApprovalRequest
  readonly outcome: ApprovalOutcome
}

/** Internal normalized opaque decision returned to ApprovalService. */
export interface ConsumedApprovalAnswer {
  readonly outcome: ApprovalOutcome
  readonly decidedBy: InteractionActor
}

const answerStates = new WeakMap<object, ApprovalAnswerState>()

/**
 * Create one Host-owned ingress bound to an exact service, owner scope, and owner fiber.
 * @param owner - trusted static Host adapter context carrying ApprovalService.
 * @param actor - closed provenance this adapter can attest.
 * @returns an opaque-answer factory invalidated with the owner fiber.
 */
export function createApprovalIngress(
  owner: Context,
  actor: InteractionActor,
): ApprovalIngress {
  const service = exactServiceIdentity(owner.get('approval'))
  if (service === undefined) throw new Error('approval Host ingress requires one live ApprovalService')
  const snapshot = snapshotInteractionActor(actor)
  if (snapshot === undefined) throw new TypeError('approval ingress actor must be one closed InteractionActor')
  const state: ApprovalIngressState = {
    service,
    actor: snapshot,
    scope: scopeOf(owner),
    active: true,
  }
  const ingress: ApprovalIngress = Object.freeze({
    answer(request: ApprovalRequest, outcome: ApprovalOutcome): OpaqueApprovalAnswer {
      const candidate: unknown = request
      if (typeof candidate !== 'object' || candidate === null) {
        throw new TypeError('approval ingress request must be an object')
      }
      if (!OUTCOMES.has(outcome)) throw new TypeError('approval ingress outcome is invalid')
      const answer = Object.freeze({}) as OpaqueApprovalAnswer
      answerStates.set(answer, { ingress: state, request, outcome })
      return answer
    },
  })
  owner.effect(() => () => { state.active = false }, 'approval.createHostIngress()')
  return ingress
}

/**
 * Consume one exact opaque answer once and enforce service, request, lifetime, and owner scope.
 * @param service - ApprovalService currently deciding the request.
 * @param request - exact frozen request being decided.
 * @param answer - untrusted listener return.
 * @returns the normalized actor decision, or undefined when the token is unavailable.
 * @internal
 */
export function consumeApprovalAnswer(
  service: object,
  request: ApprovalRequest,
  answer: unknown,
): ConsumedApprovalAnswer | undefined {
  if ((typeof answer !== 'object' && typeof answer !== 'function') || answer === null) return undefined
  const state = answerStates.get(answer)
  if (state === undefined) return undefined
  answerStates.delete(answer)
  const ingress = state.ingress
  if (!ingress.active || ingress.service !== exactServiceIdentity(service) || state.request !== request) return undefined
  if (ingress.scope !== undefined && !scopeChainOf(request.agent).includes(ingress.scope)) return undefined
  return { outcome: state.outcome, decidedBy: ingress.actor }
}

/** Resolve a Cordis caller-bound service proxy to its exact implementation. */
function exactServiceIdentity(value: unknown): object | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined
  try {
    const original: unknown = (value as Record<symbol, unknown>)[symbols.original]
    return (typeof original === 'object' || typeof original === 'function') && original !== null
      ? original
      : value
  } catch {
    return undefined
  }
}
