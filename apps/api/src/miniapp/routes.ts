import { prisma, Prisma, ServiceStatus } from "@zedbot/database";
import {
  createLogger,
  getTelegramBotToken,
  isServicePublicId,
  issueMiniAppSession,
  MINIAPP_INITDATA_MAX_BYTES,
  optionalEnv,
  readMiniAppSessionCookie,
  serializeMiniAppSessionClearCookie,
  serializeMiniAppSessionCookie,
  validateMiniAppInitData,
  verifyMiniAppSession,
} from "@zedbot/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { evaluateMiniAppAccess, type MiniAppAccessUser } from "./access-policy.js";
import {
  miniAppCommerceClientRateLimit,
  miniAppCommerceRateLimit,
  miniAppInitDataMaxAgeSeconds,
  miniAppSessionTtlSeconds,
} from "./config.js";
import { clampPageSize, decodeCursor, encodeCursor, type CursorResource } from "./cursor.js";
import {
  checkRequestOrigin,
  clientRateKey,
  FixedWindowRateLimiter,
  miniAppAllowedOrigins,
  miniAppAuthRateLimit,
} from "./security.js";
import {
  toMiniAppServiceDetail,
  toMiniAppServiceSummary,
  toMiniAppTransaction,
  toMiniAppUser,
} from "./serializers.js";
import { supportFailureLog } from "./support-errors.js";
import { registerSupportRoutes } from "./support-routes.js";
import { registerCommerceRoutes } from "./commerce/routes.js";
import { isSecureRequest } from "./transport.js";

const logger = createLogger("api");

// =============================================================================
// Mini App HTTP surface.
//
// The routes in THIS module answer questions and mint/destroy sessions; they
// change nothing a user owns. Mutations live in the modules registered inside
// the secured plugin below — the Support Center (support-routes) and, behind
// nine OWNER rollout switches that all default to off, the commerce surface
// (commerce/routes). Every mutating module brings its own gate: TLS-in-prod,
// same-origin, JSON content-type, dual rate limits and payload-bound
// idempotency, calling the same domain authorities the bot calls.
//
// This module knows nothing about grammY, `BotContext`, message rendering or
// keyboards, and nothing about panels. It reads rows the bot already wrote and
// shapes them for a browser. Business logic that decides anything lives in the
// bot; duplicating it here would create a second source of truth that drifts.
//
// Failure discipline: the client is told a CODE, never a message. Codes are a
// closed set the frontend maps to Persian text. No database error, stack, id or
// gate detail is ever echoed back — a 500 body says "INTERNAL", and the reason
// goes to the server log without the request payload.
// =============================================================================

/** Bounds the request body: `initData` is capped at 8 KiB, so 16 KiB is ample. */
const MINIAPP_BODY_LIMIT_BYTES = 16 * 1024;

const AUTH_RATE_WINDOW_MS = 60_000;

// The ceiling is resolved per check, so `MINIAPP_AUTH_RATE_LIMIT` takes effect
// without the module having to be reloaded.
const authLimiter = new FixedWindowRateLimiter(miniAppAuthRateLimit, AUTH_RATE_WINDOW_MS);

/** Recent-activity slice on the dashboard. Fixed, not client-controlled. */
const DASHBOARD_TRANSACTION_COUNT = 5;
const DASHBOARD_SERVICE_COUNT = 5;

type ErrorCode =
  | "INVALID_INIT_DATA"
  | "NOT_REGISTERED"
  | "NOT_AUTHENTICATED"
  | "FORBIDDEN_ORIGIN"
  | "RATE_LIMITED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "NOT_CONFIGURED"
  | "INSECURE_TRANSPORT"
  | "INTERNAL";

function fail(reply: FastifyReply, status: number, code: ErrorCode | string): FastifyReply {
  return reply.code(status).send({ ok: false, code });
}

/** Set on the request by the authentication hook once a session is proven. */
declare module "fastify" {
  interface FastifyRequest {
    miniAppUser?: MiniAppAccessUser;
  }
}

