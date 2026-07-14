# Provisioning idempotency (identity edition)

How a PAID order becomes exactly one remote account and one Service row —
and why retries, races, crashes and admin edits can never mint a second
identity. Complements `docs/provisioning-phase9.md` (the original pipeline)
and `docs/service-naming-strategies.md` (how the identity is chosen).

## The identity chain

```
Admin selects a naming strategy (Panel)
  → checkout captures strategy + config      (CheckoutSession.productSnapshot)
  → naming gate blocks payment while the strategy's config is incomplete
  → first provisioning attempt resolves the identity ONCE
      (sequence reserved atomically / random generated once)
    and persists Order.namingSnapshot with a CAS (namingSnapshot IS NULL)
  → lock key, adapter input, Service row, retries and reconciliation
    all read namingSnapshot.resolvedRemoteUsername
```

Invariant: **same order + same naming snapshot = same normalized remote
name, forever.** Random parts and sequence numbers live in the snapshot;
nothing about the identity is ever recomputed from mutable Product, Panel
or User data after payment.

## Layered guards (unchanged semantics, identity-aware)

1. **Distributed lock** `zedbot:service-provisioning:<panelId>:<username>`
   — the username now comes from the snapshot (legacy generator only for
   pre-naming in-flight orders), so live provisioning and startup
   reconciliation still contend on the same key.
2. **Existing Service short-circuit** — a Service for the order wins over
   everything and is never renamed.
3. **PAID → PROVISIONING claim** (compare-and-set) — one caller wins.
4. **Adapter-level recovery** — a 409/conflict on create re-reads the
   remote account and recovers it ONLY when the order marker note
   (`zedbot order:<short> tg:<id>`) proves ownership; name equality alone
   never adopts.
5. **Post-success persistence ladder** — service-by-order, repair-by-
   username (same user only), one retry, refund. All keyed on the stored
   identity.
6. **Startup reconciliation** — probes the panel for the EXACT stored
   username under the same lock; completes or refunds from panel truth.

## Failure behavior

- Naming config incomplete BEFORE payment → checkout blocked, user never
  charged.
- Naming resolution fails on a PAID order (should be unreachable thanks to
  the gate) → definite pre-remote failure → existing FAIL + wallet refund
  path; nothing was attempted remotely.
- Remote outcome UNKNOWN → order stays PROVISIONING, never refunded on
  uncertainty; reconciliation settles it using the stored identity.
- Local name collision (another order owns the name) → deterministic
  order-derived suffix; a second collision is a safe failure, never an
  overwrite or adoption.

## Versioning

Every snapshot records `version` (`NAMING_STRATEGY_VERSION = 1`). If
normalization or strategy semantics ever change, bump the version and keep
the v1 resolver reproducible — historical orders are always served from
their STORED resolved values, so a version bump can never rename them.
