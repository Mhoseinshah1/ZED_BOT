# XUI Global-Client Lifecycle Operations

Renewal, extra volume, extra time, enable/disable, subscription
regeneration, refresh/sync and reconciliation for VPN Services on
XUI / Sanaei 3X-UI panels using the **global client model** (one client =
one email + one subId + one shared quota/expiry/traffic record, attached
to multiple inbounds). Provisioning itself is documented in
`docs/xui-provisioning.md`.

## Pinned upstream contract

Everything below follows https://github.com/MHSanaei/3x-ui at commit
**`4e928a1ce0945a6e956aa63365034ec24d2b1387`**
(`internal/web/controller/client.go`, `internal/web/service/client_crud.go`,
`internal/database/model/model.go`, `internal/web/service/sub.go`,
`docs/public/openapi.json`). Nothing was guessed from memory or legacy
examples.

## Endpoints used by the lifecycle operations

| Operation step | Endpoint |
|---|---|
| Login (SESSION_COOKIE mode only) | `POST {base}/login` (form-encoded) |
| Read/verify (full inventory, positive semantics) | `GET {base}/panel/api/clients/list` |
| One client + attachments + usage | `GET {base}/panel/api/clients/get/{email}` |
| Central update (ALL mutations) | `POST {base}/panel/api/clients/update/{email}` |
| Traffic reset (renewal / extra volume) | `POST {base}/panel/api/clients/resetTraffic/{email}` |
| Panel-built config links | `GET {base}/panel/api/clients/links/{email}` |

Both auth modes (`SESSION_COOKIE` default, `API_TOKEN` bearer) work for
every endpoint - see `docs/xui-provisioning.md`.

## Upstream update semantics (why the payload is a full replace)

`POST /panel/api/clients/update/{email}` takes a **bare `model.Client`
body** and REPLACES the stored row, with two documented preservations:

- **omitted credentials** (`id`/UUID, `password`, Hysteria `auth`) are kept
  server-side - the adapter therefore NEVER reads or re-sends them;
- an **empty `subId`** keeps the existing one; a non-empty different
  `subId` is honored after a panel-wide uniqueness check.

Everything else is taken **as sent**, so the adapter round-trips the full
current field set (`email`, `subId`, `flow`, `totalGB`, `expiryTime`,
`enable`, `limitIp`, `tgId`, `group`, `comment`, `reset`, `adTag`,
`reverse` when present) and changes ONLY the intended fields. The panel
propagates the update to every attached inbound itself - the bot sends
**one central update per mutation and never loops over inbounds**.

