# ZED_BOT tests

The repo uses **Vitest** (first and currently only test framework, added
with the wallet-payment race fix). Scope today: one PostgreSQL integration
suite for the security-critical wallet balance deduction.

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
test` still exits 0 (a placeholder test documents the skip), so the command
is safe in environments with no database — but a skipped run proves
nothing; only a run against PostgreSQL verifies the race behavior.

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
