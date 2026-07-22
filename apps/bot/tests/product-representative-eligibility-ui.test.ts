import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma, type Admin, type Panel } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "product-rep-eligibility-ui-tests-secret-01";

import { initialSession, type ProductAddState, type SessionData } from "../src/core/session.js";
import { productHandler, productTextHandler } from "../src/handlers/products/product.handler.js";
import { productDetailKeyboard, productDetailText } from "../src/handlers/products/product-views.js";
import { productShortId, type ProductWithRelations } from "../src/services/product.service.js";

// =============================================================================
// PR #122 follow-up (P2): every admin-facing Product detail render must apply
// OWNER context so the representative-eligibility toggle appears immediately —
// on detail open, after creation, and after EVERY field/selector/order edit —
// never only after leaving and reopening the product. All detail rendering now
// flows through the single authoritative showProductDetail(ctx, product) helper.
// Requires the shared test PostgreSQL; skips without it.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

const REP_TOGGLE_PREFIX = "admin:prod:repel:";
const REP_STATE_TEXT = "فروش در بخش نمایندگی";

let ownerAdmin: Admin;
let supportAdmin: Admin;
let panel: Panel;
let serviceCategoryId: string;
let serviceProduct: ProductWithRelations;
let otherProduct: ProductWithRelations;

function tgId(): bigint {
  return runTag + BigInt(Math.floor(Math.random() * 1_000_000_000));
}

interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}

interface InlineButton {
  text?: string;
  callback_data?: string;
}

/** callback_data of every button on the LAST sent message. */
function lastCallbacks(sent: SentMessage[]): string[] {
  const markup = sent.at(-1)?.other?.reply_markup as
    | { inline_keyboard?: InlineButton[][] }
    | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? "");
}

function keyboardCallbacks(kb: { inline_keyboard: InlineButton[][] }): string[] {
  return kb.inline_keyboard.flat().map((b) => b.callback_data ?? "");
}

function baseCtx(session: SessionData, admin: Admin | null) {
  const sent: SentMessage[] = [];
  const toasts: Array<string | undefined> = [];
  const from = { id: Number(tgId() % 2_000_000_000n), is_bot: false, first_name: "Admin" };
  const shared = {
    session,
    admin,
    dbUser: null,
    from,
    reply: async (text: string, other?: Record<string, unknown>) => {
      sent.push({ text, other });
      return {};
    },
    editMessageText: async (text: string, other?: Record<string, unknown>) => {
      sent.push({ text, other });
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      toasts.push(payload?.text);
      return true;
    },
  };
  return { shared, sent, toasts, from };
}

async function dispatchCb(session: SessionData, data: string, admin: Admin | null) {
  const { shared, sent, toasts, from } = baseCtx(session, admin);
  const callbackQuery = { id: "cbq-1", chat_instance: "ci-1", from, data };
  const ctx = { ...shared, callbackQuery, update: { update_id: 1, callback_query: callbackQuery } };
  await productHandler.middleware()(ctx as never, async () => {});
  return { sent, toasts };
}

async function dispatchText(session: SessionData, text: string, admin: Admin | null) {
  const { shared, sent, toasts, from } = baseCtx(session, admin);
  const message = { message_id: 10, date: 0, chat: { id: from.id, type: "private" }, from, text };
  const ctx = { ...shared, message, update: { update_id: 2, message } };
  await productTextHandler.middleware()(ctx as never, async () => {});
  return { sent, toasts };
}

function editSession(productId: string, field: string): SessionData {
  const session = initialSession();
  session.currentFlow = "product:edit";
  session.temp.editingProductId = productId;
  session.temp.editingProductField = field;
  return session;
}

async function reload(id: string): Promise<ProductWithRelations> {
  return prisma.product.findUniqueOrThrow({ where: { id }, include: { category: true, panel: true } });
}

