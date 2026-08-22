import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService, { createApprovalIngress, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

describe('ACP machine permission policy', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  async function ownedRequest(overrides: Partial<ApprovalRequest> = {}): Promise<ApprovalRequest> {
    if (harness === undefined) throw new Error('missing harness')
    await harness.ctx.plugin(ApprovalService)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.session.append('turn/start', { turn: 1 })
    return { agent, toolName: 'bash', callId: CallId('call-9'), ...overrides }
  }

  it('maps the two advertised one-shot choices', async () => {
    harness = await makeBridgeHarness()
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    const request = await ownedRequest()
    await expect(harness.ctx.approval.request(request)).resolves.toBe('allowed-once')
    expect(request.agent.session.events.findLast(event => event.type === 'approval/decided')).toMatchObject({
      data: { outcome: 'allowed-once', decidedBy: { kind: 'external-client', channel: 'acp' } },
    })
    expect(harness.permissionRequests[0]).toMatchObject({
      sessionId: request.agent.session.id,
      toolCall: { toolCallId: 'call-9' },
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    })

    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    await expect(harness.ctx.approval.request(request)).resolves.toBe('rejected')
    expect(request.agent.session.events.findLast(event => event.type === 'approval/decided')).toMatchObject({
      data: { outcome: 'rejected', decidedBy: { kind: 'external-client', channel: 'acp' } },
    })
  })

  it('delegates an interactive-user requirement without asking the ACP client', async () => {
    harness = await makeBridgeHarness()
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    const request = await ownedRequest({ requiredActor: 'interactive-user' })

    await expect(harness.ctx.approval.request(request)).resolves.toBe('unavailable')
    const decided = request.agent.session.events.findLast(event => event.type === 'approval/decided')
    expect(decided).toMatchObject({
      data: { outcome: 'unavailable' },
    })
    expect(decided?.type === 'approval/decided' && decided.data.decidedBy).toBeUndefined()
    expect(harness.permissionRequests).toHaveLength(0)
  })

  it('delegates to a later opaque interactive provider without starving it', async () => {
    harness = await makeBridgeHarness()
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    const request = await ownedRequest({ requiredActor: 'interactive-user' })
    const ingress = createApprovalIngress(harness.ctx, {
      kind: 'interactive-user', channel: 'cli', principalId: 'operator-1',
    })
    harness.ctx.on('approval/request', request => Promise.resolve(ingress.answer(request, 'allowed-once')))

    await expect(harness.ctx.approval.request(request)).resolves.toBe('allowed-once')
    expect(harness.permissionRequests).toHaveLength(0)
    expect(request.agent.session.events.findLast(event => event.type === 'approval/decided')).toMatchObject({
      data: {
        outcome: 'allowed-once',
        decidedBy: { kind: 'interactive-user', channel: 'cli', principalId: 'operator-1' },
      },
    })
  })

  it('maps cancellation and unknown choices without granting access', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    await expect(harness.ctx.approval.request(request)).resolves.toBe('cancelled')
    expect(request.agent.session.events.findLast(event => event.type === 'approval/decided')).toMatchObject({
      data: { outcome: 'cancelled', decidedBy: { kind: 'external-client', channel: 'acp' } },
    })
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'unknown-grant' } })
    await expect(harness.ctx.approval.request(request)).resolves.toBe('rejected')
  })

  it('fails closed when the client errors the permission request', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    harness.onPermission = () => { throw new Error('client gone') }
    await expect(harness.ctx.approval.request(request)).resolves.toBe('unavailable')
  })

  it('delegates a same-id foreign agent', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    const foreign = {
      session: { id: request.agent.session.id, events: [{ type: 'turn/start' }], append: () => ({}) },
    } as unknown as Agent
    await expect(harness.ctx.approval.request({ agent: foreign, toolName: 'bash', callId: CallId('call') }))
      .resolves.toBe('unavailable')
    expect(harness.permissionRequests).toHaveLength(0)
  })

  it('delegates requests that have no protocol tool-call identity', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    await expect(harness.ctx.approval.request({ agent: request.agent, toolName: request.toolName }))
      .resolves.toBe('unavailable')
    expect(harness.permissionRequests).toHaveLength(0)
  })
})
