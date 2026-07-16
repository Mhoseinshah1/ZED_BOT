# Service lifecycle — origins, statuses and the capability resolver

A short map of how a `Service` lives after creation, regardless of where
it came from. Deeper dives: `docs/service-renewal-phase12.md`,
`docs/extra-volume-phase16.md`, `docs/extra-time-phase17.md`,
`docs/service-toggle-phase18.md`, `docs/service-link-regeneration-phase19.md`,
`docs/service-operation-concurrency.md`, `docs/free-trial-lifecycle.md`.

## Origins

`Service.source` (`PAID` / `FREE_TRIAL` / `ADMIN_CREATED`) records how
the service was **created** and is immutable. Since the trial-lifecycle
phase, **origin never gates capability**: trial services are first-class
lifecycle citizens — renewal, extra volume, extra time, toggle and link
regeneration all follow the same per-action rules as paid services. A
`FREE_TRIAL` service has `orderId NULL` / `productId NULL`; package
selection is panel-scoped for every service (active products of
`service.panelId` — never the original order's product), so the missing
order changes nothing.

The first verified paid operation on a trial stamps
`Service.convertedToPaidAt` + `firstPaidOrderId` exactly once (CAS on
`convertedToPaidAt IS NULL`, same transaction as the operation's
completion) — see `docs/free-trial-lifecycle.md`.

## The capability resolver

`resolveServiceDetailActions` (`apps/bot/src/services/user-services.service.ts`)
decides which action buttons the detail page renders, with one panel
read. Each action requires ALL of:

1. adapter capability (`panelOperationAvailable` — see
   `docs/panel-capabilities.md`);
2. remote-model gate: `serviceSupportsGlobalLifecycle` (XUI must be
   `GLOBAL_CLIENT`; legacy per-inbound services hide every mutating
   action);
3. panel `ACTIVE` (for renew / extra volume / extra time);
4. the action's status list;
5. quota shape (extra volume needs `volumeBytes > 0`; extra time needs
   `expiresAt !== null`).

Status lists:

| Action | Statuses |
| --- | --- |
| renew (`RENEWABLE_STATUSES`) | `ACTIVE`, `EXPIRED`, `LIMITED`, `DISABLED` |
| extra volume | `ACTIVE`, `LIMITED` |
| extra time | `ACTIVE`, `EXPIRED`, `LIMITED`, `DISABLED` |
| toggle / regenerate link | their own phase rules (`availableToggleAction`, `linkRegenerationEligibility`) |

Buttons the flags hide are simply not rendered (capability model — no
dead buttons); the click routes re-validate everything server-side, so a
stale button fails safely. Every post-payment dead end (missing service,
inactive panel, legacy XUI, definite panel failure) refunds; UNKNOWN
panel outcomes defer to startup reconciliation instead of refunding.

## Trial specifics

- Detail-page origin label: «نوع سرویس: اکانت تست رایگان» before
  conversion, «نوع سرویس: شروع‌شده با اکانت تست» after.
- The trial sweep expires unconverted trial services when their claim
  expires, but never touches a converted service (or one whose paid
  renewal pushed `expiresAt` into the future) — those belong to the paid
  lifecycle from conversion on.