beforeAll(async () => {
  if (!hasDb) return;
  ownerAdmin = await prisma.admin.create({
    data: { telegramId: tgId(), role: "OWNER", firstName: "owner" },
  });
  supportAdmin = await prisma.admin.create({
    data: { telegramId: tgId(), role: "SUPPORT", firstName: "support" },
  });
  panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `pre-panel-${runTag}`,
      baseUrl: "http://127.0.0.1:1",
      status: "ACTIVE",
      isVisible: true,
      username: "admin",
      passwordEncrypted: "enc",
      templateUsername: "tpl",
    },
  });
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `pre-cat-${runTag}`, isActive: true },
  });
  serviceCategoryId = category.id;
  const sp = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      categoryId: serviceCategoryId,
      panelId: panel.id,
      name: `pre-svc-${runTag}`,
      priceToman: 100_000,
      volumeGb: 10,
      durationDays: 30,
      isActive: true,
      displayGroups: ["ALL"],
      representativeEligible: false,
    },
  });
  serviceProduct = await reload(sp.id);
  const otherCat = await prisma.productCategory.create({
    data: { type: "OTHER_PRODUCT", name: `pre-ocat-${runTag}`, isActive: true },
  });
  const op = await prisma.product.create({
    data: {
      type: "OTHER_PRODUCT",
      categoryId: otherCat.id,
      name: `pre-other-${runTag}`,
      priceToman: 100_000,
      isActive: true,
    },
  });
  otherProduct = await reload(op.id);
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.$disconnect();
});

// --- view-level: the toggle gate (no DB) -------------------------------------

