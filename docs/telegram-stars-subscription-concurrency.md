# Telegram Stars Subscription — Concurrency & Invariants

## Idempotency spine

```
one Service              → one automation funding method   (mandate serviceId @unique)
one telegram_charge_id   → one charge row                  (@unique)
one charge               → one Payment                     (@unique)
one charge               → one CheckoutSession              (@unique)
one charge               → one Order                        (@unique)
one charge               → at most one applied renewal
one failed charge        → at most one Stars refund
no charged cycle silently disappears
```

## Race handling

| Race | Resolution |
| --- | --- |
| Two initial `successful_payment` updates | charge id `@unique` + CAS RECEIVED→SETTLING; one settles, the other returns the existing result |
| Two recurring updates for the same charge | same charge id → idempotent replay |
| Manual renewal vs. recurring renewal | the per-service Redis lock inside `executeRenewalOrder` serialises both; each unique charge applies exactly one renewal from the authoritative current expiry |
| Wallet mandate vs. Stars enrollment | mandate `serviceId @unique` — one wins; a Stars enrollment flips the mandate only with explicit supersede consent |
| Two enrollment confirmations | `upsert` on the mandate + a live-pending reuse — never two subscriptions/mandates |
| Duplicate refund calls | compare-and-set on the charge status — one refund only |
| Restart after charge, before local Payment | the charge id arrives again (or worker recovery replays) and settles once |
| Restart after settlement, before fulfilment | the charge is `FULFILLING` with an Order; re-drive dispatches fulfilment idempotently |

Database constraints and compare-and-set transitions are authoritative; Redis
locks are coordination only.
