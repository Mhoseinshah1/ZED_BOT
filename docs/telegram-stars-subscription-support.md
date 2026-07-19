# Telegram Stars Subscription — Payment Support (`/paysupport`, Phase 2.1)

Telegram requires a working `/paysupport` for any bot that takes Stars payments.
Phase 2.1 (Part T) adds a self-contained payment-support surface for Stars
subscriptions that never exposes raw payment identifiers. See
`telegram-stars-subscription-recovery.md` for the surrounding operations and
`-reporting.md` for the admin financial report.

## Entry points

- The **`/paysupport`** command.
- The `user:psup:*` callbacks.

Both are registered **gate-free** so the support surface always reaches the user
(a maintenance/access gate must never block a payment-support request). Every
callback is **owner-scoped** — a user only ever sees their own charges.

## Landing page

`/paysupport` opens a payment-support landing that lists the user's **recent
MASKED Stars charges** and a set of problem categories.

## What is shown — masked only

Each listed charge shows only:

| Field | Shown |
| --- | --- |
| Date | ✅ |
| Amount | ✅ (Stars) |
| First-recurring flag | ✅ |
| State | ✅ — settlement / renewal / refund state |
| Reference | ✅ **masked** ref only |

## What is NEVER shown

- the full `telegram_payment_charge_id`,
- the invoice payload (`zedbot:sub:...`),
- any UUID (Payment / Order / CheckoutSession / subscription internal id),
- the bot token,
- the panel / service username.

The masked reference is display-only; it cannot be used to enumerate or reconstruct
a charge id.

## Problem categories → support ticket

The problem categories route into the **existing** `createSupportTicket` service
with **safe structured metadata only** — the same non-PII, non-secret metadata
policy as the masked display (category, subscription **short** id, safe state
strings; never a charge id, payload, UUID, token, or panel username). No new
ticketing pipeline is introduced; `/paysupport` is a structured front door onto the
existing support-ticket system.

## Relationship to notifications

The Phase 2.1 lifecycle notifications carry a safe **payment support** action
button (`y`) that lands here (see `notification-architecture.md` and
`telegram-stars-subscription-recovery.md`), so a user notified of a refund,
past-due or requires-action state has a one-tap path to masked support.
