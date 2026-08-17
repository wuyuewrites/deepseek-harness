import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import SessionStore, {
  Session,
  SessionExtensionCompatibilityError,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionExtensionDescriptor,
} from '@deepseek-ai/dsh-session'
import { SessionExtensionRegistry } from '../src/extensions.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionExtensionMap {
    'other/event': { value: string }
    'test/control-state': { value: string }
    'test/first': { value: string }
    'test/optional-note': { note: string }
    'test/second': { value: string }
  }
}

const REQUIRED = {
  owner: '@test/control',
  eventType: 'test/control-state',
  schemaVersion: 1,
  requirement: 'required',
} as const satisfies SessionExtensionDescriptor<'test/control-state'>

const OPTIONAL = {
  owner: '@test/control',
  eventType: 'test/optional-note',
  schemaVersion: 1,
  requirement: 'ignorable',
} as const satisfies SessionExtensionDescriptor<'test/optional-note'>

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx
}

async function mintScope(ctx: Context, name: string): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { name }) },
    { inject: ['sessions'] }))
  return scope
}

async function mintChildScope(ctx: Context, name: string, parent: ScopeKey): Promise<Scope> {
  let scope!: Scope
  const key = { name }
  await ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, key, { parent })
  }, { inject: ['sessions'] }))
  return scope
}

function carrier(
  descriptor: SessionExtensionDescriptor,
  payload: unknown,
  seq = 0,
): SessionEvent<'session-extension/event'> {
  return {
    type: 'session-extension/event',
    seq,
    time: 1,
    data: {
      owner: descriptor.owner,
      eventType: descriptor.eventType,
      schemaVersion: descriptor.schemaVersion,
      requirement: descriptor.requirement,
      payload: payload as never,
    },
    ...descriptor.requirement === 'ignorable' ? { ignorable: true as const } : {},
  }
}

function invalidCarrier(overrides: Record<string, unknown>): SessionEvent {
  return {
    ...carrier(REQUIRED, { value: 'invalid' }),
    ...overrides,
  }
}

function closedTurn(session: Session, turn = 1): void {
  session.append('turn/start', { turn })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('session extension carrier', () => {
  it('writes self-describing required and ignorable carriers with frozen payloads', async () => {
    const ctx = await mount()
    const required = ctx.sessions.registerEventExtension(REQUIRED)
    const optional = ctx.sessions.registerEventExtension(OPTIONAL)
    const session = ctx.sessions.create(SessionId('carrier'))
    const payload = { value: 'initial' }

    const requiredEvent = required.append(session, payload)
    const optionalEvent = optional.append(session, { note: 'diagnostic' })
    payload.value = 'mutated'

    expect(requiredEvent).toMatchObject({
      type: 'session-extension/event',
      seq: 0,
      data: { ...REQUIRED, payload: { value: 'initial' } },
    })
    expect(requiredEvent).not.toHaveProperty('ignorable')
    expect(optionalEvent).toMatchObject({
      type: 'session-extension/event',
      seq: 1,
      ignorable: true,
      data: { ...OPTIONAL, payload: { note: 'diagnostic' } },
    })
    expect(Object.isFrozen(requiredEvent.data.payload)).toBe(true)
  })

  it('rejects malformed carrier metadata without changing the log', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create(SessionId('malformed'))
    const before = session.seq

    expect(() => session.append('session-extension/event', {
      ...carrier(REQUIRED, { value: 'x' }).data,
      requirement: 'ignorable',
    })).toThrow(/must be marked ignorable/)
    expect(() => session.append('session-extension/event', {
      ...carrier(REQUIRED, { value: 'x' }).data,
      schemaVersion: 0,
    })).toThrow(/positive safe integer/)
    expect(session.seq).toBe(before)

    const invalidSeed = carrier(REQUIRED, { value: 'x' })
    ;(invalidSeed as { ignorable?: true }).ignorable = true
    expect(() => Session.create(SessionId('invalid-seed'), [invalidSeed]))
      .toThrow(/required session-extension\/event must not be marked ignorable/)
  })

  it('rejects malformed carrier envelopes and every closed metadata field', async () => {
    const malformed: Array<[SessionEvent, RegExp]> = [
      [invalidCarrier({ surfaceOp: 'append' }), /must be log-only/],
      [invalidCarrier({ sourceEventSeqs: [0] }), /must be log-only/],
      [invalidCarrier({ data: null }), /invalid session-extension\/event data/],
      [invalidCarrier({ data: [] }), /invalid session-extension\/event data/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, extra: true } }), /must contain exact/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, owner: 1 } }), /owner/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, owner: '' } }), /owner/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, owner: ' @test/control' } }), /owner/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, owner: '@test\0control' } }), /owner/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, eventType: 1 } }), /eventType/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, eventType: '' } }), /eventType/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, eventType: ' test/control-state' } }), /eventType/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, eventType: 'test\0control-state' } }), /eventType/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, schemaVersion: '1' } }), /schemaVersion/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, schemaVersion: 0 } }), /schemaVersion/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, schemaVersion: 1.5 } }), /schemaVersion/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, schemaVersion: Number.MAX_SAFE_INTEGER + 1 } }), /schemaVersion/],
      [invalidCarrier({ data: { ...carrier(REQUIRED, { value: 'x' }).data, requirement: 'unknown' } }), /requirement/],
    ]
    for (const [index, [event, message]] of malformed.entries()) {
      expect(() => Session.create(SessionId(`malformed-${index}`), [event])).toThrow(message)
    }
  })

  it('rejects surface metadata on log events and ignorable metadata on surface events', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create(SessionId('metadata-kinds'))
    const append = session.append.bind(session) as (
      type: string,
      data: unknown,
      options?: Record<string, unknown>,
    ) => SessionEvent

    expect(() => append('user/message', {}, { surfaceOp: 'append', ignorable: true }))
      .toThrow(/surface session event .* cannot be marked ignorable/)
    expect(() => append('turn/start', { turn: 1 }, { surfaceOp: 'append' }))
      .toThrow(/not surface-eligible and cannot carry surfaceOp/)
    expect(() => append('turn/start', { turn: 1 }, { sourceEventSeqs: [0] }))
      .toThrow(/not surface-eligible and cannot carry sourceEventSeqs/)
  })
})

