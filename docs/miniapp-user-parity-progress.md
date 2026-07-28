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
| Parity matrix + this ledger | this commit | 34 real capabilities inventoried; 2 placeholders excluded with evidence |

### Not yet landed in layer 1

- Owner-scoped renewable-Service resolution moved into the package.
- Renewal option listing, plan validity, frozen snapshot, authoritative quote.
- Wallet settlement seam callable from both transports.
- Provisioning intent + result classification boundary.
- Catalog / product detail / pre-invoice / discount flows.
- New-subscription purchase, extra volume, extra time.
- The API endpoints and their transport security.
- Every Mini App screen for the above.
- The entire DB-backed test matrix, concurrency tests and mutation tests.
- The full validation battery for the layer.

### Blocking dependency — analysed, with the extraction path

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

**Recommended path:** move the pure capability layer into
`@zedbot/panel-adapters`, beside the capability tables it already owns, and have
both `apps/bot` (re-export from `panel-readiness.service.ts`, so no call site
changes) and `@zedbot/service-renewal` import from there. Duplicating them into
the renewal package is explicitly ruled out by the no-second-implementation
guardrail.

This is the first task of the next session; nothing downstream of it in layer 1
can proceed first.

## Validation runs

| Layer | Battery | Result |
| --- | --- | --- |
| 1 | full repository battery | **not yet run for this layer** |

No layer may be reported complete until its CI is green. Nothing here has been
deployed and every rollout switch remains disabled.
