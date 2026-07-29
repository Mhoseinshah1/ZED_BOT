# Mini App parity — execution ledger

A recovery ledger, not a substitute for implementation. Updated after every
completed feature and every pushed stack layer, so a session that ends mid-flight
can be resumed without re-deriving the state.

Read `docs/miniapp-user-parity-matrix.md` first; this file records only what has
actually been built, tested and pushed.

## Stack layers

| Layer | Branch | PR | Base | State |
| --- | --- | --- | --- | --- |
| 1 | `claude/miniapp-wallet-renewal` | #144 (Draft) | `main` | IN PROGRESS |
| 2 | `claude/miniapp-payment-parity` | not created | layer 1 | NOT STARTED |
| 3 | `claude/miniapp-delivery-service-parity` | not created | layer 2 | NOT STARTED |
| 4 | `claude/miniapp-user-feature-parity` | not created | layer 3 | NOT STARTED |
| 5 | `claude/miniapp-final-ui` | not created | layer 4 | NOT STARTED |

## Layer 1 — commerce authority and financial core

### Landed

| Item | Commit | Evidence |
| --- | --- | --- |
| `packages/service-renewal` scaffold + contract | `fafaacf` | builds clean; closed result-code set, option public-id convention, quote TTL, confirm body limit, idempotency-key shape |
| Rollout gate `miniapp_wallet_renewal_enabled`, default **false** | `fafaacf` | uncached read, fails closed on missing row / malformed value / unreadable DB; not `isPublic` |
| Parity matrix + this ledger | `0bb2ae5` | 34 real capabilities inventoried; 2 placeholders excluded with evidence |
| Docker workspace coverage repair | `d344b94` | `service-renewal` added to both install stages + runtime; deploy-scripts 2 failed → 32 passed |
| Panel capability predicates extracted | `b197b87` | moved to `@zedbot/service-renewal`, bot re-exports; one implementation |
| Unused-import cleanup after extraction | `e1e575a` | CI Lint caught what tsc did not |
| **§A owner-scoped Service resolution** | `8ea8ecb` | `resolveOwnedService` in the domain package; 14 DB-backed tests; mutation (drop `userId` from WHERE) fails exactly RS-5 + RS-13; CI green |
| **§B renewal / extra-volume / extra-time option authority** | `b2fd7a3` | one `OPERATION_RULES` table replaces three near-identical modules; bot re-exports; 28 DB-backed tests; 4 mutations each caught; CI #361 green |
| **§C checkout draft, discount, frozen snapshot, quote** | `cf04acc` | `CheckoutSession` reused (no second table); AES-256-GCM sealed quote; 16 API tests + `SNAP-1` bot parity; 3 mutations each caught |
| **OWNER rollout page** | `ded9590` | `admin:mini_app_settings` graduated out of the placeholder list; all five switches visible, CAS-toggled, with scopes; 6 tests |
| **§D shared wallet settlement** | `ded9590` | `settleWalletOrder` in the domain package, bot delegates; payload-bound idempotency; low-balance observer moved; 19 DB tests with real concurrency; 6 mutations each caught |
| **Username reservation + adapter factory + catalog reads** | `0e59046` | reservation engine, panel-adapter factory and catalog reads moved; panel probe injectable so bot mocks still intercept; `createPurchaseCheckout`; 12 tests |

### Next unresolved invariant (start here)

**§E — the shared Panel execution and reconciliation boundary.** Everything up
to and including "the money moved and a PAID Order exists" is now shared. What
is NOT shared is what happens next: turning a PAID Order into a remote account,
a renewal, added volume or added time.

The authorities to reuse, all in `apps/bot/src/services/`:

| Executor | Entry point |
| --- | --- |
| new subscription | `provisioning.service.ts` → `provisionPaidOrder(orderId)` |
| renewal | `service-renewal.service.ts` |
| extra volume | `extra-volume.service.ts` → `executeExtraVolumeOrder(orderId)` |
| extra time | `extra-time.service.ts` → `executeExtraTimeOrder(orderId)` |
| recovery | `startup-recovery.service.ts` → `recoverStaleProvisioningOrders`, `classifyMutationState` |

They are NOT queue-driven today: the bot calls them inline after payment and
`runStartupRecovery` sweeps what was left PROVISIONING. So the API cannot reach
them by enqueuing; they have to move into `packages/service-renewal` the way the
settlement did, or gain a queue both transports can post to.

Their remaining unportable dependencies are the bot logger, the service lock
(`service-lock.service.ts`, Redis-backed) and the trial-conversion hook. The
panel adapter factory they need is already in the package (`0e59046`).