describe('SessionExtensionRegistry validation and visibility', () => {
  it('handles an effect that never activates and filters inactive contributions', () => {
    const appendEvent = vi.fn()
    const registry = new SessionExtensionRegistry(appendEvent)
    const layers = registry as unknown as { layers: { onChange(): void } }
    layers.layers.onChange()
    const inertContext = {
      effect: vi.fn(() => () => undefined),
    } as unknown as Context

    expect(() => registry.register(inertContext, REQUIRED))
      .toThrow('session extension registration did not activate')

    const retainedContext = {
      effect: (factory: () => Generator<unknown, unknown, unknown>) => {
        factory().next()
        return () => undefined
      },
    } as unknown as Context
    const registration = registry.register(retainedContext, REQUIRED)
    expect(registry.resolve(undefined, REQUIRED.owner, REQUIRED.eventType)).toMatchObject(REQUIRED)
    registration.dispose()
    expect(registry.resolve(undefined, REQUIRED.owner, REQUIRED.eventType)).toBeUndefined()
  })

  it('matches every carrier descriptor field and rejects malformed descriptors', async () => {
    const ctx = await mount()
    const registration = ctx.sessions.registerEventExtension(REQUIRED)
    const matching = carrier(REQUIRED, { value: 'match' })

    expect(registration.matches(matching)).toBe(true)
    expect(registration.matches({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })).toBe(false)
    expect(registration.matches(carrier({ ...REQUIRED, owner: 'other' }, { value: 'x' }))).toBe(false)
    expect(registration.matches(carrier({ ...REQUIRED, eventType: 'other/event' }, { value: 'x' }))).toBe(false)
    expect(registration.matches(carrier({ ...REQUIRED, schemaVersion: 2 }, { value: 'x' }))).toBe(false)
    expect(registration.matches(carrier({ ...REQUIRED, requirement: 'ignorable' }, { value: 'x' }))).toBe(false)

    const invalidDescriptors: Array<[SessionExtensionDescriptor, RegExp]> = [
      [{ ...REQUIRED, owner: 1 } as unknown as SessionExtensionDescriptor, /owner/],
      [{ ...REQUIRED, owner: '' }, /owner/],
      [{ ...REQUIRED, owner: ' @test/control' }, /owner/],
      [{ ...REQUIRED, owner: '@test\0control' }, /owner/],
      [{ ...REQUIRED, eventType: 1 } as unknown as SessionExtensionDescriptor, /eventType/],
      [{ ...REQUIRED, eventType: '' } as unknown as SessionExtensionDescriptor, /eventType/],
      [{ ...REQUIRED, eventType: ' test/control-state' } as unknown as SessionExtensionDescriptor, /eventType/],
      [{ ...REQUIRED, eventType: 'test\0control-state' } as unknown as SessionExtensionDescriptor, /eventType/],
      [{ ...REQUIRED, schemaVersion: 0 }, /schemaVersion/],
      [{ ...REQUIRED, schemaVersion: -1 }, /schemaVersion/],
      [{ ...REQUIRED, schemaVersion: 1.5 }, /schemaVersion/],
      [{ ...REQUIRED, schemaVersion: Number.NaN }, /schemaVersion/],
      [{ ...REQUIRED, requirement: 'unknown' } as unknown as SessionExtensionDescriptor, /requirement/],
    ]
    for (const [descriptor, message] of invalidDescriptors) {
      expect(() => ctx.sessions.registerEventExtension(descriptor)).toThrow(message)
    }
    registration.dispose()
    registration.dispose()
  })
})

