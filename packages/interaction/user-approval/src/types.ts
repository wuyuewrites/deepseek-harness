/**
 * Wire-safe approval identifiers and outcome vocabulary, free of
 * cordis/service imports so browser type chains (apiproxy api → client) can
 * consume them without loading this package's Context augmentation.
 * @module @deepseek-ai/dsh-user-approval/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** A host-attested actor recorded with an interaction decision or command. */
export type InteractionActor =
  | {
    readonly kind: 'interactive-user'
    readonly channel: 'web' | 'cli'
    readonly principalId?: string
  }
  | {
    readonly kind: 'external-client'
    readonly channel: 'api' | 'acp'
    readonly clientId?: string
  }
  | { readonly kind: 'automation'; readonly provider: string }
  | { readonly kind: 'policy'; readonly policy: string }
  | { readonly kind: 'system' }

/** Actor kind a caller may require before treating an approval as a grant. */
export type RequiredInteractionActor = 'interactive-user'

/** A durable structured decision carrying host-minted provenance. */
export interface ApprovalDecision {
  /** Closed one-shot outcome selected by the answerer. */
  readonly outcome: ApprovalOutcome
  /** Host-minted provenance for this exact answer. */
  readonly decidedBy: InteractionActor
}

declare const ApprovalAnswerBrand: unique symbol

/** Opaque one-shot answer minted only by a trusted host ingress. */
export interface OpaqueApprovalAnswer {
  readonly [ApprovalAnswerBrand]: never
}

/** Backward-compatible answerer result: legacy outcome or opaque host answer. */
export type ApprovalAnswer = ApprovalOutcome | OpaqueApprovalAnswer
