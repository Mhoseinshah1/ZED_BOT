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

### Blocking dependency — RESOLVED in `b197b87`

The predicates now live in `packages/service-renewal/src/panel-capability.ts`
and `panel-readiness.service.ts` re-exports them, so bot call sites are
unchanged. Owner-scoped renewable resolution is now unblocked.

The analysis that led there is kept below because it records why the obvious
home was the wrong one.

### Original analysis — extraction path

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