describe('SessionStore event extension registry', () => {
  it('reference-counts identical descriptors, rejects conflicts, and invalidates disposed handles', async () => {
    const ctx = await mount()
    const first = ctx.sessions.registerEventExtension(REQUIRED)
    const second = ctx.sessions.registerEventExtension(REQUIRED)
    const session = ctx.sessions.create(SessionId('registrations'))

    first.dispose()
    expect(() => first.append(session, { value: 'stale' })).toThrow(/inactive/)
    expect(() => second.append(session, { value: 'live' })).not.toThrow()
    expect(() => ctx.sessions.registerEventExtension({ ...REQUIRED, schemaVersion: 2 }))
      .toThrow(/conflicts/)

    second.dispose()
    const seeded = Session.create(SessionId('missing-registration'), [carrier(REQUIRED, { value: 'seed' })])
    expect(() => ctx.sessions.enter(seeded)).toThrow(SessionExtensionCompatibilityError)

    const replacement = ctx.sessions.registerEventExtension(REQUIRED)
    expect(() => ctx.sessions.enter(seeded)).not.toThrow()
    replacement.dispose()
  })
})

describe('session extension publication compatibility', () => {
  it('keeps detached preparation readable but refuses incompatible live publication', async () => {
    const ctx = await mount()
    const requiredSeed = [carrier(REQUIRED, { value: 'required' })]
    const optionalSeed = [carrier(OPTIONAL, { note: 'optional' })]

    expect(() => Session.create(SessionId('detached'), requiredSeed)).not.toThrow()
    expect(() => ctx.sessions.prepare(SessionId('prepared'), { seed: requiredSeed })).not.toThrow()
    expect(() => ctx.sessions.create(SessionId('blocked'), { seed: requiredSeed }))
      .toThrow(SessionExtensionCompatibilityError)
    expect(ctx.sessions.get(SessionId('blocked'))).toBeUndefined()
    expect(() => ctx.sessions.create(SessionId('optional'), { seed: optionalSeed })).not.toThrow()
  })

  it('rechecks the captured enter scope before announcing', async () => {
    const ctx = await mount()
    const owner = await mintScope(ctx, 'owner')
    const other = await mintScope(ctx, 'other')
    const registration = owner.ctx.sessions.registerEventExtension(REQUIRED)
    const session = owner.ctx.sessions.prepare(SessionId('announce-race'))
    const detach = owner.ctx.sessions.enter(session)
    registration.append(session, { value: 'bound' })
    registration.dispose()
    other.ctx.sessions.registerEventExtension(REQUIRED)

    expect(() => { other.ctx.sessions.announce(session) }).toThrow(SessionExtensionCompatibilityError)
    detach()
    expect(ctx.sessions.get(SessionId('announce-race'))).toBeUndefined()
  })

  it('lets an open turn close after unload but blocks the next turn until registration returns', async () => {
    const ctx = await mount()
    const owner = await mintScope(ctx, 'owner')
    const registration = owner.ctx.sessions.registerEventExtension(REQUIRED)
    const session = owner.ctx.sessions.create(SessionId('turn-admission'))
    registration.append(session, { value: 'active' })
    session.append('turn/start', { turn: 1 })

    registration.dispose()
    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).not.toThrow()
    const before = session.seq
    expect(() => session.append('turn/start', { turn: 2 })).toThrow(SessionExtensionCompatibilityError)
    expect(session.seq).toBe(before)

    owner.ctx.sessions.registerEventExtension(REQUIRED)
    expect(() => session.append('turn/start', { turn: 2 })).not.toThrow()
  })

  it('reports schema-version and requirement incompatibilities with ordered diagnostics', async () => {
    const ctx = await mount()
    const versionTwo = ctx.sessions.registerEventExtension({ ...REQUIRED, schemaVersion: 2 })
    const versionMismatch = Session.create(SessionId('version-mismatch'), [
      carrier(REQUIRED, { value: 'old' }),
    ])

    expect(() => { ctx.sessions.assertEventExtensionsCompatible(versionMismatch) })
      .toThrow(/@test\/control\/test\/control-state@1 has registered schema version 2/)
    try {
      ctx.sessions.assertEventExtensionsCompatible(versionMismatch)
    } catch (error) {
      expect(error).toBeInstanceOf(SessionExtensionCompatibilityError)
      expect((error as SessionExtensionCompatibilityError).issues).toMatchObject([{
        kind: 'schema-version',
        schemaVersion: 1,
        registeredSchemaVersion: 2,
        registeredRequirement: 'required',
      }])
    }
    versionTwo.dispose()

    const optional = ctx.sessions.registerEventExtension({ ...REQUIRED, requirement: 'ignorable' })
    const requirementMismatch = Session.create(SessionId('requirement-mismatch'), [
      carrier(REQUIRED, { value: 'required' }),
    ])
    expect(() => { ctx.sessions.assertEventExtensionsCompatible(requirementMismatch) })
      .toThrow(/@test\/control\/test\/control-state@1 is registered as ignorable/)
    optional.dispose()

    const duplicate = ctx.sessions.registerEventExtension(REQUIRED)
    const repeated = ctx.sessions.create(SessionId('repeated-required'))
    duplicate.append(repeated, { value: 'first' })
    duplicate.append(repeated, { value: 'second' })
    expect(() => { ctx.sessions.assertEventExtensionsCompatible(repeated) }).not.toThrow()
    duplicate.dispose()

    const missing = Session.create(SessionId('ordered-missing'), [
      carrier({ ...REQUIRED, eventType: 'test/second' }, { value: 'second' }, 0),
      carrier({ ...REQUIRED, eventType: 'test/second' }, { value: 'duplicate' }, 1),
      carrier({ ...REQUIRED, eventType: 'test/first' }, { value: 'first' }, 2),
    ])
    expect(() => { ctx.sessions.assertEventExtensionsCompatible(missing) })
      .toThrow(/test\/second@1 is not registered; .*test\/first@1 is not registered/)
  })
})

