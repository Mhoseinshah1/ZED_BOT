import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "recon-ui-test-secret-recon-ui-secret-01";

import { financeLandingKeyboard } from "../src/handlers/admin-finance/admin-finance-views.js";
import {
  buildReconciliationDetailText,
  reconciliationListKeyboard,
  RECON_CB,
  RECON_OWNER_ONLY_TOAST,
} from "../src/handlers/admin-finance/financial-reconciliation.handler.js";
import {
  getReconciliationCaseByShortId,
  listReconciliationCases,
  RECONCILIATION_PAGE_SIZE,
} from "../src/services/financial-reconciliation.service.js";

// =============================================================================
// «تطبیق مالی ⚖️» read-only admin pages (P0 settlement phase): OWNER-only
// routing/gating (source assertions), the duplicate-success queue pagination
// and short-id lookup against the real service, and the exact detail text -
// which must NEVER leak full UUIDs, authorities or callback payloads.
// DB-dependent parts skip without DATABASE_URL (docs/testing.md).
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

type Button = { text: string; callback_data?: string };

function rows(kb: { inline_keyboard: unknown }): Button[][] {
  return kb.inline_keyboard as Button[][];
}

/** Every callback shape the reconciliation pages can emit (worst cases). */
const EMITTED = [
  RECON_CB.root,
  RECON_CB.dup(1),
  RECON_CB.dup(9_999),
  RECON_CB.view("aabbccdd"),
];

