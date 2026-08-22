/**
 * Scoped registrations for self-describing out-of-repository session events.
 * Persistence always reads the core carrier; registrations decide only
 * whether a prepared log may become a live session and who may append it.
 *
 * @module @deepseek-ai/dsh-session/extensions
 */

import type { Context } from '@deepseek-ai/cordis'
import { AnonymousEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import type { Session } from './index.ts'
import type {
  SessionEvent,
  SessionExtensionPayload,
  SessionExtensionRequirement,
  SessionExtensionType,
  SessionId,
} from './types.ts'

/** Durable identity and continuation policy for one plugin-owned event. */
export interface SessionExtensionDescriptor<K extends SessionExtensionType = SessionExtensionType> {
  /** Stable owner identity, normally the contributing npm package name. */
  readonly owner: string
  /** Namespaced owner-defined event identity. */
  readonly eventType: K
  /** Positive safe-integer payload version written and read by this registration. */
  readonly schemaVersion: number
  /** Whether the registration is required before the session becomes live. */
  readonly requirement: SessionExtensionRequirement
}

/** Carrier event narrowed to one registered extension payload. */
export type TypedSessionExtensionEvent<K extends SessionExtensionType> =
  Omit<SessionEvent<'session-extension/event'>, 'data'> & {
    readonly data: Omit<SessionEvent<'session-extension/event'>['data'], 'payload'> & {
      readonly payload: SessionExtensionPayload<K>
    }
  }

/** Fiber-owned registration and append capability for one extension event. */
export interface SessionExtensionRegistration<K extends SessionExtensionType> {
  /** Detached, frozen descriptor used by every append. */
  readonly descriptor: Readonly<SessionExtensionDescriptor<K>>
  /**
   * Append one payload to a live session whose captured scope sees this exact
   * registration. The payload is snapshotted by the session before commit.
   * @param session - live destination session.
   * @param payload - owner-defined lossless JSON payload.
   * @returns the committed core carrier event.
   */
  append(session: Session, payload: SessionExtensionPayload<K>): TypedSessionExtensionEvent<K>
  /** Test carrier metadata only; the owner still validates persisted payload data. */
  matches(event: SessionEvent): boolean
  /** Idempotently unregister this capability; its owning fiber does the same on unload. */
  dispose(): void
}

/** One required carrier that the target composition cannot interpret. */
export interface SessionExtensionCompatibilityIssue {
  readonly owner: string
  readonly eventType: string
  readonly schemaVersion: number
  readonly firstSeq: number
  readonly kind: 'missing-registration' | 'schema-version' | 'requirement'
  readonly registeredSchemaVersion?: number
  readonly registeredRequirement?: SessionExtensionRequirement
}

/** A valid log cannot become live under the target extension composition. */
export class SessionExtensionCompatibilityError extends Error {
  override readonly name = 'SessionExtensionCompatibilityError'

  constructor(
    readonly sessionId: SessionId,
    readonly issues: readonly SessionExtensionCompatibilityIssue[],
  ) {
    super(renderCompatibilityError(sessionId, issues))
  }
}

interface NormalizedDescriptor<K extends SessionExtensionType = SessionExtensionType>
  extends SessionExtensionDescriptor<K> {
  readonly key: string
}

interface ExtensionContribution {
  readonly descriptor: NormalizedDescriptor
  readonly scope: ScopeKey | undefined
  active: boolean
}

interface RequiredCarrier {
  readonly event: Extract<SessionEvent, { type: 'session-extension/event' }>
  readonly identity: string
  readonly requirementKey: string
}

class ExtensionLayer implements ScopeLayer {
  readonly contributions = new AnonymousEntries<ExtensionContribution>()

  isEmpty(): boolean {
    return this.contributions.isEmpty()
  }
}

/** Internal append bridge owned by SessionStore. */
export type AppendSessionExtension = <K extends SessionExtensionType>(
  session: Session,
  descriptor: Readonly<SessionExtensionDescriptor<K>>,
  payload: SessionExtensionPayload<K>,
  registrationScope: ScopeKey | undefined,
) => TypedSessionExtensionEvent<K>

/** Scoped registry implementation embedded in the mandatory SessionStore. */
export class SessionExtensionRegistry {
  private readonly layers = new ScopedLayers(
    () => new ExtensionLayer(),
    () => {},
  )

  constructor(private readonly appendEvent: AppendSessionExtension) {}

  /**
   * Register one descriptor in the calling context's scope.
   * @param ctx - registration context that supplies scope and effect ownership.
   * @param input - owner-defined exact descriptor.
   * @returns the fiber-owned typed append handle.
   */
  register<K extends SessionExtensionType>(
    ctx: Context,
    input: SessionExtensionDescriptor<K>,
  ): SessionExtensionRegistration<K> {
    const descriptor = normalizeDescriptor(input)
    const registrationScope = scopeOf(ctx)
    let contribution: ExtensionContribution | undefined
    const rawDispose = this.layers.effect(
      ctx,
      (layer) => {
        for (const existing of layer.contributions.values()) {
          if (existing.descriptor.key !== descriptor.key) continue
          if (!sameDescriptor(existing.descriptor, descriptor)) {
            throw new Error(
              `session extension "${descriptor.owner}/${descriptor.eventType}" conflicts with an active registration in the same scope`,
            )
          }
        }
        const registered = { descriptor, scope: registrationScope, active: true }
        contribution = registered
        const undo = layer.contributions.append(registered)
        return () => {
          registered.active = false
          undo()
        }
      },
      { label: 'sessions.registerEventExtension()', notify: false },
    )
    const registered = contribution
    if (registered === undefined) {
      throw new Error('session extension registration did not activate')
    }
    let disposed = false
    return {
      descriptor,
      append: (session, payload) => {
        if (!registered.active || disposed) {
          throw new Error(
            `session extension "${descriptor.owner}/${descriptor.eventType}" registration is inactive`,
          )
        }
        return this.appendEvent(session, descriptor, payload, registered.scope)
      },
      matches: event => event.type === 'session-extension/event'
        && event.data.owner === descriptor.owner
        && event.data.eventType === descriptor.eventType
        && event.data.schemaVersion === descriptor.schemaVersion
        && event.data.requirement === descriptor.requirement,
      dispose: () => {
        if (disposed) return
        disposed = true
        registered.active = false
        rawDispose()
      },
    }
  }

  /**
   * Resolve the nearest visible descriptor for one durable identity.
   * @param scope - viewing scope whose ancestor registrations are visible.
   * @param owner - durable owner identity.
   * @param eventType - owner-defined event type.
   * @returns the effective descriptor, or `undefined` when none is visible.
   */
  resolve(
    scope: ScopeKey | undefined,
    owner: string,
    eventType: string,
  ): Readonly<SessionExtensionDescriptor> | undefined {
    return this.visible(scope).get(extensionKey(owner, eventType))
  }

  /**
   * Refuse required carriers the target scope cannot interpret exactly.
   * @param sessionId - session identity used in the compatibility diagnostic.
   * @param events - complete candidate history.
   * @param scope - scope that would own the live session.
   */
  assertCompatible(
    sessionId: SessionId,
    events: readonly SessionEvent[],
    scope: ScopeKey | undefined,
  ): void {
    const visible = this.visible(scope)
    const required = new Map<string, SessionExtensionCompatibilityIssue>()
    for (const { event, identity, requirementKey } of requiredCarriers(events)) {
      const registered = visible.get(identity)
      let issue: SessionExtensionCompatibilityIssue | undefined
      if (registered === undefined) {
        issue = {
          owner: event.data.owner,
          eventType: event.data.eventType,
          schemaVersion: event.data.schemaVersion,
          firstSeq: event.seq,
          kind: 'missing-registration',
        }
      } else if (registered.schemaVersion !== event.data.schemaVersion) {
        issue = {
          owner: event.data.owner,
          eventType: event.data.eventType,
          schemaVersion: event.data.schemaVersion,
          firstSeq: event.seq,
          kind: 'schema-version',
          registeredSchemaVersion: registered.schemaVersion,
          registeredRequirement: registered.requirement,
        }
      } else if (registered.requirement !== 'required') {
        issue = {
          owner: event.data.owner,
          eventType: event.data.eventType,
          schemaVersion: event.data.schemaVersion,
          firstSeq: event.seq,
          kind: 'requirement',
          registeredSchemaVersion: registered.schemaVersion,
          registeredRequirement: registered.requirement,
        }
      }
      if (issue !== undefined) required.set(requirementKey, issue)
    }
    const issues = [...required.values()].sort((left, right) => left.firstSeq - right.firstSeq)
    if (issues.length > 0) throw new SessionExtensionCompatibilityError(sessionId, issues)
  }

  /**
   * Test whether one exact descriptor is visible from the destination scope.
   * @param scope - destination session scope.
   * @param descriptor - descriptor retained by the append handle.
   * @returns whether that descriptor is the effective visible registration.
   */
  isVisible(
    scope: ScopeKey | undefined,
    descriptor: Readonly<SessionExtensionDescriptor>,
  ): boolean {
    const visible = this.resolve(scope, descriptor.owner, descriptor.eventType)
    return visible !== undefined && sameDescriptor(visible, descriptor)
  }

  private visible(scope: ScopeKey | undefined): Map<string, NormalizedDescriptor> {
    const result = collectLayer(this.layers.global)
    for (const layer of this.layers.chainLayers(scope)) {
      for (const [key, descriptor] of collectLayer(layer)) result.set(key, descriptor)
    }
    return result
  }
}

/**
 * Build missing-registration issues when no live store can supply any registry.
 * @param events - exact session log whose required carriers need proof.
 * @returns one deduplicated missing-registration issue per required carrier/schema.
 */
export function unavailableRequiredExtensionIssues(
  events: readonly SessionEvent[],
): SessionExtensionCompatibilityIssue[] {
  return requiredCarriers(events).map(({ event }) => ({
    owner: event.data.owner,
    eventType: event.data.eventType,
    schemaVersion: event.data.schemaVersion,
    firstSeq: event.seq,
    kind: 'missing-registration',
  }))
}

function requiredCarriers(events: readonly SessionEvent[]): RequiredCarrier[] {
  const seen = new Set<string>()
  const required: RequiredCarrier[] = []
  for (const event of events) {
    if (event.type !== 'session-extension/event' || event.data.requirement !== 'required') continue
    const identity = extensionKey(event.data.owner, event.data.eventType)
    const requirementKey = `${identity}\0${event.data.schemaVersion}`
    if (seen.has(requirementKey)) continue
    seen.add(requirementKey)
    required.push({ event, identity, requirementKey })
  }
  return required
}

function collectLayer(layer: ExtensionLayer): Map<string, NormalizedDescriptor> {
  const result = new Map<string, NormalizedDescriptor>()
  for (const contribution of layer.contributions.values()) {
    if (contribution.active) result.set(contribution.descriptor.key, contribution.descriptor)
  }
  return result
}

function normalizeDescriptor<K extends SessionExtensionType>(
  input: SessionExtensionDescriptor<K>,
): NormalizedDescriptor<K> {
  const owner = normalizeName(input.owner, 'owner')
  const eventType = normalizeName(input.eventType, 'eventType') as K
  const schemaVersion = input.schemaVersion
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError('session extension schemaVersion must be a positive safe integer')
  }
  const requirement: unknown = input.requirement
  if (requirement !== 'required' && requirement !== 'ignorable') {
    throw new TypeError('session extension requirement must be "required" or "ignorable"')
  }
  return Object.freeze({
    owner,
    eventType,
    schemaVersion,
    requirement,
    key: extensionKey(owner, eventType),
  })
}

function normalizeName(value: unknown, field: 'owner' | 'eventType'): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('\0')) {
    throw new TypeError(`session extension ${field} must be a non-empty trimmed string without NUL`)
  }
  return value
}

function extensionKey(owner: string, eventType: string): string {
  return `${owner}\0${eventType}`
}

function sameDescriptor(
  left: Readonly<SessionExtensionDescriptor>,
  right: Readonly<SessionExtensionDescriptor>,
): boolean {
  return left.owner === right.owner
    && left.eventType === right.eventType
    && left.schemaVersion === right.schemaVersion
    && left.requirement === right.requirement
}

function renderCompatibilityError(
  sessionId: SessionId,
  issues: readonly SessionExtensionCompatibilityIssue[],
): string {
  const details = issues.map((issue) => {
    const identity = `${issue.owner}/${issue.eventType}@${issue.schemaVersion}`
    switch (issue.kind) {
      case 'missing-registration':
        return `${identity} is not registered`
      case 'schema-version':
        return `${identity} has registered schema version ${issue.registeredSchemaVersion}`
      case 'requirement':
        return `${identity} is registered as ${issue.registeredRequirement}`
    }
  })
  return `session "${sessionId}" requires compatible session extensions: ${details.join('; ')}`
}
