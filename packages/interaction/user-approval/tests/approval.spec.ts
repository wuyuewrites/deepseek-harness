import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ApprovalService, {
  ApprovalAnswer,
  ApprovalOutcome,
  ApprovalRequest,
  createApprovalIngress,
  effectiveApprovalPolicy,
  isActorQualifiedApprovalGrant,
  setApprovalPolicy,
  snapshotInteractionActor,
} from '@deepseek-ai/dsh-user-approval'

/**
 * A minimal Agent stand-in — the service only reaches `agent.session.append`
 * and folds `.events`. Seeded inside an open turn by default (request()'s
 * turn-enclosure precondition); pass `seed` to stage idle/closed logs.
 * Returns the recorded audit appends alongside the fake.
 */
function fakeAgent(seed: Array<{ type: string }> = [{ type: 'turn/start' }, { type: 'user/message' }]): { agent: Agent; appended: Array<{ type: string; data: Record<string, unknown> }> } {
  const appended: Array<{ type: string; data: Record<string, unknown> }> = []
  const agent = {
    session: {
      events: seed,
      append: (type: string, data: Record<string, unknown>) => {
        appended.push({ type, data })
        return { type, data } as unknown as SessionEvent
      },
    },
  } as unknown as Agent
  return { agent, appended }
}

async function mounted(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ApprovalService)
  return ctx
}

function requestOf(agent: Agent, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { agent, toolName: 'echo', ...overrides }
}

