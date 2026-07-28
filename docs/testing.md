# ZED_BOT tests

The repo uses **Vitest** (first and currently only test framework, added
with the wallet-payment race fix). Scope today: PostgreSQL integration
suites for the security-critical wallet balance mutations — the user
wallet-payment deduction (`tests/wallet-payment.race.test.ts`) and the
Phase 20 admin manual adjustments (`tests/admin-user-wallet.test.ts`).

## Layout

| Path | Purpose |
| --- | --- |
| `apps/bot/vitest.config.ts` | Vitest config (picks up `tests/**/*.test.ts`) |
| `apps/bot/tests/wallet-payment.race.test.ts` | Wallet race + idempotency integration tests |
| root `package.json` → `"test": "pnpm -r --if-present run test"` | Runs every workspace package that defines a test script |
| `apps/bot/package.json` → `"test": "vitest run"` | The bot package's test entry |

Tests live in `tests/` (outside `src/`) so `pnpm build` never compiles them
into `dist`.

## Requirements: a disposable PostgreSQL

The wallet tests exercise **real transactions** (row locks, conditional
`updateMany`, unique-key blocking) — the guarantees they prove cannot be
mocked. They therefore need `DATABASE_URL` pointing at a **migrated,
DISPOSABLE** PostgreSQL database. The suite creates users/panels/products/
orders in it; never point it at a real database.

```bash
# one-time: create + migrate a throwaway DB (any PostgreSQL 16 works)
createdb zedbot_test
DATABASE_URL="postgresql://postgres@127.0.0.1:5432/zedbot_test" pnpm db:deploy

# run the tests
DATABASE_URL="postgresql://postgres@127.0.0.1:5432/zedbot_test" pnpm test
```

**Without `DATABASE_URL` set, the DB suites skip themselves** and `pnpm
test` still exits 0 (a placeholder test states "wallet payment integration
tests require DATABASE_URL"), so the command is safe in environments with
no database — but a skipped run proves nothing; only a run against
PostgreSQL verifies the race behavior.

## CI

`.github/workflows/ci.yml` runs `pnpm test` on every push/PR to `main`
(step **"Run tests"**). The job already provides everything the DB suites
need: a `postgres:16` service container on `localhost:5432`, a job-level
`DATABASE_URL` (`postgresql://zedbot:…@localhost:5432/zedbot`), `pnpm
db:generate` for the Prisma client, and `pnpm db:deploy` (the repo's
standard `prisma migrate deploy`) + seed **before** the test step — so in
CI the wallet race tests always execute for real; they never skip. The
seeded rows don't interfere: every test run creates its own uniquely-tagged
users/panels/products.

## What the wallet suite proves

1. **Concurrent DIFFERENT drafts cannot overspend** — user at 100,000
   Toman, two drafts at 80,000 with different `draftNonce`s fired via
   `Promise.all`: exactly one settles (one PAID Order, one Payment, one
   SPEND WalletTransaction with before 100,000 / after 20,000), the other
   returns `INSUFFICIENT_BALANCE_TEXT` and rolls back completely; the final
   balance is exactly 20,000 and never negative.
2. **Same draft double-click stays idempotent** — one `draftNonce` fired
   twice concurrently: both calls resolve ok with the same order/payment,
   at most one reports `alreadyPaid`, and exactly one
   Payment/Order/SPEND row exists — the balance moves once.

These tests were verified red against the pre-fix code (both drafts
settled, proving the old read-check-then-decrement raced) and green on the
conditional-`updateMany` fix.

## Fixtures / isolation

Every run tags its rows with a timestamp-derived id, so re-running against
the same throwaway database does not collide. Rows are intentionally left
behind (disposable DB) — drop/recreate the database to reset.

**Recreate it before a full battery run.** Most suites only touch rows they
created, so accumulation is harmless to them. The **low-balance** suites are
different by design: they drive the worker's reconcile and backfill, which sweep
*every* active user and *every* `LowBalanceAlertState` row, one transaction per
unit. That is the correct production behaviour — a reconciler that skipped rows
it did not recognise would miss exactly the users nobody warned — but it means
their runtime scales with whatever the database has accumulated, not with their
own fixtures.

Measured on this repository: on a database carrying 7,644 users and 7,441 state
rows left by earlier runs, the six low-balance suites exceed vitest's timeouts
and report ~15 failures; on a freshly migrated database the same 124 tests pass
in ~34s. The failures are an artifact of a stale throwaway database, not of the
code under test — so drop and recreate before running the battery, and do not
"fix" them by raising a timeout.

```bash
psql "$ADMIN_URL" -c 'DROP DATABASE IF EXISTS zedbot_test WITH (FORCE);' \
                  -c 'CREATE DATABASE zedbot_test;'
DATABASE_URL="postgresql://postgres@127.0.0.1:5432/zedbot_test" pnpm db:deploy
```

## Redis-backed suites

The per-service operation lock suites
(`service-operation-concurrency.test.ts`, `startup-recovery.test.ts`,
`panel-provisioning-e2e.test.ts`) additionally require a reachable Redis: set `REDIS_URL` (or
`REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`) to a disposable
password-protected instance, e.g.

```bash
redis-server --port 6490 --requirepass test-pw --daemonize yes --save ""
export REDIS_URL="redis://:test-pw@127.0.0.1:6490"
```

Without it those suites self-skip. CI starts its password-protected Redis
before the test step. Service mutation pipelines FAIL CLOSED without the
lock backend, so running them against a real flow always needs Redis.

## Panel HTTP-contract suites

`marzban-provisioning.test.ts` and `xui-provisioning.test.ts` run mock
HTTP servers reproducing the real panel API contracts and need neither
PostgreSQL nor Redis. They set `PANEL_HTTP_TIMEOUT_MS` to a small value
before importing the adapters so the timeout scenarios finish quickly.
`staging-panels.test.ts` is opt-in and runs only with `MARZBAN_STAGING_*`
/ `XUI_STAGING_*` environment variables (never point them at production
panels - see docs/marzban-provisioning.md and docs/xui-provisioning.md).
