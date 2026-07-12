# Callback audit (final production audit)

Automated whole-source audit of every callback constant, emitted button
callback and registered handler in `apps/bot/src` (106 files scanned).
Permanently locked by `apps/bot/tests/navigation-integrity.test.ts`.

## Results

| metric | value |
| --- | --- |
| emitted callback shapes (literals + template prefixes) | **279** |
| registered exact-string routes | **41** |
| registered regex routes | **165** |
| `callbackQuery(...)` registration sites | 278 |
| **dead buttons** (emitted, no handler) | **0** |
| **orphan routes** (registered, never emitted) | **0** |
| **unreachable handlers** | **0** |
| longest callback (worst case, template + 8-char sid + `:x:9999`) | **49 bytes** (`admin:finance:card:toggle_gateway:<sid>`) — all < 64 |

## Method

- Emitted shapes: every `"<ns>:..."` string literal and every
  `` `<ns>:...${ `` template prefix across all sources
  (namespaces `user|admin|common|terms|force_join`).
- Registered routes: `callbackQuery("...")` strings,
  `callbackQuery(/regex/)` literal prefixes, and constant references
  (`CB.X`, local `*_CB.x`) resolved through per-file
  `IDENT: "literal"` maps.
- A shape is alive when an exact string matches or a regex literal prefix
  is a prefix-relation match.

## Namespace inventory

- `user:*` — menu, buy (LOCKED), renew, services (svc), wallet, orders /
  history (hist incl. Fix D sub/wtx, payhist, op), support (sup, Fix D
  landing/detail), extra volume/time (ev/et),
  hidden placeholders (referral, free_test, wheel, tutorials, pricing,
  representative_request — answered for old keyboards).
- `admin:*` — menu, finance (+fin reports), receipts (rec incl. Fix B
  media/user/uwallet), users (+Fix C ls/svc/ord/pay/blk/ublk +
  user_wallet incl. tx), products (prod incl. Fix C add/V/X), panels
  (panels/panel incl. Fix C ls/prods), other_products landing, manual
  orders (mo), stock (incl. Fix B status lists), support, broadcast (bc),
  text settings (tx), reports/backup (rb), hidden admin placeholders
  (answered).
- `common:back`, `terms:accept`, `force_join:check` — entry gates.

## Backward compatibility

All legacy shapes remain registered: `admin:mo:list:<page>`,
`admin:stock:items:<sid>:<page>` (all statuses), suffix-less stock item
actions, `admin:users:recent`, `admin:panels:list[:page]`, every hidden
placeholder callback, and `admin:rec:view:<sid>` used by notification
deep-links. No constant was ever renamed or removed.
