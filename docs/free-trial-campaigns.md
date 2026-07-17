# Free-trial reset campaigns — the durable bulk-grant queue

Bulk reset/grant campaigns give many users fresh trial allowance in one
audited operation. The design is a **database-backed queue** named
`free-trial-entitlement-campaign`: the campaign row plus its recipient
snapshot rows ARE the queue, processed by a small in-bot loop.

Source of truth:
`apps/bot/src/services/free-trial-campaign.service.ts` (queue, loop,
audiences, skip rules),
`apps/bot/src/handlers/admin-settings/trial-entitlements.handler.ts`
(OWNER-only builder + dashboard),
`packages/database/prisma/schema.prisma` (`FreeTrialResetCampaign`,
`FreeTrialCampaignRecipient`). Tests:
`apps/bot/tests/trial-campaigns.test.ts`.

## Queue architecture — and why the loop runs in-bot

```
createCampaignDraft ─► DRAFT ─previewCampaign─► PREVIEWED
        ─startCampaign (CAS + snapshot)─► QUEUED
        ─loop claims─► RUNNING ─no PENDING left─► COMPLETED
                         │                          FAILED (invalid stored audience)
                         └── cancelCampaign ─► CANCELLED (any pre-terminal status)
```

- `startFreeTrialCampaignLoop` is the same **in-bot, never-throws,
  self-rescheduling** pattern as the settlement and trial sweeps: one
  `processCampaignBatch` every 15 s (`CAMPAIGN_SWEEP_INTERVAL_MS`),
  batch size 25 (`CAMPAIGN_BATCH_SIZE`), oldest campaign first.
- **Why not the worker app?** `apps/worker` is a BullMQ placeholder with
  no bot API — it cannot send the user notifications and shares none of
  the bot's service layer. Putting the loop in the bot process was a
  deliberate decision: the campaign/recipient rows are the durable
  queue, so nothing is lost between ticks, a restart resumes exactly
  where processing stopped, and the loop can never take the bot down
  (every tick catches and logs). Nothing beyond the snapshot insert ever
  runs synchronously inside a Telegram handler.
- `FAILED` is reserved for a campaign whose **stored** audience JSON no
  longer validates at start time (defensive — the builder always writes
  a typed audience).

## Typed audiences

The audience is a **typed, validated JSON descriptor** — never raw SQL.
`parseCampaignAudience` re-validates the stored JSON on every use and
`campaignAudienceWhere` always restricts to `status: ACTIVE` users:

| Kind | Persian label | Filter |
| --- | --- | --- |
| `ALL_ACTIVE` | همه کاربران فعال | all `ACTIVE` users |
| `WITHOUT_ACTIVE_TRIAL` | کاربران بدون تست فعال | no `ACTIVE` trial claim |
| `WITH_PREVIOUS_TRIAL` | کاربرانی که قبلاً تست گرفته‌اند | at least one claim ever |
| `WITHOUT_SUCCESSFUL_PURCHASE` | کاربران بدون خرید موفق | `paidOrdersCount = 0` |
| `WITH_SUCCESSFUL_PURCHASE` | کاربران دارای خرید موفق | `paidOrdersCount > 0` |
| `REGISTERED_BEFORE` | کاربران ثبت‌نام‌شده قبل از تاریخ مشخص | `createdAt < date` |
| `REGISTERED_AFTER` | کاربران ثبت‌نام‌شده بعد از تاریخ مشخص | `createdAt > date` |
| `SELECTED_USERS` | فقط کاربران انتخاب‌شده | explicit user-id list |

**Bulk selected-user grants**: the `SELECTED_USERS` builder step accepts
numeric Telegram ids, one per line (Persian/Arabic digits normalized),
capped at `TRIAL_BULK_GRANT_MAX_USERS = 500` lines per campaign; invalid
lines are rejected with a count, unmatched ids are reported with a
sample, and only resolved internal user ids are stored.

## Snapshot stability

`startCampaign` flips `PREVIEWED → QUEUED` with a CAS (a double
confirmation is a no-op), then snapshots the audience as `PENDING`
`FreeTrialCampaignRecipient` rows in id-ordered pages of 500 with
`createMany({ skipDuplicates: true })`. The snapshot is **stable**:
users who later match the audience are never added, and a crashed/re-run
snapshot converges on exactly one row per user thanks to
`@@unique([campaignId, userId])`. `totalUsers` is the post-snapshot
count.

## Skip rules (evaluated at processing time)

