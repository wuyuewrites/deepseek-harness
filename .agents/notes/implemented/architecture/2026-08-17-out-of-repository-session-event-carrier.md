# Agent Note: Out-of-repository session event carrier

Status: implemented

English | [中文](2026-08-17-out-of-repository-session-event-carrier.zh.md)

## Problem

`SessionEventMap` declaration merging gives an out-of-repository plugin a compile-time event type, but the generated first-party `KNOWN_SESSION_EVENT_TYPES` cannot include that plugin. A required unknown event therefore makes the next persistence read refuse the session, while adding runtime registrations to the known set would make ordinary inspection depend on the mounted composition. The [session-log version mechanism](2026-08-10-session-log-version-mechanism.md) deliberately deferred this case until a consumer needed durable plugin state.

The session must remain inspectable, queryable, and exportable when an owner plugin is absent. Live continuation must still refuse when ignoring that plugin would discard required state, and SQLite suffix reads must not need an earlier declaration record.

## Decision

`dsh-session` owns one core-known, log-only `session-extension/event` carrier. Every carrier repeats a stable owner, owner-defined event type, positive schema version, `required` or `ignorable` continuation requirement, and lossless JSON payload. An ignorable carrier also carries the envelope's `ignorable: true`; a required carrier never does. The carrier is self-describing at every sequence position, so `readFrom()` can return an independently interpretable suffix.

`SessionStore.registerEventExtension()` registers an exact descriptor in the calling scope and returns a fiber-owned handle. The handle snapshots carrier data through `Session.append()`, rejects after disposal, and refuses a destination session whose captured scope cannot see that descriptor. Identical registrations in one scope coexist for reload overlap; a conflicting schema version or requirement in that layer fails without replacing the active registration.

Persistence inspection, loading, suffix reads, crash repair, and detached preparation treat the carrier as ordinary core-known data and never consult the registry. `SessionStore.enter()` checks required carriers against the calling scope before publication and captures that scope; `announce()` checks it again immediately before the creation edge. A required registration that disappears during a live turn does not prevent `turn/end`, but the next `turn/start` checks before commit and refuses until the exact registration returns. Fork publication passes through the same checks, while a fork boundary before the first required carrier needs no registration.

Compatibility is exact in this first implementation: owner, event type, schema version, and requirement all match. `SessionExtensionCompatibilityError` distinguishes a valid log that cannot run under the target composition from an unsupported session format or corrupt data.

## Alternatives considered

**Add plugin event names to the runtime known set.** This makes `inspect`, `load`, and `readFrom` succeed or fail according to the current composition and recreates the lean-versus-full reader inconsistency the version mechanism rejected.

**Persist one declaration before later plugin events.** A SQLite `readFrom()` beginning after that declaration cannot interpret the returned suffix without loading the prefix, defeating the suffix contract and projection-cache use case.

**Give the registry to an optional meta-plugin.** Direct `SessionStore.create()`, `fork()`, `enter()`, and `turn/start` would still need a mandatory admission hook in `dsh-session`; keeping the registry there removes the optional bypass while still letting plugins extend the session plugin.

**Store plugin state in a second ledger or workspace file.** That loses native fork lineage, session-scoped recovery, and one append-only authority, and it makes model-visible projection require another synchronization path.

**Mark every external event ignorable.** A missing owner could then silently resume without state that changes future control decisions. The writer must make that promise per descriptor instead of receiving a permissive default.

## Verification

Package tests pin carrier validation and freezing, scoped registration lifetime, conflicting registrations, enter/announce rollback, turn admission after unload, cross-scope denial, and fork boundaries. The shared persistence contract round-trips required and ignorable carriers through memory, JSONL, Zstandard JSONL, and SQLite operations without the owner plugin. Agent-loop resume tests prove detached inspection succeeds, missing required registration blocks publication, and scoped setup can install the exact descriptor before `enter()`.

## Consequences

The carrier adds an ordinary event type without changing the session envelope, JSONL encoding, SQLite schema, or `SESSION_FORMAT_VERSION`. Older readers skip an ignorable carrier and refuse a required carrier as an unknown required event, preserving the existing failure direction.

A required carrier permanently makes its exact descriptor part of live continuation for every prefix that contains it. Version sets, payload upgraders, generic dependency release, and specialized Web presentation remain deferred until another consumer supplies concrete behavior to test. The owner plugin continues to own payload validation, folds, projections, and relational invariants; registration establishes availability, not semantic correctness or execution authority.
