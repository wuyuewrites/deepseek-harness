# Agent Note: Interaction actor provenance and last-mile admission

Status: implemented

English | [中文](2026-08-22-interaction-actor-provenance-and-last-mile-admission.zh.md)

## Problem

An approval outcome alone identifies neither the actor that selected it nor whether a command came from an interaction that the host can attest. A generic client can answer an API request, and an extension registration can disappear after an asynchronous tool or command admission has already begun. Treating either condition as a grant lets a policy mistake reach a body after the durable state says continuation is no longer compatible.

## Decision

`dsh-user-approval` owns the closed `InteractionActor` vocabulary and durable `ApprovalDecision` view. `approval/asked.requiredActor` and `approval/decided.decidedBy` are additive durable fields. Listeners cannot submit that structure: a static Host adapter creates an `ApprovalIngress`, whose opaque answer is bound to the exact service, frozen request, owner scope, and owner fiber. `ApprovalService` accepts legacy outcomes for ordinary approvals, but a required `interactive-user` converts a bare or nonmatching `allowed-once` into `unavailable` before returning it. `isActorQualifiedApprovalGrant()` gives replay consumers the same fail-closed predicate.

`dsh-commands` records legacy direct execution as `unattributed`; historical `user` sources remain readable but have no actor meaning. A static Host adapter receives an opaque `CommandIngress` from `createCommandIngress(owner, actor)` and calls `executeTrustedCommand()`. The runtime stores the actor outside the command wire, limits the capability to its owner scope, invalidates it with that owner fiber, and writes the captured actor to `command/run`. These Host helpers are root module exports, not Cordis service or Remote methods.

The generic API proxy writes `external-client/api`, and ACP writes `external-client/acp`. Neither transport proves an interactive gesture, and no shipped CLI adapter mints `interactive-user`. A deployment that needs that actor composes a dedicated UI or TTY ingress with its own verifiable gesture boundary.

Dynamic Host packages receive capability façades rather than raw Cordis services, Agents, or Sessions. Service symbols, descriptors, and prototypes expose no raw implementation; event and handler arguments contain allowlisted read-only Agent/Session views, so dynamic code cannot manufacture actor-bearing session records through `Session.append` or private log state.

`SessionStore.assertLiveEventExtensionsCompatible()` checks a live session through the scope captured at `enter()`. `ToolRuntime` calls it after all asynchronous admission and immediately before `ToolDefinition.execute`; `CommandRuntime` does the equivalent immediately before its handler. Commands also own `ctx.commands.guard()`, a scope-aware synchronous monotonic denial seam. A late extension loss therefore permits an audit error pair for commands but starts neither the command handler nor a tool body.

## Alternatives considered

- **Infer a human from a user message or transport name** — rejected: neither proves approval of an exact later action or a live UI gesture. The actor is minted only by same-process host ingress code and never arrives in approval or command wire data.
- **Make legacy records incompatible** — rejected: existing session logs remain readable. Their absent actor is intentionally insufficient for an actor-required consumer.
- **Check required extensions from the global runtime context** — rejected: agent-scoped registrations belong to the session entry's captured scope, not to `ToolRuntime` or `CommandRuntime`'s global service context.
- **Use reorderable waterfalls for final command denial** — rejected: a later listener could override or bypass policy. The command guard, like the tool guard, returns only a denial reason.

## Consequences

Human-required consumers can bind a durable approval or direct command to a host-attested actor without creating a second persistence store. Existing ordinary approvals and direct command callers continue to work but cannot satisfy human authority. Required extension unload, HMR, and reinstall are checked at the dispatch boundary rather than only when a turn opens; work that has already entered a body remains cooperative and cannot be retroactively cancelled. The missing interactive ingress is explicit product work, not a transport label that ECC or another consumer may reinterpret.