describe('ApprovalService.request', () => {
  it('throws before appending anything when no turn has ever opened (idle ask)', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent([])

    await expect(ctx.approval.request(requestOf(agent))).rejects.toThrow(/outside an open turn/)
    expect(appended).toHaveLength(0)
  })

  it('throws between turns — a closed turn does not satisfy the enclosure precondition', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent([{ type: 'turn/start' }, { type: 'turn/end' }])

    await expect(ctx.approval.request(requestOf(agent))).rejects.toThrow(/outside an open turn/)
    expect(appended).toHaveLength(0)
  })

  it('fails closed to unavailable when nobody listens, auditing the asked/decided pair', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent()

    const outcome = await ctx.approval.request(requestOf(agent, { callId: CallId('call-1'), reason: 'hook says ask' }))

    expect(outcome).toBe('unavailable')
    expect(appended.map(e => e.type)).toEqual(['approval/asked', 'approval/decided'])
    const [asked, decided] = appended
    expect(asked?.data).toMatchObject({ toolName: 'echo', callId: 'call-1', reason: 'hook says ask' })
    expect(decided?.data).toMatchObject({ outcome: 'unavailable' })
    expect(decided?.data['id']).toBe(asked?.data['id'])
  })

  it('records an opaque interactive ingress and grants only when it satisfies requiredActor', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create(SessionId('interactive-approval'))
    session.append('turn/start', { turn: 1 })
    const agent = { id: session.id, session } as Agent
    const ingress = createApprovalIngress(ctx, {
      kind: 'interactive-user', channel: 'cli', principalId: 'operator-1',
    })
    ctx.on('approval/request', request => Promise.resolve(ingress.answer(request, 'allowed-once')))

    await expect(ctx.approval.request(requestOf(agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('allowed-once')
    const asked = session.events.find(event => event.type === 'approval/asked')
    const decided = session.events.find(event => event.type === 'approval/decided')
    expect(asked).toMatchObject({ data: { requiredActor: 'interactive-user' } })
    expect(decided).toMatchObject({
      data: {
        outcome: 'allowed-once',
        decidedBy: { kind: 'interactive-user', channel: 'cli', principalId: 'operator-1' },
      },
    })
  })

  it('fails closed for headless, legacy, and automation answers to a human-required request', async () => {
    const headless = await mounted()
    const headlessRequest = fakeAgent()
    await expect(headless.approval.request(requestOf(headlessRequest.agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('unavailable')

    const legacy = await mounted()
    const legacyRequest = fakeAgent()
    legacy.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    await expect(legacy.approval.request(requestOf(legacyRequest.agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('unavailable')
    expect(legacyRequest.appended[1]?.data).toMatchObject({ outcome: 'unavailable' })
    expect(legacyRequest.appended[1]?.data.decidedBy).toBeUndefined()

    const automation = await mounted()
    const automationRequest = fakeAgent()
    const automationIngress = createApprovalIngress(automation, {
      kind: 'automation', provider: 'test-runner',
    })
    automation.on('approval/request', request => Promise.resolve(automationIngress.answer(request, 'allowed-once')))
    await expect(automation.approval.request(requestOf(automationRequest.agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('unavailable')
    expect(automationRequest.appended[1]?.data).toMatchObject({
      outcome: 'unavailable', decidedBy: { kind: 'automation', provider: 'test-runner' },
    })
  })

  it('never accepts a structurally forged interactive decision as an opaque Host answer', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent()
    ctx.on('approval/request', () => Promise.resolve({
      outcome: 'allowed-once',
      decidedBy: { kind: 'interactive-user', channel: 'cli' },
    } as never))

    await expect(ctx.approval.request(requestOf(agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('unavailable')
    expect(appended[1]?.data).toEqual(expect.objectContaining({ outcome: 'unavailable' }))
    expect(appended[1]?.data.decidedBy).toBeUndefined()
  })

  it('consumes each opaque answer once and rejects answers after ingress owner disposal', async () => {
    const ctx = await mounted()
    const firstAgent = fakeAgent()
    const secondAgent = fakeAgent()
    let ingress!: ReturnType<typeof createApprovalIngress>
    const owner = await ctx.plugin((inner: Context) => {
      ingress = createApprovalIngress(inner, {
        kind: 'interactive-user', channel: 'cli', principalId: 'operator-1',
      })
    })
    let answer: ReturnType<typeof ingress.answer> | undefined
    ctx.on('approval/request', (request) => {
      answer ??= ingress.answer(request, 'allowed-once')
      return Promise.resolve(answer)
    })

    await expect(ctx.approval.request(requestOf(firstAgent.agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('allowed-once')
    await expect(ctx.approval.request(requestOf(secondAgent.agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('unavailable')

    await owner.dispose()
    const thirdAgent = fakeAgent()
    ctx.on('approval/request', request => Promise.resolve(ingress.answer(request, 'allowed-once')), { prepend: true })
    await expect(ctx.approval.request(requestOf(thirdAgent.agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('unavailable')
  })

  it('cannot replay an intercepted opaque answer onto a different request', async () => {
    const ctx = await mounted()
    const ingress = createApprovalIngress(ctx, {
      kind: 'interactive-user', channel: 'cli', principalId: 'operator-1',
    })
    let stolen: Awaited<ApprovalAnswer> | undefined
    const intercept = ctx.on('approval/request', async (_request, next) => {
      if (stolen === undefined) {
        stolen = await next()
        return 'unavailable'
      }
      return stolen
    }, { prepend: true })
    ctx.on('approval/request', request => Promise.resolve(ingress.answer(request, 'allowed-once')))

    const first = fakeAgent()
    await expect(ctx.approval.request(requestOf(first.agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('unavailable')
    const second = fakeAgent()
    await expect(ctx.approval.request(requestOf(second.agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('unavailable')

    intercept()
    const third = fakeAgent()
    await expect(ctx.approval.request(requestOf(third.agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('allowed-once')
  })

  it('rejects an opaque answer minted for a different ApprovalService', async () => {
    const issuer = await mounted()
    const receiver = await mounted()
    const ingress = createApprovalIngress(issuer, {
      kind: 'interactive-user', channel: 'cli', principalId: 'operator-1',
    })
    receiver.on('approval/request', request => Promise.resolve(ingress.answer(request, 'allowed-once')))
    const { agent, appended } = fakeAgent()

    await expect(receiver.approval.request(requestOf(agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('unavailable')
    expect(appended[1]?.data).toMatchObject({ outcome: 'unavailable' })
    expect(appended[1]?.data.decidedBy).toBeUndefined()
  })

  it('accepts an ingress only inside its owner scope', async () => {
    const ctx = await mounted()
    const owned = fakeAgent()
    const foreign = fakeAgent()
    let scope!: Scope
    const scopeFiber = await ctx.plugin((inner: Context) => {
      scope = createScope(inner, owned.agent)
    })
    const ingress = createApprovalIngress(scope.ctx, {
      kind: 'interactive-user', channel: 'cli', principalId: 'operator-1',
    })
    ctx.on('approval/request', request => Promise.resolve(ingress.answer(request, 'allowed-once')))

    await expect(ctx.approval.request(requestOf(foreign.agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('unavailable')
    await expect(ctx.approval.request(requestOf(owned.agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('allowed-once')
    await scopeFiber.dispose()
  })

  it('snapshots each hostile actor getter exactly once before validation', () => {
    let channelReads = 0
    const actor = {
      kind: 'interactive-user',
      get channel() {
        channelReads += 1
        return channelReads === 1 ? 'web' : 'api'
      },
    }

    expect(snapshotInteractionActor(actor)).toEqual({ kind: 'interactive-user', channel: 'web' })
    expect(channelReads).toBe(1)
  })

  it('replay consumers never treat a bare legacy approval outcome as a human grant', () => {
    expect(isActorQualifiedApprovalGrant({ outcome: 'allowed-once' }, 'interactive-user')).toBe(false)
    expect(isActorQualifiedApprovalGrant({
      outcome: 'allowed-once', decidedBy: { kind: 'external-client', channel: 'api' },
    }, 'interactive-user')).toBe(false)
    expect(isActorQualifiedApprovalGrant({
      outcome: 'allowed-once', decidedBy: { kind: 'interactive-user', channel: 'web' },
    }, 'interactive-user')).toBe(true)
  })

  it('omits absent optional fields from the asked audit event', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent()

    await ctx.approval.request(requestOf(agent))

    expect(Object.keys(appended[0]?.data ?? {}).sort()).toEqual(['id', 'toolName'])
  })

  it('dispatches one frozen request snapshot through the exact agent scope', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent()
    let scope!: Scope
    const scopeFiber = await ctx.plugin(Object.assign((inner: Context) => {
      scope = createScope(inner, agent)
    }, { inject: ['approval'] }))
    let received: ApprovalRequest | undefined
    let carrier: unknown
    scope.ctx.on('approval/request', function (req) {
      received = req
      carrier = carrierKeyOf(this)
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    const request = requestOf(agent, {
      toolName: 'scoped-tool',
      callId: CallId('scoped-call'),
      reason: 'scoped reason',
    })

    await expect(ctx.approval.request(request)).resolves.toBe('allowed-once')
    expect(carrier).toBe(agent)
    expect(received).not.toBe(request)
    expect(received).toMatchObject(request)
    expect(Object.isFrozen(received)).toBe(true)
    expect(appended).toHaveLength(2)
    expect(appended[0]?.data).toMatchObject({
      toolName: 'scoped-tool',
      callId: 'scoped-call',
      reason: 'scoped reason',
    })
    expect(appended[1]?.data).toMatchObject({ outcome: 'allowed-once' })
    expect(appended[1]?.data['id']).toBe(appended[0]?.data['id'])
    await scopeFiber.dispose()
  })

  it('cannot bypass requiredActor by mutating the caller request while the answerer awaits', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<ApprovalOutcome>()
    let received: ApprovalRequest | undefined
    ctx.on('approval/request', (request) => {
      received = request
      entered.resolve(undefined)
      return release.promise
    })
    const request = {
      agent,
      toolName: 'before-mutation',
      reason: 'original reason',
      requiredActor: 'interactive-user' as const,
    }

    const pending = ctx.approval.request(request)
    await entered.promise
    delete (request as { requiredActor?: string }).requiredActor
    request.toolName = 'after-mutation'
    request.reason = 'changed reason'
    release.resolve('allowed-once')

    await expect(pending).resolves.toBe('unavailable')
    expect(received).toMatchObject({
      toolName: 'before-mutation', reason: 'original reason', requiredActor: 'interactive-user',
    })
    expect(Object.isFrozen(received)).toBe(true)
    expect(appended[0]?.data).toMatchObject({
      toolName: 'before-mutation', reason: 'original reason', requiredActor: 'interactive-user',
    })
  })

  it('contains hostile answer proxies as unavailable and completes the decided pair', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent()
    const hostile = new Proxy({}, {
      get(_target, key) {
        if (key === 'then') return undefined
        throw new Error('answer getter escaped')
      },
      ownKeys() { throw new Error('answer ownKeys escaped') },
    })
    ctx.on('approval/request', () => Promise.resolve(hostile as never))

    await expect(ctx.approval.request(requestOf(agent, { requiredActor: 'interactive-user' })))
      .resolves.toBe('unavailable')
    expect(appended.map(event => event.type)).toEqual(['approval/asked', 'approval/decided'])
    expect(appended[1]?.data).toMatchObject({ outcome: 'unavailable' })
  })

  it('contains an approval/asked observer throw after append and still completes the pair', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create(SessionId('asked-observer-throw'))
    session.append('turn/start', { turn: 1 })
    const agent = { session } as unknown as Agent
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'approval/asked') throw new Error('observer failed after asked append')
    })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))

    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('allowed-once')

    const audit = session.events.filter(event => event.type.startsWith('approval/'))
    const asked = session.events.find((event): event is SessionEvent<'approval/asked'> => event.type === 'approval/asked')
    const decided = session.events.find((event): event is SessionEvent<'approval/decided'> => event.type === 'approval/decided')
    expect(audit.map(event => event.type)).toEqual(['approval/asked', 'approval/decided'])
    expect(decided?.data.id).toBe(asked?.data.id)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session/event listener threw: Error: observer failed after asked append'))
  })

  it('contains an approval/decided observer throw after append and still resolves', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create(SessionId('decided-observer-throw'))
    session.append('turn/start', { turn: 1 })
    const agent = { session } as unknown as Agent
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'approval/decided') throw new Error('observer failed after decided append')
    })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('rejected'))

    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('rejected')

    const audit = session.events.filter(event => event.type.startsWith('approval/'))
    const asked = session.events.find((event): event is SessionEvent<'approval/asked'> => event.type === 'approval/asked')
    const decided = session.events.find((event): event is SessionEvent<'approval/decided'> => event.type === 'approval/decided')
    expect(audit.map(event => event.type)).toEqual(['approval/asked', 'approval/decided'])
    expect(decided?.data).toMatchObject({ id: asked?.data.id, outcome: 'rejected' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session/event listener threw: Error: observer failed after decided append'))
  })

  it('propagates an append failure that prevented audit log growth', async () => {
    const ctx = await mounted()
    const failure = new Error('append failed before log growth')
    const agent = {
      session: {
        events: [{ type: 'turn/start' }],
        append: () => { throw failure },
      },
    } as unknown as Agent

    await expect(ctx.approval.request(requestOf(agent))).rejects.toBe(failure)
  })

  it('returns the first answering listener outcome (single decision slot)', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    let secondRan = false
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    ctx.on('approval/request', () => {
      secondRan = true
      return Promise.resolve<ApprovalOutcome>('rejected')
    })

    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('allowed-once')
    expect(secondRan).toBe(false)
  })

  it('lets a non-owning listener delegate via next() down to the fail-closed default', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    ctx.on('approval/request', (_req, next) => next())

    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('unavailable')
  })

  it('dispatches to global and matching agent-scoped listeners, never a foreign scope', async () => {
    const ctx = await mounted()
    const { agent: agentA } = fakeAgent()
    const { agent: agentB } = fakeAgent()
    let scopeA!: Scope
    let scopeB!: Scope
    const scopesFiber = await ctx.plugin(Object.assign((inner: Context) => {
      scopeA = createScope(inner, agentA)
      scopeB = createScope(inner, agentB)
    }, { inject: ['approval'] }))
    const heard: string[] = []
    ctx.on('approval/request', (req, next) => {
      heard.push(req.agent === agentA ? 'global:A' : 'global:B')
      return next()
    })
    scopeA.ctx.on('approval/request', (_req, next) => {
      heard.push('scoped:A')
      return next()
    })
    scopeB.ctx.on('approval/request', (_req, next) => {
      heard.push('scoped:B')
      return next()
    })

    await expect(ctx.approval.request(requestOf(agentA))).resolves.toBe('unavailable')
    await expect(ctx.approval.request(requestOf(agentB))).resolves.toBe('unavailable')

    expect(heard).toEqual(['global:A', 'scoped:A', 'global:B', 'scoped:B'])
    await scopesFiber.dispose()
  })

  it('keys the scoped dispatch carrier to the exact request agent', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    let scope!: Scope
    const scopeFiber = await ctx.plugin(Object.assign((inner: Context) => {
      scope = createScope(inner, agent)
    }, { inject: ['approval'] }))
    let seenKey: object | undefined
    scope.ctx.on('approval/request', function (req, next) {
      seenKey = carrierKeyOf(this)
      expect(req.agent).toBe(agent)
      return next()
    })

    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('unavailable')

    expect(seenKey).toBe(agent)
    await scopeFiber.dispose()
  })

  it('contains a throwing answerer as unavailable', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent()
    ctx.on('approval/request', () => Promise.reject(new Error('transport died')))

    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('unavailable')
    expect(appended[1]?.data).toMatchObject({ outcome: 'unavailable' })
  })

  it('normalizes a rogue non-vocabulary answer to unavailable', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    // A JS answerer can return anything; the seam must not leak it into
    // callers' closed-union switches.
    ctx.on('approval/request', () => Promise.resolve('yolo' as ApprovalOutcome))

    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('unavailable')
  })

  it('settles cancelled immediately on an already-aborted signal without asking anyone', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent()
    let asked = false
    ctx.on('approval/request', () => {
      asked = true
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })

    const outcome = await ctx.approval.request(requestOf(agent, { signal: AbortSignal.abort() }))

    expect(outcome).toBe('cancelled')
    expect(asked).toBe(false)
    expect(appended.map(e => e.type)).toEqual(['approval/asked', 'approval/decided'])
    expect(appended[1]?.data).toMatchObject({ outcome: 'cancelled' })
  })

  it('resolves cancelled when the signal aborts mid-question and discards the late answer', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent()
    let settleLate: ((outcome: ApprovalOutcome) => void) | undefined
    ctx.on('approval/request', () => new Promise<ApprovalOutcome>((resolve) => { settleLate = resolve }))
    const controller = new AbortController()

    const pending = ctx.approval.request(requestOf(agent, { signal: controller.signal }))
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')

    // The answerer settles after the fact: no second decided event appears.
    settleLate?.('allowed-once')
    await Promise.resolve()
    expect(appended.filter(e => e.type === 'approval/decided')).toHaveLength(1)
    expect(appended[1]?.data).toMatchObject({ outcome: 'cancelled' })
  })

  it('discards a late REJECTION after abort without an unhandled rejection', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    let rejectLate: ((error: Error) => void) | undefined
    ctx.on('approval/request', () => new Promise<ApprovalOutcome>((_resolve, reject) => { rejectLate = reject }))
    const controller = new AbortController()

    const pending = ctx.approval.request(requestOf(agent, { signal: controller.signal }))
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')

    rejectLate?.(new Error('answered too late'))
    // Drain microtasks: the contained rejection must not escape the seam.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })

  it('resolves the answer when the signal never aborts', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('rejected'))
    const controller = new AbortController()

    await expect(ctx.approval.request(requestOf(agent, { signal: controller.signal }))).resolves.toBe('rejected')
  })

  it('issues a fresh id per request', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent()

    await ctx.approval.request(requestOf(agent))
    await ctx.approval.request(requestOf(agent))

    const ids = appended.filter(e => e.type === 'approval/asked').map(e => e.data['id'])
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('drops a disposed plugin listener from the chain (HMR safety)', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    const fiber = await ctx.plugin((inner: Context) => {
      inner.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    })
    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('allowed-once')

    await fiber.dispose()
    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('unavailable')
  })
})

describe('approval policy (the approval/policy fold)', () => {
  const NEVER_SENTENCE = 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
  const ASK_SENTENCE = 'Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.'

  /**
   * An agent stand-in over a REAL Session — gate and context fold real events;
   * the opened turn satisfies request()'s enclosure precondition.
   */
  function sessionAgent(id: string): { agent: Agent; session: Session } {
    const session = Session.create(SessionId(id))
    session.append('turn/start', { turn: 1 })
    const agent = { id, session } as unknown as Agent
    return { agent, session }
  }

  it('folds to the last event, or undefined without one', () => {
    const { session } = sessionAgent('sess-fold')
    expect(effectiveApprovalPolicy(session.events)).toBeUndefined()
    setApprovalPolicy(session, 'never')
    setApprovalPolicy(session, 'ask')
    expect(effectiveApprovalPolicy(session.events)).toBe('ask')
    expect(session.events.at(-1)).toMatchObject({ type: 'approval/policy', data: { policy: 'ask' } })
  })

  it('rejects a policy outside the closed vocabulary before appending', () => {
    const append = vi.fn()
    const session = { append } as unknown as Session

    expect(() => { setApprovalPolicy(session, 'sometimes' as Parameters<typeof setApprovalPolicy>[1]) })
      .toThrow('approval policy must be one of "ask" or "never"')
    expect(append).not.toHaveBeenCalled()
  })

  it('defaults a schema-less construction to ask (the ?? narrows the optional TYPE)', async () => {
    // Direct construction bypasses the plugin schema (the SystemPrompt-test
    // precedent for covering a defaulted Config field's type-narrowing ??).
    const ctx = new Context()
    const service = new ApprovalService(ctx, {})
    const { agent } = sessionAgent('sess-bare-config')
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    await expect(service.request({ agent, toolName: 'echo' })).resolves.toBe('allowed-once')
  })

  it('contains an answerer that throws SYNCHRONOUSLY as unavailable', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    const { agent } = sessionAgent('sess-syncthrow')
    ctx.on('approval/request', () => { throw new Error('sync bug') })
    await expect(ctx.approval.request({ agent, toolName: 'echo' })).resolves.toBe('unavailable')
  })

  it('a never config rejects deterministically without consulting any answerer', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService, { policy: 'never' })
    const consulted = vi.fn()
    ctx.on('approval/request', (_req, next) => { consulted(); return next() })
    const { agent, session } = sessionAgent('sess-gate-1')
    await expect(ctx.approval.request({ agent, toolName: 'bash' })).resolves.toBe('rejected')
    expect(consulted).not.toHaveBeenCalled()
    // The audit pair still lands on the session log.
    expect(session.events.filter(e => e.type === 'approval/asked')).toHaveLength(1)
    expect(session.events.filter(e => e.type === 'approval/decided')).toHaveLength(1)
  })

  it('the gate decides FIRST even against an answerer registered before the service (prepend)', async () => {
    const ctx = new Context()
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    await ctx.plugin(ApprovalService, { policy: 'never' })
    const { agent } = sessionAgent('sess-gate-2')
    await expect(ctx.approval.request({ agent, toolName: 'bash' })).resolves.toBe('rejected')
  })

  it('never is unbypassable even by an answerer PREPENDED after the service mounts', async () => {
    // Cordis prepend unshifts ahead of every existing listener, including any gate LISTENER the
    // service could register — which is exactly why the 'never' decision lives inside request()
    // instead. This eager grant would bypass a listener-based gate and therefore must never run.
    const ctx = new Context()
    await ctx.plugin(ApprovalService, { policy: 'never' })
    const consulted = vi.fn()
    ctx.on('approval/request', () => { consulted(); return Promise.resolve<ApprovalOutcome>('allowed-once') }, { prepend: true })
    const { agent, appended } = fakeAgent()
    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('rejected')
    expect(consulted).not.toHaveBeenCalled()
    expect(appended.map(e => e.type)).toEqual(['approval/asked', 'approval/decided'])
  })

  it('a session override outranks the configured default, in both directions', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService, { policy: 'never' })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const { agent, session } = sessionAgent('sess-gate-3')
    expect(ctx.approval.overrideOf(session)).toBeUndefined()
    setApprovalPolicy(session, 'ask')
    expect(ctx.approval.overrideOf(session)).toBe('ask')
    await expect(ctx.approval.request({ agent, toolName: 'bash' })).resolves.toBe('allowed-once')
    setApprovalPolicy(session, 'never')
    await expect(ctx.approval.request({ agent, toolName: 'bash' })).resolves.toBe('rejected')
  })

  it('queues a live policy switch for the next model step', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    const { agent, session } = sessionAgent('sess-policy-notice')
    const inject = vi.fn<Agent['inject']>()
    const liveAgent = { ...agent, inject } as Agent

    ctx.approval.setPolicy(liveAgent, 'never')
    ctx.approval.setPolicy(liveAgent, 'never')

    expect(effectiveApprovalPolicy(session.events)).toBe('never')
    expect(inject).toHaveBeenCalledOnce()
    expect(inject.mock.calls[0]?.[0]).toMatchObject({
      content: [{
        type: 'text',
        text: 'The approval policy changed from "ask" to "never" (changed by the user).',
      }],
      source: { kind: 'plugin', plugin: 'user-approval' },
    })
  })

  it('contributes the complete current ask or never policy as cache-safe context', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ApprovalService)
    const askAgent = sessionAgent('sess-sect-ask').agent
    const { agent: neverAgent, session } = sessionAgent('sess-sect-never')
    setApprovalPolicy(session, 'never')
    const contextFor = async (context: object) =>
      (await ctx.systemPrompt.assemble(context)).contexts.find(entry => entry.name === 'approval:policy')?.text
    expect(await contextFor({ agent: askAgent })).toBe(ASK_SENTENCE)
    expect(await contextFor({ agent: neverAgent })).toBe(NEVER_SENTENCE)
    // A bare assemble (no agent) has no session to state.
    expect(await contextFor({})).toBe('')
  })

  it('reflects the latest durable switch in cache-safe context and stays byte-stable while unchanged', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ApprovalService)
    const { agent, session } = sessionAgent('sess-context-switch')
    const contextFor = async () =>
      (await ctx.systemPrompt.assemble({ agent })).contexts.find(entry => entry.name === 'approval:policy')?.text
    expect(await contextFor()).toBe(ASK_SENTENCE)
    expect(await contextFor()).toBe(ASK_SENTENCE)
    setApprovalPolicy(session, 'never')
    setApprovalPolicy(session, 'ask')
    setApprovalPolicy(session, 'never')
    expect(await contextFor()).toBe(NEVER_SENTENCE)
    expect(await contextFor()).toBe(NEVER_SENTENCE)
  })

  it('disposes the runtime-context contribution with the service', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const fiber = await ctx.plugin(ApprovalService)
    const { agent } = sessionAgent('sess-hmr-service-live')
    const contextFor = async () =>
      (await ctx.systemPrompt.assemble({ agent })).contexts.find(context => context.name === 'approval:policy')
    expect(await contextFor()).toBeDefined()
    await fiber.dispose()
    expect(await contextFor()).toBeUndefined()
  })
})