export async function miniAppRoutes(app: FastifyInstance): Promise<void> {
  const allowedOrigins = miniAppAllowedOrigins();

  app.addHook("onSend", async (_request, reply, payload) => {
    // Nothing the Mini App returns is cacheable: every response is scoped to
    // one authenticated user, and a shared cache holding one is a disclosure.
    void reply.header("Cache-Control", "no-store");
    void reply.header("Pragma", "no-cache");
    void reply.header("X-Content-Type-Options", "nosniff");
    void reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    // No `Access-Control-Allow-Origin`, ever. Its absence is the policy.
    void reply.header("Vary", "Cookie");
    return payload;
  });

  // --- authentication --------------------------------------------------------

  app.post<{ Body: unknown }>(
    "/auth",
    { bodyLimit: MINIAPP_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (checkRequestOrigin(request, allowedOrigins) === "forbidden") {
        return fail(reply, 403, "FORBIDDEN_ORIGIN");
      }
      const rate = authLimiter.check(clientRateKey(request));
      if (!rate.allowed) {
        void reply.header("Retry-After", String(rate.retryAfterSeconds));
        return fail(reply, 429, "RATE_LIMITED");
      }

      // In production a session is NEVER minted over plain HTTP. A cookie
      // issued there could not carry `Secure`, so it would ride every later
      // plaintext request and be readable by anyone on the path - and a
      // production deployment always terminates TLS at Nginx, so a plaintext
      // auth request is either a misconfiguration or a downgrade attempt.
      // Refusing is the fail-closed answer; local development over
      // http://localhost is unaffected.
      if (optionalEnv("NODE_ENV", "development") === "production" && !isSecureRequest(request)) {
        logger.error("mini app auth refused: plaintext request in production");
        return fail(reply, 403, "INSECURE_TRANSPORT");
      }

      const botToken = getTelegramBotToken();
      if (botToken === null) {
        // Refuse rather than degrade: without the token nothing can be proven.
        logger.error("mini app auth attempted without a configured bot token");
        return fail(reply, 503, "NOT_CONFIGURED");
      }

      const body = request.body;
      const initData =
        typeof body === "object" && body !== null && "initData" in body
          ? (body as { initData: unknown }).initData
          : undefined;
      if (typeof initData !== "string" || initData.length === 0) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      if (Buffer.byteLength(initData, "utf8") > MINIAPP_INITDATA_MAX_BYTES) {
        return fail(reply, 400, "BAD_REQUEST");
      }

      // Freshness window read per request, so an operator change takes effect
      // without a restart; the value is clamped to a documented range.
      const validated = validateMiniAppInitData(initData, {
        botToken,
        maxAgeSeconds: miniAppInitDataMaxAgeSeconds(),
      });
      if (!validated.ok) {
        // ONE code for every failure. The individual reasons are precise enough
        // to be an oracle ("your signature was fine but stale"), and the client
        // has the same remedy in all cases: reopen the Mini App.
        //
        // The raw initData is NEVER logged - not at debug, not on failure. It
        // carries a Telegram profile and a valid signature over it.
        logger.debug("mini app initData rejected", { reason: validated.reason });
        return fail(reply, 401, "INVALID_INIT_DATA");
      }

      let userId: string;
      try {
        // Lookup only. A Mini App visitor is NEVER auto-created: registration
        // happens in the bot, where terms, referral attribution and force-join
        // are established. Creating a row here would produce an account that
        // skipped all of it.
        const found = await prisma.user.findUnique({
          where: { telegramId: validated.user.telegramId },
          select: { id: true },
        });
        if (found === null) {
          return fail(reply, 403, "NOT_REGISTERED");
        }
        userId = found.id;
      } catch (err) {
        logger.error("mini app auth lookup failed", supportFailureLog("auth", err));
        return fail(reply, 503, "INTERNAL");
      }

      const access = await evaluateMiniAppAccess(userId);
      if (!access.ok) {
        return reply
          .code(access.status)
          .send({ ok: false, code: access.code, requiresBot: access.requiresBot });
      }

      // ONE value for the token expiry, the cookie Max-Age and what the client
      // is told, so the three can never disagree.
      const ttlSeconds = miniAppSessionTtlSeconds();
      const token = issueMiniAppSession(userId, ttlSeconds);
      void reply.header(
        "Set-Cookie",
        serializeMiniAppSessionCookie(token, {
          secure: isSecureRequest(request),
          maxAgeSeconds: ttlSeconds,
        }),
      );
      return reply.send({
        ok: true,
        expiresInSeconds: ttlSeconds,
        user: toMiniAppUser(access.user),
      });
    },
  );

  app.post("/logout", { bodyLimit: MINIAPP_BODY_LIMIT_BYTES }, async (request, reply) => {
    if (checkRequestOrigin(request, allowedOrigins) === "forbidden") {
      return fail(reply, 403, "FORBIDDEN_ORIGIN");
    }
    // Unconditionally successful and unconditionally clearing: logout must work
    // for an already-expired session, and it must never reveal whether the
    // cookie it just cleared was valid.
    void reply.header("Set-Cookie", serializeMiniAppSessionClearCookie(isSecureRequest(request)));
    return reply.send({ ok: true });
  });

  // --- authenticated read surface -------------------------------------------

  app.register(async (secured) => {
    secured.addHook("preHandler", async (request, reply) => {
      const raw = readMiniAppSessionCookie(request.headers.cookie);
      if (raw === null || raw === "") {
        return fail(reply, 401, "NOT_AUTHENTICATED");
      }
      const session = verifyMiniAppSession(raw);
      if (!session.ok) {
        // The cookie is cleared on the way out so a stale one stops being
        // resent on every subsequent request.
        void reply.header(
          "Set-Cookie",
          serializeMiniAppSessionClearCookie(isSecureRequest(request)),
        );
        return fail(reply, 401, "NOT_AUTHENTICATED");
      }
      // Re-evaluated on EVERY request, never cached in the token: a user
      // blocked one second after signing in is blocked on their next request.
      const access = await evaluateMiniAppAccess(session.payload.userId);
      if (!access.ok) {
        return reply
          .code(access.status)
          .send({ ok: false, code: access.code, requiresBot: access.requiresBot });
      }
      request.miniAppUser = access.user;
      return undefined;
    });

    secured.get("/me", async (request, reply) => {
      const user = request.miniAppUser;
      if (user === undefined) {
        return fail(reply, 401, "NOT_AUTHENTICATED");
      }
      try {
        // COUNTED in the database, never derived from a fetched list: a user
        // with hundreds of services must not cause hundreds of rows to be
        // loaded so two numbers can be counted in JavaScript. Both counts use
        // the same visibility filter as every other service read, so a
        // soft-deleted or terminally DELETED service is invisible here too.
        const [total, active] = await Promise.all([
          prisma.service.count({ where: ownedVisibleServices(user.id) }),
          prisma.service.count({
            where: { ...ownedVisibleServices(user.id), status: ServiceStatus.ACTIVE },
          }),
        ]);
        return reply.send({
          ok: true,
          user: toMiniAppUser(user),
          services: { active, total },
        });
      } catch (err) {
        logger.error("mini app profile read failed", supportFailureLog("profile", err));
        return fail(reply, 503, "INTERNAL");
      }
    });

    secured.get("/dashboard", async (request, reply) => {
      const user = request.miniAppUser;
      if (user === undefined) {
        return fail(reply, 401, "NOT_AUTHENTICATED");
      }
      try {
        // Counts come from the database, never from a full fetch: a user with
        // hundreds of services must not cause hundreds of rows to be loaded so
        // three numbers can be derived in JavaScript.
        const now = new Date();
        const [statusCounts, expiringSoon, recentServices, recentTransactions] = await Promise.all([
          prisma.service.groupBy({
            by: ["status"],
            where: ownedVisibleServices(user.id),
            _count: { _all: true },
          }),
          prisma.service.count({
            where: {
              ...ownedVisibleServices(user.id),
              status: "ACTIVE",
              // STRICTLY IN THE FUTURE. `lte: now + 7d` alone also matches every
              // timestamp already in the past, so a service that expired last
              // month would be counted as "expiring soon" — a number the user
              // reads as "act now" about something they can no longer save.
              expiresAt: { gt: now, lte: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) },
            },
          }),
          prisma.service.findMany({
            where: ownedVisibleServices(user.id),
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: DASHBOARD_SERVICE_COUNT,
            select: SERVICE_SUMMARY_SELECT,
          }),
          prisma.walletTransaction.findMany({
            where: { userId: user.id },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: DASHBOARD_TRANSACTION_COUNT,
            select: TRANSACTION_SELECT,
          }),
        ]);

        const byStatus: Record<string, number> = {};
        let totalServices = 0;
        for (const row of statusCounts) {
          byStatus[row.status] = row._count._all;
          totalServices += row._count._all;
        }

        const recent = recentServices.map((service) => toMiniAppServiceSummary(service, now.getTime()));

        return reply.send({
          ok: true,
          // WHEN THIS RESPONSE WAS BUILT. Not a data timestamp — it exists so a
          // client can tell a stale cached screen from a live one, and so an
          // operator reading a bug report knows when the numbers were taken.
          serverTimestamp: now.toISOString(),
          // HOW FRESH THE SERVICE DATA IS, stated conservatively: the OLDEST
          // `updatedAt` among the services in this response. The whole slice is
          // therefore at least this fresh, which is the claim a reader can
          // safely act on; reporting the newest instead would let one
          // just-touched row vouch for four stale ones.
          //
          // This is DATABASE freshness. Nothing here calls a panel, so nothing
          // here can speak for the panel's own state.
          dataFreshnessTimestamp: oldestSyncTimestamp(recentServices, now),
          user: toMiniAppUser(user),
          services: {
            total: totalServices,
            byStatus,
            expiringWithin7Days: expiringSoon,
            recent,
          },
          wallet: {
            balanceToman: user.balanceToman,
            recentTransactions: recentTransactions.map(toMiniAppTransaction),
          },
        });
      } catch (err) {
        logger.error("mini app dashboard read failed", supportFailureLog("dashboard", err));
        return fail(reply, 503, "INTERNAL");
      }
    });

    secured.get<{ Querystring: Record<string, string | undefined> }>(
      "/services",
      async (request, reply) => {
        const user = request.miniAppUser;
        if (user === undefined) {
          return fail(reply, 401, "NOT_AUTHENTICATED");
        }
        const page = readPage(request.query, "services");
        if (page === null) {
          return fail(reply, 400, "BAD_REQUEST");
        }
        try {
          const rows = await prisma.service.findMany({
            where: {
              // EVERY query is scoped by the session's user id. The cursor is
              // a position, not an authority - a cursor minted for one account
              // still cannot read another's rows.
              ...ownedVisibleServices(user.id),
              ...keysetFilter(page.cursor),
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            // One extra row answers "is there another page?" without a second
            // COUNT over a table that only grows.
            take: page.size + 1,
            select: SERVICE_SUMMARY_SELECT,
          });
          const items = rows.slice(0, page.size);
          // ONE `now` for the whole page, and passed EXPLICITLY: a bare
          // `.map(toMiniAppServiceSummary)` would hand the serializer the array
          // INDEX as its clock, which silently turns "10 days left" into
          // "20672 days left" for the first row.
          const nowMs = Date.now();
          return reply.send({
            ok: true,
            items: items.map((service) => toMiniAppServiceSummary(service, nowMs)),
            nextCursor: nextCursorFor("services", rows, items, page.size),
          });
        } catch (err) {
          logger.error("mini app service list failed", supportFailureLog("service-list", err));
          return fail(reply, 503, "INTERNAL");
        }
      },
    );

    secured.get<{ Params: { serviceId: string } }>("/services/:serviceId", async (request, reply) => {
      const user = request.miniAppUser;
      if (user === undefined) {
        return fail(reply, 401, "NOT_AUTHENTICATED");
      }
      const publicId = request.params.serviceId;
      if (!isServicePublicId(publicId)) {
        // Rejected as NOT_FOUND, not BAD_REQUEST: whether an id is well-formed
        // is not information a prober should get for free. Malformed, unknown,
        // ambiguous, deleted and someone else's all end here, identically.
        return fail(reply, 404, "NOT_FOUND");
      }
      try {
        // `startsWith` on the uuid, scoped by userId IN THE WHERE — not checked
        // afterwards. A findUnique followed by an ownership `if` is one
        // forgotten branch away from an IDOR; this cannot return another user's
        // row at all.
        //
        // `take: 2` is the ambiguity check. 8 hex characters collide only once
        // in ~2^16 rows per account by the birthday bound, but "only rarely" is
        // not an argument for serving the wrong service: two matches is a
        // 404, exactly as an unknown id is.
        const matches = await prisma.service.findMany({
          where: { id: { startsWith: publicId.toLowerCase() }, ...ownedVisibleServices(user.id) },
          take: 2,
          select: SERVICE_DETAIL_SELECT,
        });
        if (matches.length !== 1) {
          return fail(reply, 404, "NOT_FOUND");
        }
        return reply.send({ ok: true, service: toMiniAppServiceDetail(matches[0]) });
      } catch (err) {
        logger.error("mini app service detail failed", supportFailureLog("service-detail", err));
        return fail(reply, 503, "INTERNAL");
      }
    });

    secured.get<{ Querystring: Record<string, string | undefined> }>(
      "/wallet/transactions",
      async (request, reply) => {
        const user = request.miniAppUser;
        if (user === undefined) {
          return fail(reply, 401, "NOT_AUTHENTICATED");
        }
        const page = readPage(request.query, "wallet-transactions");
        if (page === null) {
          return fail(reply, 400, "BAD_REQUEST");
        }
        try {
          const rows = await prisma.walletTransaction.findMany({
            where: { userId: user.id, ...keysetFilter(page.cursor) },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: page.size + 1,
            select: TRANSACTION_SELECT,
          });
          const items = rows.slice(0, page.size);
          return reply.send({
            ok: true,
            balanceToman: user.balanceToman,
            items: items.map(toMiniAppTransaction),
            nextCursor: nextCursorFor("wallet-transactions", rows, items, page.size),
          });
        } catch (err) {
          logger.error("mini app wallet history failed", supportFailureLog("wallet-history", err));
          return fail(reply, 503, "INTERNAL");
        }
      },
    );

    // The Support Center. Registered INSIDE the secured plugin so it inherits
    // the same session hook every other authenticated route uses — a support
    // route that had to remember to authenticate itself would eventually
    // forget. It brings its own mutation gate, because it is the only part of
    // this API that writes something a user owns.
    registerSupportRoutes(secured, {
      allowedOrigins,
      production: process.env.NODE_ENV === "production",
    });

    // Commerce (miniapp-commerce-parity, Phase 1). Same session hook, its own
    // dual rate-limit pair (a separate budget from support, so a buyer cannot
    // starve their own ability to file a ticket), fresh fail-closed rollout
    // switches inside every handler.
    registerCommerceRoutes(secured, {
      allowedOrigins,
      production: process.env.NODE_ENV === "production",
      limiters: {
        perUser: new FixedWindowRateLimiter(miniAppCommerceRateLimit, 60_000),
        perClient: new FixedWindowRateLimiter(miniAppCommerceClientRateLimit, 60_000),
      },
    });
  });
}