describe("reconciliation pages: routing, gating and callbacks (source)", () => {
  const appSrc = readFileSync(path.join(repoRoot, "apps/bot/src/app.ts"), "utf8");
  const handlerSrc = readFileSync(
    path.join(
      repoRoot,
      "apps/bot/src/handlers/admin-finance/financial-reconciliation.handler.ts",
    ),
    "utf8",
  );

  it("handler is mounted in the adminArea after adminAuthMiddleware and paymentsListHandler", () => {
    const gateIdx = appSrc.indexOf("adminArea.use(adminAuthMiddleware())");
    const paymentsIdx = appSrc.indexOf("adminArea.use(paymentsListHandler)");
    const mountIdx = appSrc.indexOf("adminArea.use(financialReconciliationHandler)");
    const commandIdx = appSrc.indexOf('bot.command("admin"');
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(paymentsIdx).toBeGreaterThan(gateIdx);
    expect(mountIdx).toBeGreaterThan(paymentsIdx);
    expect(mountIdx).toBeLessThan(commandIdx);
  });

  it("every emitted admin:fin:recon callback resolves to a registered route (no orphans)", () => {
    const matchers: RegExp[] = [];
    for (const match of handlerSrc.matchAll(/callbackQuery\(\/(\^admin:fin:recon[^/]*)\/,/g)) {
      matchers.push(new RegExp(match[1]));
    }
    expect(matchers.length).toBe(2); // dup list + detail regex routes
    // The landing route is registered as the exact RECON_CB.root string.
    expect(handlerSrc).toContain("callbackQuery(RECON_CB.root");
    matchers.push(new RegExp(`^${RECON_CB.root}$`));
    for (const data of EMITTED) {
      expect(
        matchers.some((route) => route.test(data)),
        `no registered route matches ${data}`,
      ).toBe(true);
    }
    // The finance landing entry emits exactly the registered landing route.
    const entry = rows(financeLandingKeyboard())
      .flat()
      .find((b) => b.callback_data === RECON_CB.root);
    expect(entry?.text).toBe("تطبیق مالی ⚖️");
  });

  it("EVERY route is OWNER-gated; non-owners get the safe toast and no data", () => {
    const registrations = handlerSrc.split(".callbackQuery(").slice(1);
    expect(registrations.length).toBe(3);
    for (const body of registrations) {
      expect(body).toContain("if (!(await requireOwner(ctx)))");
    }
    // The single gate checks admin presence AND the OWNER role.
    expect(handlerSrc).toContain("ctx.admin === null");
    expect(handlerSrc).toContain('ctx.admin.role === "OWNER"');
    expect(handlerSrc).toContain("safeAnswerCallback(ctx, RECON_OWNER_ONLY_TOAST)");
    expect(RECON_OWNER_ONLY_TOAST).toBe(
      "دسترسی به این بخش فقط برای مالک مجموعه فعال است.",
    );
  });

  it("read-only: no direct DB access, no secret fields, exact page texts", () => {
    // The handler renders through the two read-only service functions only -
    // it can never touch payment rows or leak provider fields.
    for (const forbidden of ["callbackPayload", "authority", "prisma"]) {
      expect(handlerSrc, `handler must not reference ${forbidden}`).not.toContain(forbidden);
    }
    // Empty state + navigation texts stay exactly as specified.
    expect(handlerSrc).toContain("موردی برای بررسی وجود ندارد.");
    expect(handlerSrc).toContain("پرداخت‌های موفق تکراری");
    expect(handlerSrc).toContain("بازگشت به لیست");
    expect(handlerSrc).toContain("بازگشت به مالی");
  });

  it("all emitted callbacks stay under Telegram's 64-byte limit", () => {
    for (const data of EMITTED) {
      expect(Buffer.byteLength(data, "utf8"), data).toBeLessThanOrEqual(64);
    }
  });
});

describe.runIf(hasDb)("reconciliation queue + detail text (DB)", () => {
  const SECRET_AUTHORITY = `recon-ui-secret-authority-${runTag}`;
  const SECRET_TOKEN = `recon-ui-secret-token-${runTag}`;
  // Two crafted case ids sharing one 8-char prefix (ambiguity must fail safe).
  const ambigPrefix = Date.now().toString(16).slice(-8);
  const checkoutSessionId = randomUUID();

  let user: User;
  let primaryId: string;
  const duplicateIds: string[] = [];
  const caseIds: string[] = [];
  let seq = 0;

  async function createPayment(
    provider: "ZARINPAL" | "NOWPAYMENTS",
    withSecrets: boolean,
  ): Promise<string> {
    seq += 1;
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        purpose: "ORDER_PAYMENT",
        status: "PENDING",
        amountToman: 60_000,
        payableAmountToman: 60_000,
        provider,
        providerStatus: "SUCCESS",
        authority: `${SECRET_AUTHORITY}-${seq}`,
        ...(withSecrets ? { callbackPayload: { token: SECRET_TOKEN } } : {}),
      },
    });
    return payment.id;
  }

  beforeAll(async () => {
    user = await prisma.user.create({
      data: { telegramId: runTag, firstName: "ReconUi", group: "F" },
    });
    primaryId = await createPayment("ZARINPAL", false);
    // Six regular cases (page size 5 -> at least two pages of our own rows).
    for (let i = 0; i < 6; i++) {
      const duplicateId = await createPayment("NOWPAYMENTS", true);
      duplicateIds.push(duplicateId);
      const created = await prisma.financialReconciliationCase.create({
        data: {
          type: "DUPLICATE_CHECKOUT_PAYMENT",
          checkoutSessionId,
          primaryPaymentId: primaryId,
          duplicatePaymentId: duplicateId,
          userId: user.id,
          expectedAmountToman: i === 0 ? 1_234_567 : 60_000,
          safeReason: "recon-ui-test",
        },
      });
      caseIds.push(created.id);
    }
    // Two cases whose crafted ids collide on the first 8 characters.
    for (const suffix of ["aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbb-4bbb-8bbb-bbbbbbbbbbbb"]) {
      const duplicateId = await createPayment("NOWPAYMENTS", true);
      duplicateIds.push(duplicateId);
      const created = await prisma.financialReconciliationCase.create({
        data: {
          id: `${ambigPrefix}-${suffix}`,
          type: "DUPLICATE_CHECKOUT_PAYMENT",
          checkoutSessionId,
          primaryPaymentId: primaryId,
          duplicatePaymentId: duplicateId,
          userId: user.id,
          expectedAmountToman: 60_000,
          safeReason: "recon-ui-test-ambiguous",
        },
      });
      caseIds.push(created.id);
    }
  });

  afterAll(async () => {
    await prisma.financialReconciliationCase.deleteMany({ where: { userId: user.id } });
    await prisma.payment.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  });

  it("listReconciliationCases pages newest-first with size 5 and clamps out-of-range pages", async () => {
    const first = await listReconciliationCases(1);
    expect(first.page).toBe(1);
    expect(first.total).toBeGreaterThanOrEqual(8);
    expect(first.pages).toBe(Math.ceil(first.total / RECONCILIATION_PAGE_SIZE));
    expect(first.cases.length).toBe(RECONCILIATION_PAGE_SIZE);
    const times = first.cases.map((c) => c.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    for (const c of first.cases) {
      expect(typeof c.userTelegramId).toBe("string");
      expect(typeof c.primaryProvider).toBe("string");
      expect(typeof c.duplicateProvider).toBe("string");
    }
    const clamped = await listReconciliationCases(9_999);
    expect(clamped.page).toBe(clamped.pages);
    expect((await listReconciliationCases(0)).page).toBe(1);
  });

  it("getReconciliationCaseByShortId resolves a unique prefix with enrichment", async () => {
    const found = await getReconciliationCaseByShortId(caseIds[0].slice(0, 8));
    expect(found).not.toBeNull();
    expect(found?.id).toBe(caseIds[0]);
    expect(found?.userTelegramId).toBe(runTag.toString());
    expect(found?.primaryProvider).toBe("ZARINPAL");
    expect(found?.duplicateProvider).toBe("NOWPAYMENTS");
  });

  it("ambiguous and malformed short ids fail safe (null, never a guess)", async () => {
    expect(await getReconciliationCaseByShortId(ambigPrefix)).toBeNull();
    expect(await getReconciliationCaseByShortId("zz!")).toBeNull();
    expect(await getReconciliationCaseByShortId("")).toBeNull();
  });

  it("detail text renders the exact Persian lines - short ids only, no secrets", async () => {
    const found = await getReconciliationCaseByShortId(caseIds[0].slice(0, 8));
    expect(found).not.toBeNull();
    if (found === null) {
      return;
    }
    const text = buildReconciliationDetailText(found);
    expect(text).toContain("⚠️ پرداخت موفق تکراری");
    expect(text).toContain(`کاربر: <code>${runTag.toString()}</code>`);
    expect(text).toContain(`پیش‌فاکتور: <code>${checkoutSessionId.slice(0, 8)}</code>`);
    expect(text).toContain(`پرداخت اصلی: ZARINPAL (<code>${primaryId.slice(0, 8)}</code>)`);
    expect(text).toContain(
      `پرداخت تکراری: NOWPAYMENTS (<code>${duplicateIds[0].slice(0, 8)}</code>)`,
    );
    expect(text).toContain("مبلغ: 1,234,567 تومان");
    expect(text).toContain("وضعیت: نیازمند بررسی");
    expect(text).toContain(
      `زمان ثبت: ${found.createdAt.toISOString().replace("T", " ").slice(0, 16)} (UTC)`,
    );
    // NEVER a full UUID, provider authority or callback-payload token.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(text).not.toContain(SECRET_AUTHORITY);
    expect(text).not.toContain(SECRET_TOKEN);
    // Legacy rows without a tracked primary payment render "-".
    const legacy = buildReconciliationDetailText({
      ...found,
      primaryPaymentId: null,
      primaryProvider: "-",
    });
    expect(legacy).toContain("پرداخت اصلی: - (<code>-</code>)");
  });

  it("list keyboard: labeled case buttons, pagination row and back - all callbacks short", async () => {
    const pageData = await listReconciliationCases(1);
    const kb = reconciliationListKeyboard(pageData);
    const flat = rows(kb).flat();
    const caseButtons = flat.filter((b) => b.callback_data?.startsWith("admin:fin:recon:v:"));
    expect(caseButtons.length).toBe(pageData.cases.length);
    const top = pageData.cases[0];
    expect(caseButtons[0]?.text).toBe(
      `⚠️ ${top.id.slice(0, 8)} | ${top.duplicateProvider} | ${top.expectedAmountToman.toLocaleString("en-US")} تومان`,
    );
    expect(caseButtons[0]?.callback_data).toBe(RECON_CB.view(top.id.slice(0, 8)));
    // Our 8 fixtures alone force pages > 1; page 1 shows «بعدی» but no «قبلی».
    const texts = flat.map((b) => b.text);
    expect(texts).toContain(`${pageData.page}/${pageData.pages}`);
    expect(texts).toContain("بعدی »");
    expect(texts).not.toContain("« قبلی");
    expect(flat.at(-1)?.text).toBe("بازگشت");
    expect(flat.at(-1)?.callback_data).toBe(RECON_CB.root);
    for (const button of flat) {
      expect(
        Buffer.byteLength(button.callback_data ?? "", "utf8"),
        button.callback_data,
      ).toBeLessThanOrEqual(64);
    }
  });
});