describe("productDetailKeyboard OWNER gate", () => {
  const svc = {
    id: "abcdef01-0000-0000-0000-000000000000",
    name: "svc",
    type: "SERVICE_PRODUCT",
    isActive: true,
    representativeEligible: false,
    panel: null,
    category: { isActive: true, name: "cat" },
    displayGroups: ["ALL"],
    priceToman: 100_000,
    durationDays: 30,
    volumeGb: 10,
    displayOrder: 1,
    invoiceDescription: "",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as ProductWithRelations;
  const other = { ...svc, type: "OTHER_PRODUCT" } as unknown as ProductWithRelations;

  it("OWNER sees the representative-eligibility toggle on a SERVICE_PRODUCT", () => {
    const cbs = keyboardCallbacks(productDetailKeyboard(svc, undefined, true));
    expect(cbs.some((c) => c.startsWith(REP_TOGGLE_PREFIX))).toBe(true);
  });

  it("a regular admin never receives the toggle (default / isOwner=false)", () => {
    expect(keyboardCallbacks(productDetailKeyboard(svc, undefined, false)).some((c) =>
      c.startsWith(REP_TOGGLE_PREFIX),
    )).toBe(false);
    // default arg (no OWNER context) is also gated off
    expect(keyboardCallbacks(productDetailKeyboard(svc)).some((c) =>
      c.startsWith(REP_TOGGLE_PREFIX),
    )).toBe(false);
  });

  it("OTHER_PRODUCT never receives the toggle even for the OWNER", () => {
    expect(keyboardCallbacks(productDetailKeyboard(other, undefined, true)).some((c) =>
      c.startsWith(REP_TOGGLE_PREFIX),
    )).toBe(false);
  });

  it("the eligibility STATE line shows in the detail text regardless of viewer", () => {
    expect(productDetailText(svc)).toContain(REP_STATE_TEXT);
  });

  it("the toggle ask + confirm callbacks stay within Telegram's 64-byte limit", () => {
    const sid = productShortId({ id: "abcdef0123456789" });
    for (const cb of [`admin:prod:repel:${sid}`, `admin:prod:repel:${sid}:1`, `admin:prod:repel:${sid}:0`]) {
      expect(Buffer.byteLength(cb, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});

// --- handler-level: every render path applies OWNER context ------------------

describe.skipIf(!hasDb)("product detail render applies OWNER context on every path", () => {
  it("OWNER opening an existing SERVICE_PRODUCT sees the toggle", async () => {
    const { sent } = await dispatchCb(initialSession(), `admin:prod:view:${productShortId(serviceProduct)}`, ownerAdmin);
    expect(lastCallbacks(sent).some((c) => c.startsWith(REP_TOGGLE_PREFIX))).toBe(true);
  });

  it("a regular admin opening the same product sees the STATE but NOT the toggle", async () => {
    const { sent } = await dispatchCb(initialSession(), `admin:prod:view:${productShortId(serviceProduct)}`, supportAdmin);
    expect(sent.at(-1)?.text).toContain(REP_STATE_TEXT);
    expect(lastCallbacks(sent).some((c) => c.startsWith(REP_TOGGLE_PREFIX))).toBe(false);
  });

  it("OTHER_PRODUCT never shows the toggle to the OWNER", async () => {
    const { sent } = await dispatchCb(initialSession(), `admin:prod:view:${productShortId(otherProduct)}`, ownerAdmin);
    expect(lastCallbacks(sent).some((c) => c.startsWith(REP_TOGGLE_PREFIX))).toBe(false);
  });

  it("OWNER completing SERVICE_PRODUCT creation immediately sees the toggle", async () => {
    const session = initialSession();
    session.currentFlow = "product:add";
    const name = `pre-created-${runTag}-${Math.floor(Math.random() * 1e6)}`;
    session.temp.productAdd = {
      kind: "SERVICE_PRODUCT",
      step: "confirm",
      name,
      categoryId: serviceCategoryId,
      panelId: panel.id,
      panelType: "MARZBAN",
      groups: ["ALL"],
      volumeGb: 10,
      durationDays: 30,
      priceToman: 100_000,
      invoiceDescription: "",
      displayOrder: 0,
    } satisfies ProductAddState;
    const { sent } = await dispatchCb(session, "admin:prod:f:save", ownerAdmin);
    expect(lastCallbacks(sent).some((c) => c.startsWith(REP_TOGGLE_PREFIX))).toBe(true);
    const created = await prisma.product.findFirstOrThrow({ where: { name } });
    expect(created.type).toBe("SERVICE_PRODUCT");
  });

  it("OWNER editing the product name immediately sees the toggle", async () => {
    const { sent } = await dispatchText(
      editSession(serviceProduct.id, "nm"),
      `pre-renamed-${runTag}-${Math.floor(Math.random() * 1e6)}`,
      ownerAdmin,
    );
    expect(lastCallbacks(sent).some((c) => c.startsWith(REP_TOGGLE_PREFIX))).toBe(true);
  });

  it("OWNER editing the product price immediately sees the toggle", async () => {
    const { sent } = await dispatchText(editSession(serviceProduct.id, "pr"), "150000", ownerAdmin);
    expect(lastCallbacks(sent).some((c) => c.startsWith(REP_TOGGLE_PREFIX))).toBe(true);
  });

  it("OWNER changing the display order immediately sees the toggle", async () => {
    const { sent } = await dispatchText(editSession(serviceProduct.id, "ord"), "1", ownerAdmin);
    expect(lastCallbacks(sent).some((c) => c.startsWith(REP_TOGGLE_PREFIX))).toBe(true);
  });

  it("a selector edit (change category) returns a detail keyboard with the toggle for the OWNER", async () => {
    const newCat = await prisma.productCategory.create({
      data: { type: "SERVICE_PRODUCT", name: `pre-cat2-${runTag}`, isActive: true },
    });
    const { sent } = await dispatchCb(
      initialSession(),
      `admin:prod:setcat:${productShortId(serviceProduct)}:${productShortId({ id: newCat.id })}`,
      ownerAdmin,
    );
    expect(lastCallbacks(sent).some((c) => c.startsWith(REP_TOGGLE_PREFIX))).toBe(true);
  });
});

// --- source audit: no bare productDetailKeyboard call may omit OWNER context --

describe("productDetailKeyboard call-site audit", () => {
  it("product.handler.ts renders detail ONLY through showProductDetail (single OWNER-aware call)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      path.resolve(here, "../src/handlers/products/product.handler.ts"),
      "utf8",
    );
    // The former OWNER-less forms must be gone.
    expect(src).not.toMatch(/productDetailKeyboard\(\s*product\s*\)/);
    expect(src).not.toMatch(/productDetailKeyboard\(\s*updated\s*\)/);
    // Every call to productDetailKeyboard( ... ) in the handler must pass 3 args
    // (product, backList, isOwner(ctx)); there is exactly one, inside
    // showProductDetail. (The import line ends with a comma, not a paren.)
    const calls = src.match(/productDetailKeyboard\([^)]*\)/g) ?? [];
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("isOwner(ctx)");
  });
});