// --- shared query pieces -----------------------------------------------------

/**
 * The conservative freshness of a set of service rows.
 *
 * The OLDEST write among them, so the statement "everything in this response is
 * at least this fresh" is true of every row rather than of the luckiest one.
 * With no services there is nothing whose age could be understated, so the
 * response's own generation time is the honest answer.
 */
function oldestSyncTimestamp(rows: Array<{ updatedAt: Date }>, fallback: Date): string {
  let oldest = fallback.getTime();
  for (const row of rows) {
    oldest = Math.min(oldest, row.updatedAt.getTime());
  }
  return new Date(oldest).toISOString();
}

/**
 * The ONE visibility filter every service read uses.
 *
 * Deletion is recorded two ways in this schema — the `deletedAt` timestamp and
 * the terminal `DELETED` status — and they are not redundant: an
 * admin-terminated service carries the status without necessarily carrying the
 * timestamp. Filtering on `deletedAt` alone therefore still shows those rows,
 * which the bot has never shown. Both conditions live here so no call site can
 * remember one and forget the other; it mirrors `ownedVisibleWhere` in the
 * bot's user-services service exactly.
 */
function ownedVisibleServices(userId: string) {
  return {
    userId,
    deletedAt: null,
    status: { not: ServiceStatus.DELETED },
  } satisfies Prisma.ServiceWhereInput;
}