The invariant §E must establish: a timeout after the panel may have accepted an
operation NEVER triggers a blind second grant. One financial effect, one
operation intent, durable reconciliation state, and a refund only on a DEFINITE
failure — never on an uncertain one, because the remote mutation may already
have succeeded.

### Not yet landed in layer 1

- **§E** provisioning / add-on execution / reconciliation (see above).
- **§F** the authenticated Mini App commerce API endpoints and their transport
  security. The domain they would call is now complete for catalog, options,
  drafts, discounts, quotes and settlement; what is missing is the HTTP surface,
  its gates and its DTO allowlists.
- **§G** every Mini App commerce screen.
- **§H** the full-branch review, security review and validation battery.
- **OTHER_PRODUCT purchase** (matrix #16) stays out of layer 1: its checkout
  needs the customer-input form the matrix assigns to **L3** (#17). Selling one
  without it would take money for something that cannot be fulfilled.

### Blocking dependency — RESOLVED in `b197b87`

The predicates now live in `packages/service-renewal/src/panel-capability.ts`
and `panel-readiness.service.ts` re-exports them, so bot call sites are
unchanged. Owner-scoped renewable resolution is now unblocked.

The analysis that led there is kept below because it records why the obvious
home was the wrong one.

### Superseded analysis — kept for its reasoning, NOT for its conclusion

> **Superseded by `b197b87`.** The conclusion below — "move the capability layer
> into `@zedbot/panel-adapters`" — is **wrong and was not implemented**. The
> predicates consume Prisma `Panel`/`Service` row types, and
> `@zedbot/panel-adapters` has zero dependencies and is deliberately
> storage-independent; hosting them there would have made the adapter layer
> depend on the schema. They landed in `@zedbot/service-renewal` instead, which
> imports the capability tables *from* panel-adapters. **Capability extraction
> is complete. It is not pending and must not be redone.**
>
> The dependency analysis in the table below is still accurate and is why the
> move was possible at all; only the destination changed.

Owner-scoped renewable resolution cannot move out of the bot until three
predicates move with it: `panelTypesSupporting`, `serviceSupportsGlobalLifecycle`
and `panelOperationAvailable`. All three live in
`apps/bot/src/services/panel-readiness.service.ts`, which is not portable — it
imports the bot logger.

The predicates themselves are portable. Their transitive needs are:

| Predicate | Depends on | Portable? |
| --- | --- | --- |
| `panelTypesSupporting` | `MARZBAN_CAPABILITIES`, `XUI_CAPABILITIES` | yes — already `@zedbot/panel-adapters` |
| `panelSupportsOperation` → `panelCapabilities` | + `SUPPORTED_XUI_VARIANTS`, `resolveXuiVariant` | yes — `panel-adapter-factory.ts` imports only `@zedbot/database`, `@zedbot/panel-adapters`, `@zedbot/shared` |
| `panelOperationAvailable` | + `panelHasCredentials` | yes — local and pure |
| `serviceSupportsGlobalLifecycle` | `classifyXuiRemoteModel` | yes — local and pure |

**What was actually done** (`b197b87`): the pure capability layer moved into
`packages/service-renewal/src/panel-capability.ts`, and
`panel-readiness.service.ts` re-exports every symbol so no bot call site
changed. Duplicating them was ruled out by the no-second-implementation
guardrail; hosting them in `@zedbot/panel-adapters` was ruled out because that
package must not learn about Prisma.

## Validation runs

| Layer | Gate | Result |
| --- | --- | --- |
| 1 | API suite | 205 passed, 1 skipped (206) |
| 1 | Bot suite | 2896 passed, 62 skipped (2958) |
| 1 | Mini App suite | 109 passed (109) |
| 1 | typecheck | clean, 11 packages |
| 1 | lint | clean |
| 1 | workspace build | clean, 11 packages |
| 1 | fresh migrate deploy + seed | applied; 26/26 settings, 131 templates, 156 button texts |
| 1 | CI `e1e575a` | **all 3 jobs success** — typecheck/lint/build/validate, legacy production upgrade, Docker backup smoke (real image build) |
| 1 | §A resolution suite | 14 passed (14) |
| 1 | CI `8ea8ecb` | **all 3 jobs success** |
| 1 | §B option suite | 28 passed (28) |
| 1 | §C checkout/quote suite | 16 passed (16) |
| 1 | §C snapshot parity (bot suite) | 1 passed (1) |
| 1 | API suite after §C | 263 passed, 1 skipped (264) |
| 1 | CI `b2fd7a3` (§B) | **all 3 jobs success** — run #361 |
| 1 | CI `d3fc36f` (§C + docs) | **all 3 jobs success** — run #363 |
| 1 | OWNER rollout suite | 6 passed (6) |
| 1 | §D settlement suite | 19 passed (19) |
| 1 | purchase/catalog suite | 12 passed (12) |
| 1 | API suite after the extractions | 294 passed, 1 skipped (295) |
| 1 | Bot suite after §D | 2583 passed, 375 skipped, 7 pre-existing env failures (2965) |

### Mutation evidence

| § | Mutation | Tests that failed | Restored |
| --- | --- | --- | --- |
| A | Remove `userId` from the resolver's WHERE clause | `RS-5`, `RS-13` (2 failed, 12 passed) | yes — 14/14 |
| B | Remove Product active / Category-active eligibility | `OPT-4`, `OPT-17` (2 failed, 26 passed) | yes — 28/28 |
| B | Remove Panel compatibility (same-panel + capability) | `OPT-25`, `OPT-26` (2 failed, 26 passed) | yes — 28/28 |
| B | Expose the Product uuid as the public option id | `OPT-15`, `OPT-16`, `OPT-17`, `OPT-18`, `OPT-19`, `OPT-20`, `OPT-22`, `OPT-23`, `OPT-24` (9 failed, 19 passed) | yes — 28/28 |
| B | Skip the eligibility recheck during option resolution | `OPT-17` (1 failed, 27 passed) | yes — 28/28 |
| C | Drop the quote's user binding | `CO-16` (1 failed, 15 passed) | yes — 16/16 |
| C | Skip stale revalidation (constant fingerprint) | `CO-13`, `CO-14`, `CO-15` (3 failed, 13 passed) | yes — 16/16 |
| C | Quote from the live Product price, not the frozen draft | `CO-14` (1 failed, 15 passed) | yes — 16/16 |
| D | Remove idempotency (fast path AND P2002 recovery) | `WS-6`, `WS-7`, `WS-8`, `WS-10`, `WS-14`, `WS-16` (6 failed, 13 passed) | yes — 19/19 |
| D | Make the wallet debit non-atomic (read-then-write) | `WS-11`, `WS-12` (2 failed, 17 passed) | yes — 19/19 |
| D | Resolve the replay AFTER mutable preconditions | `WS-7` (1 failed, 18 passed) | yes — 19/19 |
| D | Permit two Payments for one CheckoutSession | `WS-13`, `WS-14` (2 failed, 17 passed) | yes — 19/19 |
| D | Omit the low-balance observation | `WS-18` (1 failed, 18 passed) | yes — 19/19 |
| D | Claim the discount outside the financial transaction | `WS-17` (1 failed, 18 passed) | yes — 19/19 |

The §D idempotency mutation ALSO survived its first attempt, for a third
distinct reason worth recording: removing the pre-transaction replay lookup
alone changed nothing, because the unique `idempotencyKey` index still raised
P2002 and the catch resolved the replay from there. Idempotency here has two
layers, and a mutation that removes one is not a mutation. Only disabling both —
and the unique key itself — exposed the six cases above.

The §B panel-compatibility mutation **survived** its first run (28/28 still
passed) and that is why `OPT-25` and `OPT-26` exist. The listing query already
filters `panelId`, so no listing-level test could observe the predicate being
removed — but the BOT does not reach the predicate through that query:
`payRenewalDraftWithWallet` loads the product by the id in the session draft and
the predicate is the only panel check before money moves. The two new cases
assert it directly, each with a control that fails if some other rule is what
fired.

The §C stale-revalidation mutation also appeared to survive its first run. It
had not been applied: the fingerprint separator was a raw NUL byte, the
`replace` never matched, and the build kept the original. The separator is now
the escape `\u0000` (the file was literally binary before), the mutation applies,
and it fails three cases.

**Sandbox baseline for the bot suite.** In this container the bot suite reports
7 pre-existing failures — `log-group-wizard` (3), `stars-subscription` (3),
`low-balance-worker` L46 (1) — and ~375 skips rather than CI's 62. Each failure
reproduces identically on the untouched baseline `c6e3b0f` with the branch
stashed, so none is branch-caused; they need service dependencies this sandbox
does not provide. CI is the authoritative bot result.

Local Docker build is not possible in this sandbox: the egress policy returns
403 for `production.cloudfront.docker.com` (the BuildKit frontend blob) and for
`dl-cdn.alpinelinux.org` plus seven Alpine mirrors. CI performs the real image
build and is the authoritative result; it passes.

### CI defect history for this layer

`7766143` failed **all three** jobs — the missing Docker workspace coverage
broke the image build, the legacy upgrade and the validate job together.
`d344b94` fixed the Dockerfile. `b197b87` still failed Lint alone (unused
imports the extraction orphaned; tsc does not flag those). `e1e575a` is green.

No layer may be reported complete until its CI is green. Nothing here has been
deployed and every rollout switch remains disabled.