describe('session extension scoped and fork lifecycle', () => {
  it('prevents cross-scope writes and compatibility borrowing', async () => {
    const ctx = await mount()
    const owner = await mintScope(ctx, 'owner')
    const other = await mintScope(ctx, 'other')
    const registration = owner.ctx.sessions.registerEventExtension(REQUIRED)
    const ownerSession = owner.ctx.sessions.create(SessionId('owner-session'))
    const otherSession = other.ctx.sessions.create(SessionId('other-session'))
    const otherRegistration = other.ctx.sessions.registerEventExtension(REQUIRED)

    registration.append(ownerSession, { value: 'owned' })
    const before = otherSession.seq
    expect(() => registration.append(otherSession, { value: 'cross-scope' })).toThrow(/does not own/)
    expect(otherSession.seq).toBe(before)
    otherRegistration.dispose()
    expect(() => other.ctx.sessions.create(SessionId('other-seed'), {
      seed: [carrier(REQUIRED, { value: 'seed' })],
    })).toThrow(SessionExtensionCompatibilityError)
  })

  it('forks only prefixes compatible with the target scope', async () => {
    const ctx = await mount()
    const owner = await mintScope(ctx, 'owner')
    const registration = owner.ctx.sessions.registerEventExtension(REQUIRED)
    const source = owner.ctx.sessions.create(SessionId('fork-source'))
    closedTurn(source)
    const boundaryBeforeCarrier = source.events.at(-1)!.seq
    registration.append(source, { value: 'required' })
    registration.dispose()

    expect(() => owner.ctx.sessions.fork(source, undefined, SessionId('blocked-child')))
      .toThrow(SessionExtensionCompatibilityError)
    expect(() => owner.ctx.sessions.fork(source, boundaryBeforeCarrier, SessionId('prefix-child')))
      .not.toThrow()

    owner.ctx.sessions.registerEventExtension(REQUIRED)
    const child = owner.ctx.sessions.fork(source, undefined, SessionId('compatible-child'))
    expect(child.events.some(event => event.type === 'session-extension/event')).toBe(true)
  })

  it('rejects an ancestor registration when a child scope shadows its descriptor', async () => {
    const ctx = await mount()
    const parent = await mintScope(ctx, 'parent')
    const child = await mintChildScope(ctx, 'child', scopeOf(parent.ctx)!)
    const parentRegistration = parent.ctx.sessions.registerEventExtension(REQUIRED)
    const childRegistration = child.ctx.sessions.registerEventExtension({ ...REQUIRED, schemaVersion: 2 })
    const session = child.ctx.sessions.create(SessionId('shadowed-registration'))

    expect(() => parentRegistration.append(session, { value: 'blocked' }))
      .toThrow(/is not registered for session/)

    childRegistration.dispose()
    parentRegistration.dispose()
    await child.dispose()
    await parent.dispose()
  })
})
