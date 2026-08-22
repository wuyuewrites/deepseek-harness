import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import * as ApprovalInvariant from '@deepseek-ai/dsh-user-approval/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ApprovalInvariant)
  return ctx
}

function startTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
}

describe('approval invariants', () => {
  it('accepts paired audit events and closed policy values', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    const id = ApprovalRequestId('ask-1')
    session.append('approval/asked', { id, toolName: 'bash' })
    session.append('approval/decided', { id, outcome: 'allowed-once' })
    session.append('approval/policy', { policy: 'never' })
  })

  it('accepts delegation-sourced policy events on live append and replay seed', async () => {
    const live = await setup()
    expect(() => live.sessions.create().append('approval/policy', {
      policy: 'never', source: 'delegation',
    })).not.toThrow()

    const replay = new Context()
    await replay.plugin(SessionStore)
    replay.sessions.create().append('approval/policy', {
      policy: 'never', source: 'delegation',
    })
    await replay.plugin(InvariantRegistry)
    await expect(replay.plugin(ApprovalInvariant)).resolves.toBeDefined()
  })

  it('accepts closed actor provenance while rejecting malformed actor and requiredActor records', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    const first = ApprovalRequestId('actor-ask')
    session.append('approval/asked', { id: first, toolName: 'bash', requiredActor: 'interactive-user' })
    session.append('approval/decided', {
      id: first,
      outcome: 'allowed-once',
      decidedBy: { kind: 'interactive-user', channel: 'cli', principalId: 'operator-1' },
    })
    const second = ApprovalRequestId('invalid-actor')
    expect(() => session.append('approval/asked', {
      id: second, toolName: 'bash', requiredActor: 'human' as never,
    })).toThrow(/unknown requiredActor/)
    session.append('approval/asked', { id: second, toolName: 'bash' })
    expect(() => session.append('approval/decided', {
      id: second,
      outcome: 'allowed-once',
      decidedBy: { kind: 'interactive-user', channel: 'api' } as never,
    })).toThrow(/invalid decidedBy actor/)
  })

  it('rejects an allowed-once decision that does not satisfy its required actor', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    const bare = ApprovalRequestId('required-bare')
    session.append('approval/asked', { id: bare, toolName: 'bash', requiredActor: 'interactive-user' })
    expect(() => session.append('approval/decided', { id: bare, outcome: 'allowed-once' }))
      .toThrow(/does not satisfy requiredActor/)
    expect(() => session.append('approval/decided', {
      id: bare,
      outcome: 'allowed-once',
      decidedBy: { kind: 'external-client', channel: 'api' },
    })).toThrow(/does not satisfy requiredActor/)
    expect(() => session.append('approval/decided', {
      id: bare,
      outcome: 'rejected',
      decidedBy: { kind: 'external-client', channel: 'api' },
    })).not.toThrow()
  })

  it('keeps a crash-tail pending ask readable but never lets it grant across a turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const id = ApprovalRequestId('crash-pending')
    session.append('approval/asked', { id, toolName: 'bash', requiredActor: 'interactive-user' })
    session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })

    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(ApprovalInvariant)).resolves.toBeDefined()
    session.append('turn/start', { turn: 2 })
    expect(() => session.append('approval/decided', {
      id,
      outcome: 'allowed-once',
      decidedBy: { kind: 'interactive-user', channel: 'cli' },
    })).toThrow(/crossed its asked turn/)
  })

  it('requires approval ids to stay unique across the complete session history', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    const id = ApprovalRequestId('historical-id')
    session.append('approval/asked', { id, toolName: 'bash' })
    session.append('approval/decided', { id, outcome: 'rejected' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    expect(() => session.append('approval/asked', { id, toolName: 'bash' }))
      .toThrow(/repeats historical id/)
  })

  it('rebuilds an unmatched question from an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const id = ApprovalRequestId('ask-resume')
    session.append('approval/asked', { id, toolName: 'bash' })
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(ApprovalInvariant)
    expect(() => session.append('approval/decided', { id, outcome: 'cancelled' })).not.toThrow()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })

  it('adopts a bare session first observed through publication', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('bare-approval-session'))
    const id = ApprovalRequestId('bare-ask')
    const asked = {
      type: 'approval/asked', seq: 0, time: 0, data: { id, toolName: 'bash' },
    } as const
    const decided = {
      type: 'approval/decided', seq: 1, time: 1, data: { id, outcome: 'rejected' as const },
    } as const
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'turn/start', seq: 0, time: 0,
        data: { turn: 1 },
      })
      ctx.emit('session/event', session, asked)
      ctx.emit('session/event', session, decided)
    }).not.toThrow()
  })

  it('rejects audit events outside any open turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => session.append('approval/asked', {
      id: ApprovalRequestId('ask-1'), toolName: 'bash',
    })).toThrow(/outside any open turn/)
    expect(() => session.append('approval/decided', {
      id: ApprovalRequestId('ask-1'), outcome: 'rejected',
    })).toThrow(/outside any open turn/)
  })

  it('rejects an unenclosed audit event when replaying an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    startTurn(session)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('approval/asked', {
      id: ApprovalRequestId('ask-replay'), toolName: 'bash',
    })
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(ApprovalInvariant).then(() => undefined)).rejects.toThrow(/outside any open turn/)
  })

  it('rejects malformed and unpaired audit events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    const id = ApprovalRequestId('ask-1')
    expect(() => session.append('approval/asked', { id, toolName: '' }))
      .toThrow(/toolName must be non-empty/)
    session.append('approval/asked', { id, toolName: 'bash' })
    expect(() => session.append('approval/asked', { id, toolName: 'bash' }))
      .toThrow(/repeats historical id/)
    expect(() => session.append('approval/decided', {
      id: ApprovalRequestId('missing'), outcome: 'rejected',
    })).toThrow(/no matching approval\/asked/)
    expect(() => session.append('approval/decided', { id, outcome: 'maybe' as never }))
      .toThrow(/unknown outcome/)
    expect(() => session.append('approval/policy', { policy: 'always' as never }))
      .toThrow(/unknown policy/)
    expect(() => session.append('approval/policy', {
      policy: 'ask', source: 'operator' as never,
    })).toThrow(/unknown source/)
  })

  it('rejects malformed ids, optional fields, and open payload extensions', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    expect(() => session.append('approval/asked', {
      id: '' as ApprovalRequestId, toolName: 'bash',
    })).toThrow(/id must be a non-empty string/)
    expect(() => session.append('approval/asked', {
      toolName: 'bash',
    } as never)).toThrow(/unknown or missing fields/)
    expect(() => session.append('approval/asked', {
      id: ApprovalRequestId('bad-call'), toolName: 'bash', callId: 1 as never,
    })).toThrow(/callId must be a non-empty string/)
    expect(() => session.append('approval/asked', {
      id: ApprovalRequestId('bad-reason'), toolName: 'bash', reason: 1 as never,
    })).toThrow(/reason must be a string/)
    expect(() => session.append('approval/asked', {
      id: ApprovalRequestId('extra-ask'), toolName: 'bash', extra: true,
    } as never)).toThrow(/unknown or missing fields/)
    expect(() => session.append('approval/decided', {
      id: '' as ApprovalRequestId, outcome: 'rejected',
    })).toThrow(/id must be a non-empty string/)
    expect(() => session.append('approval/policy', {
      policy: 'ask', extra: true,
    } as never)).toThrow(/unknown or missing fields/)
  })
})