const SERVICE_SUMMARY_SELECT = {
  id: true,
  username: true,
  status: true,
  productNameSnapshot: true,
  panelNameSnapshot: true,
  serviceLocation: true,
  volumeBytes: true,
  usedBytes: true,
  remainingBytes: true,
  durationDays: true,
  startsAt: true,
  expiresAt: true,
  createdAt: true,
  // The row's own last write — the only freshness this surface can honestly
  // report, since nothing here calls a panel.
  updatedAt: true,
} satisfies Prisma.ServiceSelect;

const SERVICE_DETAIL_SELECT = {
  ...SERVICE_SUMMARY_SELECT,
  userNote: true,
  source: true,
  firstConnectedAt: true,
  lastConnectedAt: true,
  lastSubscriptionUpdateAt: true,
} satisfies Prisma.ServiceSelect;

const TRANSACTION_SELECT = {
  // `id` is selected because the KEYSET tie-breaker needs it, and for no other
  // reason: the serializer never emits it and the cursor seals it.
  id: true,
  amountToman: true,
  type: true,
  source: true,
  balanceAfterToman: true,
  createdAt: true,
} satisfies Prisma.WalletTransactionSelect;

interface PageRequest {
  size: number;
  cursor: { createdAtMs: number; id: string } | null;
}