Each `PENDING` recipient is classified when its batch runs — not at
snapshot time — so stale snapshots stay safe:

| `skipReason` | Rule |
| --- | --- |
| `user-not-active` | user missing or not `ACTIVE` (blocked users never receive grants) |
| `claim-in-progress` | a live claim (`CLAIMED`/`PROVISIONING`/`MANUAL_REVIEW`) exists |
| `active-trial` | an `ACTIVE` trial claim exists |
| `has-allowance` | the user's remaining allowance is unlimited or already ≥ the campaign allowance — skipped **unless** the OWNER opted into `includeUsersWithAllowance` |

Skips are terminal per recipient (`SKIPPED`, safe English marker,
rendered in Persian on the admin page). A recipient that throws is
marked `FAILED` with a truncated error message and never blocks the rest
of the batch.

## Idempotency — three layers

1. `FreeTrialCampaignRecipient` `@@unique([campaignId, userId])` — at
   most one snapshot row per user per campaign; batch retries cannot
   duplicate recipients.
2. `FreeTrialEntitlement` `@@unique([campaignId, userId])` **plus** the
   explicit `idempotencyKey = trial-campaign:<campaignId>:<userId>`
   (`@unique`) — a retried grant collides and converges on the existing
   entitlement instead of creating a second one (a P2002 is resolved by
   re-reading the winner).
3. CAS status flips on the campaign itself (`PREVIEWED→QUEUED`,
   `QUEUED→RUNNING`, `RUNNING→COMPLETED`, cancellation) and on every
   recipient update (`WHERE status = PENDING`).

A re-run batch can therefore never double-grant (locked by campaign
tests 4–9 and 19–20).

## Preview and the typed confirmation

The builder (OWNER-only, «کمپین ریست اکانت تست» — see
`docs/free-trial-admin-management.md` for the page flow) collects
audience → allowance (1..`TRIAL_GRANT_MAX_PER_OPERATION` = 100 per user)
→ optional expiry (days 1..3650 or none) → notify choice →
include-with-allowance choice → mandatory reason, persists the row via
`createCampaignDraft`, and `previewCampaign` counts the audience and
stamps `PREVIEWED` + `estimatedUsers`. The preview page shows the
estimated audience, per-user allowance, the fixed skip rules, expiry and
reason.

Starting requires **two confirmations**: the final warning
(«این عملیات برای تعداد زیادی کاربر سهمیه تست ایجاد می‌کند و قابل حذف از
تاریخچه نیست.») and then the **exact typed phrase**
`RESET TRIAL` (`CAMPAIGN_TYPED_CONFIRMATION`); any other text re-prompts.
The session draft is consumed BEFORE `startCampaign` runs, so a replayed
confirmation can only hit the CAS — a no-op.

## Resume, cancel, notifications

- **Resume**: processing state lives entirely in the recipient rows; a
  bot restart resumes with the next `PENDING` batch — no re-planning, no
  duplicates (test 19).
- **Cancel** («لغو کمپین», with confirmation): `cancelCampaign` CAS-flips
  any of `DRAFT`/`PREVIEWED`/`QUEUED`/`RUNNING` to `CANCELLED`. The loop
  re-reads the campaign status **before every recipient**, so a
  cancellation stops before the next grant; **every entitlement already
  granted is preserved** — cancellation never claws back (tests 16–18).
  The builder's «ویرایش تنظیمات» / «انصراف» buttons cancel the persisted
  draft row the same way so no `DRAFT`/`PREVIEWED` rows linger.
- **Notifications** (opt-in per campaign): after a successful grant the
  recipient's `notifiedAt` is stamped by CAS (`WHERE notifiedAt IS
  NULL`) and only the CAS winner sends `CAMPAIGN_USER_NOTICE_TEXT`
  («امکان دریافت اکانت تست دوباره برای شما فعال شد 🎁\n\nاز منوی اصلی
  می‌توانید اکانت تست خود را دریافت کنید.»). A failed send is logged and
  **never rolls the grant back** (test 20).

Progress counters (`processedUsers` / `grantedUsers` / `skippedUsers` /
`failedUsers`) increment once per processed batch; the campaign detail
page renders them with paged skipped/failed recipient lists (safe
markers only — never credentials, tokens or URLs).

## Audit

Every campaign mutation writes an `AuditLog` row via `writeTrialAudit`:
`trial.campaign.created` / `previewed` / `started` / `cancelled`, with
safe metadata (allowance, audience kind, counts) — never per-user
secrets.
