/** Package-owned approval audit-stream invariants. @module @deepseek-ai/dsh-user-approval/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ApprovalRequestId } from './index.ts'
import { APPROVAL_POLICIES } from './index.ts'
import { isActorQualifiedApprovalGrant, isInteractionActor } from './actor.ts'
import type { RequiredInteractionActor } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-user-approval'
const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const

/** Cordis companion plugin name. */
export const name = 'user-approval-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

type ApprovalTransition =
  | { kind: 'asked'; id: ApprovalRequestId; pending: PendingApproval }
  | { kind: 'decided'; id: ApprovalRequestId }

interface PendingApproval {
  readonly askedTurn: number
  readonly requiredActor?: RequiredInteractionActor
}

interface ApprovalTrace {
  openTurn: number | null
  seen: Set<ApprovalRequestId>
  pending: Map<ApprovalRequestId, PendingApproval>
}

/** Validate one approval event against committed unmatched questions. */
function validateApprovalEvent(
  trace: ApprovalTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): ApprovalTransition | undefined {
  if (event.type === 'approval/asked') {
    if (trace.openTurn === null) fail('approval/asked appended outside any open turn')
    if (!hasExactKeys(event.data, ['id', 'toolName'], ['callId', 'reason', 'requiredActor'])) {
      fail('approval/asked carries unknown or missing fields')
    }
    const id: unknown = event.data.id
    if (typeof id !== 'string' || id.length === 0) fail('approval/asked id must be a non-empty string')
    const toolName: unknown = event.data.toolName
    if (typeof toolName !== 'string' || toolName.length === 0) fail('approval/asked toolName must be non-empty')
    const callId: unknown = event.data.callId
    if (callId !== undefined && (typeof callId !== 'string' || callId.length === 0)) {
      fail('approval/asked callId must be a non-empty string when supplied')
    }
    const reason: unknown = event.data.reason
    if (reason !== undefined && typeof reason !== 'string') {
      fail('approval/asked reason must be a string when supplied')
    }
    const requiredActor: unknown = event.data.requiredActor
    if (requiredActor !== undefined && requiredActor !== 'interactive-user') {
      fail(`approval/asked carries unknown requiredActor ${JSON.stringify(requiredActor)}`)
    }
    if (trace.seen.has(event.data.id)) fail(`approval/asked repeats historical id ${JSON.stringify(event.data.id)}`)
    const askedTurn = trace.openTurn
    return {
      kind: 'asked',
      id: event.data.id,
      pending: {
        askedTurn,
        ...requiredActor === undefined ? {} : { requiredActor },
      },
    }
  }
  if (event.type === 'approval/decided') {
    if (trace.openTurn === null) fail('approval/decided appended outside any open turn')
    if (!hasExactKeys(event.data, ['id', 'outcome'], ['decidedBy'])) {
      fail('approval/decided carries unknown or missing fields')
    }
    const id: unknown = event.data.id
    if (typeof id !== 'string' || id.length === 0) fail('approval/decided id must be a non-empty string')
    const pending = trace.pending.get(event.data.id)
    if (pending === undefined) fail(`approval/decided has no matching approval/asked for id ${JSON.stringify(event.data.id)}`)
    if (pending.askedTurn !== trace.openTurn) {
      fail(`approval/decided ${JSON.stringify(event.data.id)} crossed its asked turn`)
    }
    const outcome = event.data.outcome
    if (!APPROVAL_OUTCOMES.includes(outcome)) {
      fail(`approval/decided carries unknown outcome ${JSON.stringify(outcome)}`)
    }
    const decidedBy: unknown = event.data.decidedBy
    if (decidedBy !== undefined && !isInteractionActor(decidedBy)) {
      fail('approval/decided carries invalid decidedBy actor')
    }
    if (outcome === 'allowed-once' && pending.requiredActor !== undefined
      && !isActorQualifiedApprovalGrant({
        outcome,
        ...decidedBy === undefined ? {} : { decidedBy },
      }, pending.requiredActor)) {
      fail(`approval/decided ${JSON.stringify(event.data.id)} grant does not satisfy requiredActor ${pending.requiredActor}`)
    }
    return { kind: 'decided', id: event.data.id }
  }
  if (event.type === 'approval/policy') {
    if (!hasExactKeys(event.data, ['policy'], ['source'])) {
      fail('approval/policy carries unknown or missing fields')
    }
    if (!APPROVAL_POLICIES.includes(event.data.policy)) {
      fail(`approval/policy carries unknown policy ${JSON.stringify(event.data.policy)}`)
    }
    const source: unknown = event.data.source
    if (source !== undefined && source !== 'delegation') {
      fail(`approval/policy carries unknown source ${JSON.stringify(source)}`)
    }
  }
  return undefined
}

/** Closed payload-key check shared by all approval event variants. */
function hasExactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => required.includes(key) || optional.includes(key))
}

/** Apply one accepted approval-pair transition. */
function applyApprovalTransition(trace: ApprovalTrace, transition: ApprovalTransition): void {
  if (transition.kind === 'asked') {
    trace.seen.add(transition.id)
    trace.pending.set(transition.id, transition.pending)
  } else {
    trace.pending.delete(transition.id)
  }
}

/** Install audit pairing and closed-vocabulary checks. */
// Event owners keep precommit staging local so their vocabularies never move into a central helper.
/* jscpd:ignore-start */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, ApprovalTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session; transition: ApprovalTransition }>()
  const seed = (session: Session): ApprovalTrace => {
    const trace: ApprovalTrace = { openTurn: null, seen: new Set(), pending: new Map() }
    traces.set(session, trace)
    for (const event of session.events) {
      if (event.type === 'turn/start') trace.openTurn = event.data.turn
      else if (event.type === 'turn/end') trace.openTurn = null
      const transition = validateApprovalEvent(trace, event, fail)
      if (transition !== undefined) applyApprovalTransition(trace, transition)
    }
    return trace
  }
  const traceFor = (session: Session): ApprovalTrace => traces.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('session/event', (session, event) => {
    const trace = traceFor(session)
    if (event.type === 'turn/start') {
      trace.openTurn = event.data.turn
      return
    }
    if (event.type === 'turn/end') {
      trace.openTurn = null
      return
    }
    if (event.type !== 'approval/asked' && event.type !== 'approval/decided') return
    const candidate = staged.get(event)
    /* v8 ignore next -- internal/dispatch stages every package-owned pair event */
    if (candidate === undefined || candidate.session !== session) return fail('approval audit event published without pre-commit validation')
    staged.delete(event)
    applyApprovalTransition(trace, candidate.transition)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const transition = validateApprovalEvent(traceFor(session), event, fail)
    if (transition !== undefined) staged.set(event, { session, transition })
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the approval invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