Units (identical to provisioning): `totalGB` is **bytes** despite the
name (`0` = unlimited); `expiryTime` is **unix milliseconds** stored
verbatim (`0` = never expires), so expiry verification is an exact
millisecond comparison - no tolerance is needed for XUI (the 1.5s
reconciliation tolerance exists for Marzban's whole-second storage).

`POST /panel/api/clients/resetTraffic/{email}` zeroes the shared up/down
counters and **auto-enables a disabled client** (upstream behavior). It is
used only where re-enabling is the intended outcome anyway (renewal and
extra volume set `enable: true` in the same operation).

## The shared mutation runner

Every mutation follows one verified sequence
(`packages/panel-adapters/src/xui/xui.adapter.ts`):

1. authenticate;
2. read the client from the COMPLETE inventory - absence from a fully
   readable inventory is a **definite** "Panel account not found." (never
   guessed from a single failed `get`);
3. (renewal/extra volume only) reset the traffic counters;
4. build the full-replace payload from the fresh row, apply ONLY the
   intended changes, send **one** `update/{email}`;
5. **verify**: re-read the inventory and compare the intended fields
   exactly; only a verified post-state returns `ok: true`.

Failure classification:

| Situation | Result |
|---|---|
| client absent from a readable inventory | definite failure (refund-safe) |
| traffic reset failed | definite failure - quota/expiry untouched, nothing charged-but-lost |
| update refused / timed out / transport error | `ok:false, uncertain:true` - the upstream update loops per-inbound settings internally, so any failure may coincide with a partially-applied state |
| verification read failed or mismatched | `ok:false, uncertain:true` |

`uncertain` results **never refund**: the paid order stays `PROVISIONING`
and startup reconciliation settles it from panel truth under the same
per-service lock (below).

## Operation semantics

| Operation | What changes | What is verified |
|---|---|---|
| **Renewal** (`renewServiceAccount`) | traffic reset, then `totalGB` = new total bytes, `expiryTime` = new expiry ms, `enable: true` | exact quota + exact expiry + enabled |
| **Extra volume** (`addServiceVolume`) | same as renewal with `totalGB` = previous remaining + purchased (per `ADD_PURCHASED_VOLUME_TO_CURRENT_REMAINING`); expiry passed through UNCHANGED | exact quota + exact (unchanged) expiry |
| **Extra time** (`addServiceTime`) | `expiryTime` = new expiry ms; quota passed through unchanged; **no traffic reset** | exact expiry + exact (unchanged) quota |
| **Enable/disable** (`setServiceStatus`) | ONLY the `enable` flag | the flag; a client already in the desired state verifies WITHOUT any update (idempotent) |
| **Subscription regeneration** (`regenerateSubscription`) | `subId` re-keyed to a fresh 16-char lowercase-alphanumeric value (the shape 3x-ui generates itself) | the new `subId` on a fresh read |

Unlimited quota is the explicit upstream sentinel `totalGB: 0`
(`totalBytes: null` bot-side) - no arithmetic is ever applied to it.

### Why subId re-keying IS real subscription regeneration

The pinned subscription service resolves clients **by `subId`**
(`internal/web/service/sub.go`), and the update endpoint honors `subId`
changes with a uniqueness check. Re-keying the client to a fresh random
subId therefore invalidates the old subscription identity remotely - the
old URL stops resolving to this client - and the new
`{subscriptionDomain}/{newSubId}` URL is returned only to the service
owner. Old/new subIds and URLs are never logged and never stored in
`ServiceEventLog` metadata (booleans only).

## Remote-model classification (legacy compatibility)

Lifecycle mutations run ONLY against services whose remote model is the
global client. Classification is explicit and stored-evidence-based
(`classifyXuiRemoteModel` in `panel-readiness.service.ts`):

| Model | Evidence | Lifecycle mutations |
|---|---|---|
| `GLOBAL_CLIENT` | `remoteMetadata.email === username`, or every observed client email equals the username | allowed |
| `LEGACY_PER_INBOUND` | observed per-inbound labels (`username-<inboundId>`) | **blocked** |
| `UNKNOWN` | no provable evidence | **blocked** (never guessed) |

Legacy / unknown services:

- stay fully **readable**: refresh/sync keeps working through the
  read-only legacy aggregation in `getServiceAccount`, and a successful
  sync stores the freshly observed (non-secret) remote evidence so the
  classification stays current - no remote state is ever changed;
- are **never mutated** through the global-client endpoints and never
  silently migrated;
- hide every mutating button on the service-detail page and show
  «این سرویس با ساختار قدیمی پنل ساخته شده است.»;
- are excluded from the renewal / extra-volume / extra-time listings,
  short-id resolution, plan validation, and the wallet re-check - a
  legacy target can never produce a payable checkout, and a paid order
  that somehow reaches execution refunds with
  «این عملیات برای سرویس‌های قدیمی XUI پشتیبانی نمی‌شود.» without touching
  the panel (toggle/regeneration return the same text without any
  Order/refund, as they are unpaid).

## Pipelines, gates and concurrency

The lifecycle pipelines are the existing ones (renewal Phase 12, extras
Phase 16/17, toggle Phase 18, regeneration Phase 19, sync Phase 11) - XUI
support plugs in through the adapter, the capability model and the
remote-model gates. All their guarantees hold unchanged:

- capability + sellability gates run BEFORE payment in catalog/action
  listings, checkout creation, wallet payment and receipt approval (both
  payment paths funnel into the same executors);
- every mutation runs under the distributed per-service lock
  `zedbot:service-operation:<serviceId>` (`docs/service-operation-concurrency.md`);
  Redis failure is fail-closed; lock contention never refunds;
- exactly-once application per order via the PAID->PROVISIONING CAS claim
  plus one `ServiceEventLog` anchor per applied operation;
- refresh/sync updates only mutable panel-truth state (usage, quota,
  expiry, status, links, remote evidence) - never ownership, snapshots or
  payment data.

## Reconciliation

Startup reconciliation (`docs/panel-database-reconciliation.md`) now
covers XUI renewal/extra-volume/extra-time orders for real, because the
SANAEI adapter reads quota and expiry:

- **APPLIED** - the panel matches the order's exact recomputed post-state:
  complete + repair the Service row + write the missing event anchor once;
  no refund.
- **NOT_APPLIED** - the panel matches the exact pre-state: the existing
  idempotent refund path.
- **UNKNOWN** - auth failure, timeout, malformed response, unreported
  fields, or a remote value explainable only by another operation: defer;
  **never** refund, never fake completion.

Toggle and regeneration are unpaid operations: an uncertain outcome
returns a safe failure, changes nothing locally, and the next
refresh/sync re-syncs status and subscription identity from panel truth.

## User-facing texts (specified)

| Flow | Text |
|---|---|
| Refresh success | «اطلاعات سرویس بروزرسانی شد ✅» |
| Refresh failure | «بروزرسانی اطلاعات سرویس موقتاً امکان‌پذیر نیست.» |
| Refresh: client absent | «سرویس در پنل پیدا نشد.» |
| Renewal success | «سرویس شما با موفقیت تمدید شد ✅» |
| Extra volume success | «حجم اضافه با موفقیت به سرویس شما اضافه شد ✅» |
| Extra time success | «زمان اضافه با موفقیت به سرویس شما اضافه شد ✅» |
| Disable confirmation | «آیا از غیرفعال کردن این سرویس مطمئن هستید؟» |
| Enable confirmation | «آیا از فعال کردن این سرویس مطمئن هستید؟» |
| Disabled | «سرویس با موفقیت غیرفعال شد.» |
| Enabled | «سرویس با موفقیت فعال شد.» |
| Regeneration confirmation | «با تغییر لینک اشتراک، لینک قبلی غیرفعال می‌شود. ادامه می‌دهید؟» |
| Regeneration success | «لینک اشتراک جدید ساخته شد ✅» |
| Legacy service status | «این سرویس با ساختار قدیمی پنل ساخته شده است.» |
| Legacy operation block | «این عملیات برای سرویس‌های قدیمی XUI پشتیبانی نمی‌شود.» |
| Outcome unknown (deferred) | «نتیجه عملیات نامشخص ماند؛ وضعیت سفارش به‌صورت خودکار بررسی و اصلاح می‌شود.» |

## Service-detail menu (master arrangement)

`سرویس‌های من → جزئیات سرویس` renders the master-requirements row layout
with unimplemented capabilities HIDDEN (no dead buttons, no placeholders):

| Row | Buttons (hidden when the capability/state does not allow them) |
|---|---|
| 1 | «بروزرسانی اطلاعات ♻️» |
| 2 | «کانفیگ‌ها 📄» · «لینک اشتراک 🔗» |
| 3 | «تغییر لینک 🔄» (QR Code slot hidden - not implemented) |
| 4 | «خرید حجم اضافه ➕» · «تمدید سرویس ♻️» |
| 5 | «خرید زمان اضافه ⏳» (note-editing slot hidden) |
| 6 | «خاموش کردن سرویس ⏸» / «روشن کردن سرویس ▶️» (transfer slot hidden) |
| 7 | «مشکل دارم» → existing support-ticket flow (tutorials slot hidden) |
| 8 | «بازگشت به منوی اصلی» · «بازگشت به لیست» |

## Admin capability page

`مدیریت پنل‌ها → جزئیات پنل XUI` lists the verified per-operation status
(`panelCapabilityStatusLines`): ساخت سرویس · بروزرسانی سرویس · تمدید ·
حجم اضافه · زمان اضافه · فعال/غیرفعال · تغییر لینک · تطبیق پنل, each with
one of «پشتیبانی می‌شود ✅» / «پشتیبانی نمی‌شود ❌» / «نیازمند تست مجدد» /
«نسخه API ناسازگار است». «پشتیبانی می‌شود» requires the adapter
implementation AND a passing persisted readiness test - documentation
presence alone never enables anything, and editing a provisioning-relevant
field resets the panel to «نیازمند تست مجدد».

## Tests

`apps/bot/tests/xui-lifecycle.test.ts` runs the adapter contract against a
stateful mock reproducing the pinned API (including update's
preserve-omitted-credentials semantics and resetTraffic's auto-enable),
plus E2E pipelines/reconciliation/gates on real PostgreSQL + Redis. The
concurrency-sensitive suites (`xui-lifecycle.test.ts`,
`service-operation-concurrency.test.ts`) are run five times in validation
to catch flake. Opt-in staging lifecycle verification lives in
`apps/bot/tests/staging-panels.test.ts` (temporary `zedstaging_*` client:
refresh, quota increase, expiry increase, disable/enable, subscription
regeneration, deletion; secrets never printed).

## Remaining limitations

- **Legacy per-inbound services cannot use paid lifecycle operations** -
  by design; they remain readable and must be re-provisioned to gain the
  global model (no automatic migration exists, deliberately).
- **`deleteService` stays unimplemented** as a service operation; the
  low-level delete exists only for compensating cleanup and staging.
- **QR Code, note editing, service transfer, tutorials, auto-renew** are
  outside this phase; their menu slots stay hidden.
- **Manual panel-side edits** concurrent with an operation remain
  indistinguishable from legitimate drift (documented reconciliation
  limitation).
- Production compatibility should be confirmed by running the opt-in
  staging suite against the actual target panel version before relying on
  lifecycle operations there.
