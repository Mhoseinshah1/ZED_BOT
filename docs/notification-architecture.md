# Notification & Retention Engine — Architecture (Phase 1)

Branch: `feat/notification-retention-engine` · Status: **disabled by default**

Phase 1 delivers the production foundation plus the highest-value **Service**
and **trial** notifications. Payment, win-back and analytics notifications are
deferred to later phases (see [Scope](#scope)); their enums exist in the schema
but no runtime path schedules, delivers, or exposes UI for them.

## 1. Components

```
                    ┌──────────────────────────── Bot (apps/bot) ────────────────────────────┐
                    │  settings + preference services (read/write Setting + prefs)            │
                    │  ntf:* action callbacks  ·  user settings  ·  per-service  ·  admin     │
                    └──────────────▲───────────────────────────────────────────▲──────────────┘
   Setting rows / preference rows  │  AutomatedNotification rows / interactions │
                    ┌──────────────┴───────────────── PostgreSQL ───────────────┴──────────────┐
                    │  Setting · User(prefs) · NotificationPreference · ServiceNotificationPref │
                    │  Service · AutomatedNotification · NotificationInteraction                │
                    └──────────────▲───────────────────────────────────────────▲──────────────┘
                                   │                                            │
                    ┌──────────────┴──────────────── Worker (apps/worker) ──────┴──────────────┐
                    │  service-state-sync → scan → delivery → maintenance (4 BullMQ queues)    │
                    │  settings-driven scheduler  ·  per-panel lock + breaker  ·  status key   │
                    └─────────────────────────────────────────────────────────────────────────┘
                                   │ Redis (queues, locks, breaker, status)   │ Telegram Bot API
```

The **bot never sends** an automated notification and the **worker never
imports the bot**. They cooperate only through `@zedbot/database` (rows) and
`@zedbot/shared` (pure contract + logic). Everything user-visible in a
notification is produced by the worker from a *safe snapshot* the scan wrote.

## 2. The four worker queues (all worker-owned)

| Queue | Job(s) | Cadence (default) | Concurrency |
|-------|--------|-------------------|-------------|
| `service-state-sync` | `SYNC_PANEL_SERVICES` | every 15 min | 1 |
| `automated-notification-scan` | `SCAN_SERVICE_NOTIFICATIONS` | every 5 min | 1 |
| `automated-notification-delivery` | `DELIVER_AUTOMATED_NOTIFICATION` | on demand | 1 + limiter 15/min |
| `automated-notification-maintenance` | `RECONCILE_FAILED_NOTIFICATIONS`, `CLEANUP_NOTIFICATION_HISTORY` | 5 min / 24 h | 1 |

A **settings-driven scheduler** (`scheduler.ts`) reconciles the recurring jobs
every 5 minutes via `upsertJobScheduler`. While the master switch is **off** it
removes every scheduler — a dormant install runs *no* recurring notification
work.

## 3. Pipeline: sync → scan → deliver

1. **Sync** (`service-sync.ts`) refreshes `Service` usage/status/expiry from the
   panels. Per panel: fail-closed if Redis is down, skip if the breaker is open,
   take a per-panel lock, then ONE bulk read (XUI `listServiceAccounts`) or a
   bounded per-user loop (Marzban). A failed read leaves rows untouched
   (*never guess*) and trips the breaker; a healthy read clears it. See
   [service-state-sync.md](./service-state-sync.md).
2. **Scan** (`scan.ts`) evaluates the enabled rules against **fresh** state and
   writes dedupe-guarded `SCHEDULED` `AutomatedNotification` rows, then enqueues
   each for delivery. Traffic/status rules require fresh panel state; expiry/
   trial rules use the DB-authoritative `expiresAt`. See
   [service-notification-rules.md](./service-notification-rules.md).
3. **Deliver** (`delivery.ts`) re-validates everything at send time, claims the
   row `SCHEDULED → SENDING` with a DB compare-and-set, renders the safe
   snapshot, sends with an inline keyboard, then `SENT` / retry / `DEAD_LETTER` /
   429-rate-limit. See [Delivery guarantees](#5-delivery-guarantees).

## 4. Preference hierarchy

Delivery is gated by three layers, all re-read at send time:

1. **User booleans** (`User`): `cronNotificationsEnabled` is the master gate for
   *every* automated notification; `serviceNotificationsEnabled` /
   `paymentNotificationsEnabled` / `marketingMessagesEnabled` gate their
   category. A non-`ACTIVE` user receives nothing.
2. **`NotificationPreference`** (per user): timezone, quiet-hours window, daily
   cap. Absent row ⇒ global defaults.
3. **`ServiceNotificationPreference`** (per service): `expiry` / `traffic` /
   `status` overrides. `null` ⇒ inherit; a service can only *tighten*, never
   loosen, the user's SERVICE opt-in.

The pure gate functions live in `@zedbot/shared` (`isUserGateOpenForCategory`,
`isServiceKindGateOpen`, `buildEffectiveDeliveryPreferences`) so the bot's
settings pages and the worker's delivery apply *identical* decisions.

Direct/transactional replies (purchase receipts, support answers) never flow
through this engine and are unaffected by these switches.

## 5. Delivery guarantees

Every notification is **persisted before** Telegram delivery and carries a
stable unique `dedupeKey`. Delivery (`delivery.ts`):

- **CAS claim** `SCHEDULED/READY/SENDING/FAILED → SENDING`; a lost race skips —
  two concurrent workers can never both send.
- **Re-validates** the master switch, the user category gate, the per-service
  gate, and the *source condition* that justified the notice.
- **Cancels** stale notices before sending when: the service was renewed
  (expiry cycle changed), the quota was reset / extra volume moved usage below
  the threshold (quota cycle changed), the trial converted to paid, the service
  was deleted, the user disabled notifications, or the per-service preference
  was disabled.
- Respects **quiet hours** (defers to the local window end) and the **daily
  cap** (defers to the next local day; drops as `SUPPRESSED` only if the notice
  cannot survive that long).
- **Retries** transient failures with BullMQ backoff, **dead-letters** after the
  attempt limit, and handles Telegram **429** by pausing the limiter and
  requeueing *without* consuming an attempt.
- Idempotent: `telegramMessageId` + the terminal-status short-circuit make a
  duplicate delivery job a no-op.

## 6. Security

The bot token appears only in the request URL — never in a log, error, queue
payload, DB snapshot, or Telegram message. The scan writes a `payloadSnapshot`
containing only a template key, allowlisted display variables (friendly/ masked
service name, remaining-time, percentage) and button specs — never a
subscription URL/token, panel credential, provider payload, or price. Callback
data is `ntf:<shortId>:<action>` (an 8-char id prefix + a one-letter code) —
never a full service/user/product/panel/Telegram id. See
[notification-security.md](./notification-security.md).

## 7. Configuration (Settings)

| Key | Default | Meaning |
|-----|---------|---------|
| `automated_notifications_enabled` | `false` | master switch |
| `notification_rule_expiry_enabled` | `false` | expiry rule |
| `notification_rule_traffic_enabled` | `false` | traffic rule |
| `notification_rule_trial_enabled` | `false` | trial rule |
| `notification_default_timezone` | `Asia/Tehran` | quiet-hours zone |
| `notification_expiry_thresholds` | `7d,3d,1d,12h,3h,expired` | expiry buckets |
| `notification_traffic_thresholds` | `80,90,100` | traffic buckets |
| `notification_trial_thresholds` | `30m,10m,expired` | trial buckets |
| `notification_quiet_hours_default` | `23:00–09:00` (off) | default quiet window |
| `notification_daily_limit_default` | `3` | per-user daily cap |
| `notification_service_state_max_age_minutes` | `20` | freshness window |
| `notification_sync_concurrency` | `3` | per-panel per-service concurrency |
| `notification_schedule_*_minutes` | 15/5/5/1440 | scheduler cadences |
| `notification_*_retention_days` | 90/30/180 | cleanup windows |

Only the four boolean switches are seeded (all `false`); config values are
code-defaulted so tuning a default never needs a data migration.

## 8. Scope

**Phase 1 (this PR):** `SERVICE_EXPIRY`, `SERVICE_TRAFFIC`, `SERVICE_EXPIRED`,
`SERVICE_LIMITED`, `TRIAL_NEAR_EXPIRY`, `TRIAL_EXPIRED`.

**Deferred (schema-ready, runtime-disabled, no UI):** abandoned-checkout &
payment-retry reminders (Phase 2 `feat/checkout-payment-reminders`), customer
win-back (Phase 3 `feat/customer-winback-automation`), analytics/attribution
reporting (Phase 4 `feat/notification-analytics-reporting`). Auto-renewal and
recurring Stars subscriptions remain a separate later project.

## 9. Source map

| Concern | File |
|---------|------|
| Pure contract + logic | `packages/shared/src/notifications.ts`, `template.ts` |
| Schema | `packages/database/prisma/schema.prisma`, migration `20260718120000_notification_retention_engine` |
| Seed (disabled switches, templates, buttons) | `packages/database/src/seed.ts`, `seed-data.ts` |
| Worker sync | `apps/worker/src/notifications/{service-sync,panel-adapter-factory,circuit-breaker}.ts` |
| Worker scan/rules | `apps/worker/src/notifications/{scan,rules}.ts` |
| Worker delivery/render | `apps/worker/src/notifications/{delivery,render}.ts` |
| Worker maintenance/scheduler/status | `apps/worker/src/notifications/{maintenance,scheduler,status,engine}.ts` |
| Bot services | `apps/bot/src/services/notification/*.ts` |
| Bot UI | `apps/bot/src/handlers/user-notifications/*`, service/renewal/extra-volume/admin settings handlers |