/**
 * Returns `null` when a cursor was supplied but is not one we minted FOR THIS
 * collection — a services cursor replayed against the wallet ledger fails the
 * same way a forged one does.
 */
function readPage(
  query: Record<string, string | undefined>,
  resource: CursorResource,
): PageRequest | null {
  const size = clampPageSize(query.limit);
  const rawCursor = query.cursor;
  if (rawCursor === undefined || rawCursor === "") {
    return { size, cursor: null };
  }
  const cursor = decodeCursor(rawCursor, resource);
  return cursor === null ? null : { size, cursor };
}

/**
 * The keyset predicate: strictly "older than the last row I showed you".
 *
 * The two-branch OR is a row-value comparison written out — `(createdAt, id) <
 * (:createdAt, :id)`. The tie-break on `id` matters: two rows created in the
 * same millisecond are common under load, and without it one of them would be
 * skipped or repeated at a page boundary.
 */
function keysetFilter(
  cursor: { createdAtMs: number; id: string } | null,
): { OR?: Array<Record<string, unknown>> } {
  if (cursor === null) {
    return {};
  }
  const createdAt = new Date(cursor.createdAtMs);
  return {
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }],
  };
}

function nextCursorFor(
  resource: CursorResource,
  rows: Array<{ id: string; createdAt: Date }>,
  items: Array<{ id: string; createdAt: Date }>,
  size: number,
): string | null {
  if (rows.length <= size || items.length === 0) {
    return null;
  }
  const last = items[items.length - 1];
  // The row's uuid goes INTO the sealed cursor and never into the response.
  return encodeCursor(resource, { createdAtMs: last.createdAt.getTime(), id: last.id });
}
