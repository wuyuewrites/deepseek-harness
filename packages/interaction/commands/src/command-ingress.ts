/**
 * Module-private command ingress capabilities shared by the runtime and Host adapters.
 * @module @deepseek-ai/dsh-commands/command-ingress
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment/types'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { snapshotInteractionActor } from '@deepseek-ai/dsh-user-approval/actor'
import type { InteractionActor } from '@deepseek-ai/dsh-user-approval/types'
import type { CommandExecution, CommandSource } from './types.ts'

declare const CommandIngressBrand: unique symbol

/** Opaque Host-only capability for one actor, runtime, owner scope, and owner fiber. */
export interface CommandIngress {
  readonly [CommandIngressBrand]: never
}

interface CommandIngressState {
  readonly runtime: object
  readonly actor: InteractionActor
  readonly scope: object | undefined
  active: boolean
}

type TrustedCommandExecutor = (
  ingress: CommandIngress,
  agent: Agent,
  line: string,
  images: readonly EncodedImageAttachment[],
  signal: AbortSignal,
) => Promise<CommandExecution | undefined>

const ingressStates = new WeakMap<object, CommandIngressState>()
const runtimeExecutors = new WeakMap<object, TrustedCommandExecutor>()

/**
 * Install one runtime's module-private Host executor and return its exact disposer.
 * @param runtime - exact CommandRuntime implementation identity.
 * @param executor - hidden trusted dispatch closure.
 * @returns the exact one-shot disposer for the executor entry.
 * @internal
 */
export function installCommandHostExecutor(runtime: object, executor: TrustedCommandExecutor): () => void {
  if (runtimeExecutors.has(runtime)) throw new Error('command Host executor is already installed')
  runtimeExecutors.set(runtime, executor)
  let active = true
  return () => {
    if (!active) return
    active = false
    runtimeExecutors.delete(runtime)
  }
}

/**
 * Mint one opaque capability outside the CommandRuntime public service API.
 * @param owner - trusted static Host adapter context carrying CommandRuntime.
 * @param actor - closed provenance this adapter can attest.
 * @returns an owner-scoped capability invalidated with the owner fiber.
 */
export function createCommandIngress(
  owner: Context,
  actor: InteractionActor,
): CommandIngress {
  const facade = owner.get('commands')
  if (facade === undefined) throw new Error('command Host executor is unavailable')
  // Cordis returns a caller-bound traceable proxy here. Typert's immutable
  // binding deliberately retains the exact service instance used for source
  // discovery; resolve that instance before consulting the module-private
  // executor table so a proxy can neither split nor forge runtime identity.
  const runtime = facade.typertRemote.service
  if (!runtimeExecutors.has(runtime)) throw new Error('command Host executor is unavailable')
  const snapshot = snapshotInteractionActor(actor)
  if (snapshot === undefined) throw new TypeError('command ingress actor must be one closed InteractionActor')
  const capability = Object.freeze({}) as CommandIngress
  const state: CommandIngressState = {
    runtime,
    actor: snapshot,
    scope: scopeOf(owner),
    active: true,
  }
  ingressStates.set(capability, state)
  owner.effect(() => () => { state.active = false }, 'commands.createHostIngress()')
  return capability
}

/**
 * Invoke one runtime's hidden trusted path after a fail-closed initial capability check.
 * @param ingress - opaque capability minted for the receiving runtime and actor.
 * @param agent - exact receiving agent.
 * @param line - complete candidate slash-command line.
 * @param images - encoded image attachments accompanying the command.
 * @param signal - cancellation boundary owned by the Host adapter.
 * @returns the settled execution, or undefined for an admission miss.
 */
export async function executeTrustedCommand(
  ingress: CommandIngress,
  agent: Agent,
  line: string,
  images: readonly EncodedImageAttachment[],
  signal: AbortSignal,
): Promise<CommandExecution | undefined> {
  const state = activeCommandIngress(ingress, agent)
  const executor = runtimeExecutors.get(state.runtime)
  if (executor === undefined) throw new Error('command Host executor is unavailable')
  return await executor(ingress, agent, line, images, signal)
}

/**
 * Revalidate an ingress and return the frozen durable source for its actor.
 * @param runtime - exact CommandRuntime implementation entering the handler path.
 * @param ingress - opaque capability to revalidate.
 * @param agent - exact receiving agent used for owner-scope resolution.
 * @returns the frozen actor-bearing durable command source.
 * @internal
 */
export function resolveCommandIngress(
  runtime: object,
  ingress: CommandIngress,
  agent: Agent,
): Readonly<Extract<CommandSource, { kind: 'interaction' }>> {
  const state = activeCommandIngress(ingress, agent)
  if (state.runtime !== runtime) {
    throw new Error('command ingress is inactive or does not belong to this runtime')
  }
  return Object.freeze({ kind: 'interaction', actor: state.actor })
}

function activeCommandIngress(ingress: CommandIngress, agent: Agent): CommandIngressState {
  const state = ingressStates.get(ingress)
  if (state === undefined || !state.active) {
    throw new Error('command ingress is inactive or does not belong to this runtime')
  }
  if (state.scope !== undefined && !scopeChainOf(agent).includes(state.scope)) {
    throw new Error('command ingress scope does not own the receiving agent')
  }
  return state
}
