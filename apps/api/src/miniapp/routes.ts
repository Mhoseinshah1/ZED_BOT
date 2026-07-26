import { prisma, Prisma } from "@zedbot/database";
import {
  createLogger,
  errorMessage,
  getTelegramBotToken,
  issueMiniAppSession,
  MINIAPP_INITDATA_MAX_BYTES,
  MINIAPP_SESSION_DEFAULT_TTL_SECONDS,
  optionalEnv,
  readMiniAppSessionCookie,
  serializeMiniAppSessionClearCookie,
  serializeMiniAppSessionCookie,
  validateMiniAppInitData,
  verifyMiniAppSession,
} from "@zedbot/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { evaluateMiniAppAccess, type MiniAppAccessUser } from "./access-policy.js";
import { clampPageSize, decodeCursor, encodeCursor } from "./cursor.js";
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

const logger = createLogger("api");

// =============================================================================
// Mini App HTTP surface — READ ONLY.
//
// Every route here answers a question. None of them changes anything a user
// owns: no balance moves, no service is touched, no order is placed. The two
// POSTs exist because minting and destroying a session are state changes on the
// SESSION, not on the account, and both must be POSTs so they cannot be
// triggered by a link or an <img> tag.
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
const DASHBOARD_SERVICE_COUNT = 3;

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
  // Production means "the browser reached us over TLS", which behind Nginx is
  // reported by X-Forwarded-Proto. Issuing a `Secure` cookie over plain http
  // would mean the browser silently drops it and the user is stuck in a login
  // loop, so the flag follows the actual scheme rather than NODE_ENV alone.
  const isSecureRequest = (request: FastifyRequest): boolean => {
    const forwarded = request.headers["x-forwarded-proto"];
    const proto = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : request.protocol;
    return proto === "https";
  };
  const requireSecureCookie = isSecureRequest;

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

      const validated = validateMiniAppInitData(initData, { botToken });
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
        logger.error("mini app auth lookup failed", { error: errorMessage(err) });
        return fail(reply, 503, "INTERNAL");
      }

      const access = await evaluateMiniAppAccess(userId);
      if (!access.ok) {
        return reply
          .code(access.status)
          .send({ ok: false, code: access.code, requiresBot: access.requiresBot });
      }

      const token = issueMiniAppSession(userId, MINIAPP_SESSION_DEFAULT_TTL_SECONDS);
      void reply.header(
        "Set-Cookie",
        serializeMiniAppSessionCookie(token, {
          secure: requireSecureCookie(request),
          maxAgeSeconds: MINIAPP_SESSION_DEFAULT_TTL_SECONDS,
        }),
      );
      return reply.send({
        ok: true,
        expiresInSeconds: MINIAPP_SESSION_DEFAULT_TTL_SECONDS,
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
    void reply.header("Set-Cookie", serializeMiniAppSessionClearCookie(requireSecureCookie(request)));
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
          serializeMiniAppSessionClearCookie(requireSecureCookie(request)),
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
      return reply.send({ ok: true, user: toMiniAppUser(user) });
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
        const [statusCounts, expiringSoon, recentServices, recentTransactions] = await Promise.all([
          prisma.service.groupBy({
            by: ["status"],
            where: { userId: user.id, deletedAt: null },
            _count: { _all: true },
          }),
          prisma.service.count({
            where: {
              userId: user.id,
              deletedAt: null,
              status: "ACTIVE",
              expiresAt: { not: null, lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
            },
          }),
          prisma.service.findMany({
            where: { userId: user.id, deletedAt: null },
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

        return reply.send({
          ok: true,
          user: toMiniAppUser(user),
          services: {
            total: totalServices,
            byStatus,
            expiringWithin7Days: expiringSoon,
            recent: recentServices.map(toMiniAppServiceSummary),
          },
          wallet: {
            balanceToman: user.balanceToman,
            recentTransactions: recentTransactions.map(toMiniAppTransaction),
          },
        });
      } catch (err) {
        logger.error("mini app dashboard read failed", { error: errorMessage(err) });
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
        const page = readPage(request.query);
        if (page === null) {
          return fail(reply, 400, "BAD_REQUEST");
        }
        try {
          const rows = await prisma.service.findMany({
            where: {
              // EVERY query is scoped by the session's user id. The cursor is
              // a position, not an authority - a cursor minted for one account
              // still cannot read another's rows.
              userId: user.id,
              deletedAt: null,
              ...keysetFilter(page.cursor),
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            // One extra row answers "is there another page?" without a second
            // COUNT over a table that only grows.
            take: page.size + 1,
            select: SERVICE_SUMMARY_SELECT,
          });
          const items = rows.slice(0, page.size);
          return reply.send({
            ok: true,
            items: items.map(toMiniAppServiceSummary),
            nextCursor: nextCursorFor(rows, items, page.size),
          });
        } catch (err) {
          logger.error("mini app service list failed", { error: errorMessage(err) });
          return fail(reply, 503, "INTERNAL");
        }
      },
    );

    secured.get<{ Params: { serviceId: string } }>("/services/:serviceId", async (request, reply) => {
      const user = request.miniAppUser;
      if (user === undefined) {
        return fail(reply, 401, "NOT_AUTHENTICATED");
      }
      const serviceId = request.params.serviceId;
      if (!/^[0-9a-fA-F-]{36}$/.test(serviceId)) {
        // Rejected as NOT_FOUND, not BAD_REQUEST: whether an id is well-formed
        // is not information a prober should get for free.
        return fail(reply, 404, "NOT_FOUND");
      }
      try {
        const service = await prisma.service.findFirst({
          // userId in the WHERE, not checked afterwards. A findUnique followed
          // by an ownership `if` is one forgotten branch away from an IDOR;
          // this cannot return another user's row at all.
          where: { id: serviceId, userId: user.id, deletedAt: null },
          select: SERVICE_DETAIL_SELECT,
        });
        if (service === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        return reply.send({ ok: true, service: toMiniAppServiceDetail(service) });
      } catch (err) {
        logger.error("mini app service detail failed", { error: errorMessage(err) });
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
        const page = readPage(request.query);
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
            nextCursor: nextCursorFor(rows, items, page.size),
          });
        } catch (err) {
          logger.error("mini app wallet history failed", { error: errorMessage(err) });
          return fail(reply, 503, "INTERNAL");
        }
      },
    );
  });
}

// --- shared query pieces -----------------------------------------------------

const SERVICE_SUMMARY_SELECT = {
  id: true,
  username: true,
  status: true,
  productNameSnapshot: true,
  panelNameSnapshot: true,
  volumeBytes: true,
  usedBytes: true,
  remainingBytes: true,
  durationDays: true,
  startsAt: true,
  expiresAt: true,
  createdAt: true,
} satisfies Prisma.ServiceSelect;

const SERVICE_DETAIL_SELECT = {
  ...SERVICE_SUMMARY_SELECT,
  userNote: true,
  source: true,
  serviceLocation: true,
  firstConnectedAt: true,
  lastConnectedAt: true,
  lastSubscriptionUpdateAt: true,
} satisfies Prisma.ServiceSelect;

const TRANSACTION_SELECT = {
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

/** Returns `null` when a cursor was supplied but is not one we minted. */
function readPage(query: Record<string, string | undefined>): PageRequest | null {
  const size = clampPageSize(query.limit);
  const rawCursor = query.cursor;
  if (rawCursor === undefined || rawCursor === "") {
    return { size, cursor: null };
  }
  const cursor = decodeCursor(rawCursor);
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
  rows: Array<{ id: string; createdAt: Date }>,
  items: Array<{ id: string; createdAt: Date }>,
  size: number,
): string | null {
  if (rows.length <= size || items.length === 0) {
    return null;
  }
  const last = items[items.length - 1];
  return encodeCursor({ createdAtMs: last.createdAt.getTime(), id: last.id });
}
