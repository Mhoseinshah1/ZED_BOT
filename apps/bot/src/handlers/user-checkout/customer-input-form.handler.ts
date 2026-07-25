import { CheckoutStatus, prisma, type CheckoutSession } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { CO_CB } from "./checkout-cb.js";
import { logger } from "../../core/logger.js";
import {
  CUSTOMER_INPUT_SAVED_NOTICE,
  CUSTOMER_INPUT_SCHEMA_BROKEN_TEXT,
  getOrCreateCheckoutInput,
  isCheckoutInputSatisfied,
  submitCheckoutInput,
} from "../../services/checkout-customer-input.service.js";
import {
  renderSafeSummary,
  validateCustomerInputSchema,
  validateFieldValue,
  type CustomerInputField,
  type CustomerInputSchema,
} from "../../services/customer-input-schema.service.js";
import { readFulfillmentSnapshot } from "../../services/other-product-profile.service.js";
import { onCustomerInputCompleted } from "../../services/specialized-product-fulfillment.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// Specialized-workflows phase: PRE-SETTLEMENT customer-input form (flow
// "customer_input:form"). A conversational one-field-at-a-time wizard over
// the checkout's frozen CustomerInputSchema:
//
//   field 1 -> field 2 -> ... -> review page -> «تایید و ثبت ✅»
//
// In-progress answers live ONLY in the session draft
// (ctx.session.temp.customerInputForm); the single persistence point is
// submitCheckoutInput on confirm - which validates server-side, encrypts and
// CAS-flips the row to SUBMITTED. Nothing here ever touches Payment / Order /
// stock / wallet rows, and no answer value is ever logged or put into
// callback data. Every callback is owner-checked against the DB row.
// =============================================================================

export const CUSTOMER_INPUT_FORM_FLOW = "customer_input:form";

const HTML = { parseMode: "HTML" as const };
const ACCESS_DENIED_TEXT = "دسترسی مجاز نیست.";
const NOT_FOUND_TEXT = "مورد یافت نشد.";
const NO_ACTIVE_FORM_TEXT = "فرم فعالی وجود ندارد.";
const ALREADY_SUBMITTED_TEXT = "اطلاعات این سفارش قبلاً ثبت شده است.";
const FORM_UNAVAILABLE_TEXT = "این فرم دیگر در دسترس نیست.";
const NO_SCHEMA_TEXT = "فرمی برای این سفارش تعریف نشده است.";
const CANCEL_CONFIRM_TEXT = "فرم لغو شود؟ می‌توانید بعداً از طریق سفارش ادامه دهید.";
const CANCELLED_TEXT = "فرم لغو شد. می‌توانید بعداً از طریق سفارش ادامه دهید.";
const SAVED_AFTER_PAYMENT_TEXT = "اطلاعات شما ثبت شد ✅";
const USE_BUTTONS_TEXT = "لطفاً از دکمه‌های زیر استفاده کنید.";
const SENSITIVE_WARNING_TEXT =
  "⚠️ این اطلاعات حساس است؛ فقط در صورت اطمینان ارسال کنید.";

interface CustomerInputFormDraft {
  checkoutSessionId: string;
  orderId?: string;
  fieldIndex: number;
  answers: Record<string, string>;
  reviewing?: boolean;
  /**
   * §4 payment continuation: when the form was opened as the MANDATORY
   * pre-payment gate, the entry point records how the buyer resumes payment
   * after submitting (so they are never stranded on a menu-only screen). The
   * caller supplies a button label + callback; the form handler stays decoupled
   * from the wallet/gateway callback formats.
   */
  resumePayment?: { label: string; callback: string };
}

function menuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("منوی اصلی", CB.USER_MENU);
}

function sortedFields(schema: CustomerInputSchema): CustomerInputField[] {
  return [...schema.fields].sort((a, b) => a.order - b.order);
}

function clearFormState(ctx: BotContext): void {
  if (ctx.session.currentFlow === CUSTOMER_INPUT_FORM_FLOW) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.customerInputForm;
}

// --- rendering -----------------------------------------------------------------------------

function fieldPromptText(
  field: CustomerInputField,
  index: number,
  total: number,
  errorText?: string,
): string {
  const lines: string[] = [`<b>📝 فرم اطلاعات سفارش — فیلد ${index + 1} از ${total}</b>`, ""];
  if (errorText !== undefined) {
    lines.push(`❌ ${escapeHtml(errorText)}`, "");
  }
  if (field.securityWarning === true) {
    lines.push(SENSITIVE_WARNING_TEXT, "");
  }
  lines.push(escapeHtml(field.label));
  if (field.type === "SELECT") {
    lines.push("", "یکی از گزینه‌های زیر را انتخاب کنید:");
  } else {
    lines.push(
      "",
      field.required
        ? "لطفاً مقدار را به صورت پیام متنی ارسال کنید."
        : "این فیلد اختیاری است؛ مقدار را ارسال کنید یا «رد شدن ⏭» را بزنید.",
    );
  }
  return lines.join("\n");
}

function fieldKeyboard(field: CustomerInputField, index: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (field.type === "SELECT") {
    (field.options ?? []).forEach((option, optionIndex) => {
      // Callback data carries the option INDEX only - never option text.
      keyboard.text(`${optionIndex + 1}) ${option}`, `cinput:opt:${optionIndex}`).row();
    });
  }
  if (!field.required && field.type !== "SELECT") {
    keyboard.text("رد شدن ⏭", "cinput:skip").row();
  }
  if (index > 0) {
    keyboard.text("⬅️ قبلی", "cinput:back");
  }
  keyboard.text("انصراف", "cinput:cancel");
  return keyboard;
}

function reviewText(schema: CustomerInputSchema, answers: Record<string, string>): string {
  // renderSafeSummary escapes everything and masks `sensitive` fields, so a
  // password can never appear in full on the review page.
  return [
    "<b>📋 بازبینی اطلاعات</b>",
    "",
    renderSafeSummary(schema, answers),
    "",
    "در صورت تایید، اطلاعات ثبت می‌شود.",
  ].join("\n");
}

function reviewKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("تایید و ثبت ✅", "cinput:confirm")
    .row()
    .text("⬅️ قبلی", "cinput:back")
    .text("انصراف", "cinput:cancel");
}

async function renderCurrentStep(
  ctx: BotContext,
  draft: CustomerInputFormDraft,
  schema: CustomerInputSchema,
  errorText?: string,
): Promise<void> {
  const fields = sortedFields(schema);
  if (draft.reviewing === true) {
    await safeEditOrReply(ctx, reviewText(schema, draft.answers), reviewKeyboard(), HTML);
    return;
  }
  const index = Math.min(draft.fieldIndex, fields.length - 1);
  const field = fields[index];
  await safeEditOrReply(
    ctx,
    fieldPromptText(field, index, fields.length, errorText),
    fieldKeyboard(field, index),
    HTML,
  );
}

// --- entry points --------------------------------------------------------------------------

/**
 * Opens (or resumes-from-scratch) the customer-input form of one checkout.
 * The DB row is created here if missing (frozen schema); rendering always
 * follows the row's OWN schemaSnapshot so the buyer sees exactly the form
 * that submission will validate against. Returns true when the form opened.
 */
export async function startCustomerInputForm(
  ctx: BotContext,
  checkoutSessionId: string,
  schema: CustomerInputSchema,
  opts?: { orderId?: string; resumePayment?: { label: string; callback: string } },
): Promise<boolean> {
  const user = ctx.dbUser;
  if (user === null) {
    return false;
  }
  const record = await getOrCreateCheckoutInput(checkoutSessionId, user.id, schema);
  if (record === null) {
    await safeReply(ctx, ACCESS_DENIED_TEXT);
    return false;
  }
  if (record.status === "SUBMITTED" || record.status === "CONSUMED") {
    await safeEditOrReply(ctx, ALREADY_SUBMITTED_TEXT, menuKeyboard());
    return false;
  }
  if (record.status !== "COLLECTING") {
    await safeEditOrReply(ctx, FORM_UNAVAILABLE_TEXT, menuKeyboard());
    return false;
  }
  const parsed = validateCustomerInputSchema(record.schemaSnapshot);
  if (!parsed.ok) {
    await safeEditOrReply(ctx, CUSTOMER_INPUT_SCHEMA_BROKEN_TEXT, menuKeyboard());
    return false;
  }
  // Fresh answers on every (re-)entry - a cancelled form restarts at field 0.
  const draft: CustomerInputFormDraft = {
    checkoutSessionId,
    ...(opts?.orderId !== undefined ? { orderId: opts.orderId } : {}),
    ...(opts?.resumePayment !== undefined ? { resumePayment: opts.resumePayment } : {}),
    fieldIndex: 0,
    answers: {},
  };
  ctx.session.currentFlow = CUSTOMER_INPUT_FORM_FLOW;
  ctx.session.temp.customerInputForm = draft;
  await renderCurrentStep(ctx, draft, parsed.schema);
  return true;
}

/**
 * Receipt-submission hook (payment.handler): when the checkout's frozen
 * fulfillment snapshot wants customer info COLLECTED BEFORE MANUAL APPROVAL,
 * open the form right after the receipt registration. Presentation-only -
 * the receipt stays PENDING_REVIEW and nothing financial happens here; the
 * caller wraps this in try/catch so a form failure can never break the
 * already-registered receipt.
 */
export async function maybeStartPreSettlementCustomerInput(
  ctx: BotContext,
  checkout: CheckoutSession,
): Promise<void> {
  if (checkout.purpose !== "ORDER_PAYMENT" || checkout.orderType !== "OTHER_PRODUCT") {
    return;
  }
  const snapshot = await readFulfillmentSnapshot(checkout);
  if (!snapshot.requiresCustomerInfo || !snapshot.collectInfoBeforeManualApproval) {
    return;
  }
  // Already completed (e.g. the mandatory pre-payment gate collected it before
  // the card was shown): do not re-prompt after receipt registration.
  if (await isCheckoutInputSatisfied(checkout.id)) {
    return;
  }
  if (snapshot.customerInputSchema === null) {
    // Pre-collection is enabled but there is no structured schema (legacy
    // GENERIC row with the toggle on). Do NOT invent a schema - send the
    // legacy prompt text as a heads-up; the legacy post-approval free-text
    // flow will collect the info.
    const lines = ["پس از تایید پرداخت، اطلاعات موردنیاز سفارش از شما درخواست خواهد شد."];
    if (snapshot.promptText !== null) {
      lines.push("", escapeHtml(snapshot.promptText));
    }
    await safeReply(ctx, lines.join("\n"), undefined, HTML);
    return;
  }
  await startCustomerInputForm(ctx, checkout.id, snapshot.customerInputSchema);
}

/** Toast shown when a buyer tries to pay before completing the mandatory form. */
export const CUSTOMER_INFO_REQUIRED_BEFORE_PAYMENT_TEXT =
  "برای این محصول ابتدا باید اطلاعات سفارش را کامل و تایید کنید.";

/**
 * MANDATORY pre-payment gate (§4). For an OTHER_PRODUCT checkout whose FROZEN
 * snapshot `requiresCustomerInfo` and that carries a structured schema, the
 * buyer may not pay (wallet / gateway / Stars) until the form is confirmed
 * (SUBMITTED / CONSUMED). When the info is still missing this opens/resumes the
 * structured form and returns `true` (BLOCKED); the caller must abort the
 * payment. Returns `false` (proceed) when info is not required, already
 * submitted, or — for a legacy row with the flag but NO structured schema —
 * so those keep their existing post-settlement free-text collection unchanged.
 *
 * Idempotent + loop-safe: a satisfied form never blocks, so after the buyer
 * confirms the form and taps pay again the gate passes; a stale/foreign
 * checkout resolves to no snapshot requirement and does not trap the user.
 */
export async function enforceCustomerInfoBeforePayment(
  ctx: BotContext,
  checkout: CheckoutSession,
  opts?: { resumePayment?: { label: string; callback: string } },
): Promise<boolean> {
  if (checkout.purpose !== "ORDER_PAYMENT" || checkout.orderType !== "OTHER_PRODUCT") {
    return false;
  }
  const snapshot = await readFulfillmentSnapshot(checkout);
  // Only the pre-payment collection policy (Apple ID build) blocks payment.
  // Post-payment kinds (Premium / AI / legacy manual) keep collecting info in
  // the manual queue AFTER settlement, so this gate never opens for them.
  if (!snapshot.requireInfoBeforeSettlement || snapshot.customerInputSchema === null) {
    return false;
  }
  if (await isCheckoutInputSatisfied(checkout.id)) {
    return false;
  }
  await safeAnswerCallback(ctx, CUSTOMER_INFO_REQUIRED_BEFORE_PAYMENT_TEXT);
  await startCustomerInputForm(ctx, checkout.id, snapshot.customerInputSchema, {
    ...(opts?.resumePayment !== undefined ? { resumePayment: opts.resumePayment } : {}),
  });
  return true;
}

// --- shared per-interaction loading --------------------------------------------------------

interface ActiveForm {
  draft: CustomerInputFormDraft;
  schema: CustomerInputSchema;
  fields: CustomerInputField[];
}

/** Callback interactions answer the query; text interactions get a reply. */
async function notifyProblem(ctx: BotContext, text: string): Promise<void> {
  if (ctx.callbackQuery !== undefined) {
    await safeAnswerCallback(ctx, text);
    return;
  }
  await safeReply(ctx, text);
}

/**
 * Loads the active form for a callback/text interaction: session draft + DB
 * row (owner-checked server-side: a forged callback from another user finds
 * no draft, and a hijacked session finds a row it does not own) + the row's
 * frozen schema. Replies/answers appropriately and returns null when the
 * form is not usable.
 */
async function loadActiveForm(ctx: BotContext): Promise<ActiveForm | null> {
  const user = ctx.dbUser;
  const draft = ctx.session.temp.customerInputForm as CustomerInputFormDraft | undefined;
  if (user === null || draft === undefined || ctx.session.currentFlow !== CUSTOMER_INPUT_FORM_FLOW) {
    // A flow without a draft would trap every text message - always unwind.
    if (ctx.session.currentFlow === CUSTOMER_INPUT_FORM_FLOW) {
      clearFormState(ctx);
    }
    await notifyProblem(ctx, NO_ACTIVE_FORM_TEXT);
    return null;
  }
  const record = await prisma.checkoutCustomerInput.findUnique({
    where: { checkoutSessionId: draft.checkoutSessionId },
  });
  if (record === null) {
    clearFormState(ctx);
    await notifyProblem(ctx, NO_ACTIVE_FORM_TEXT);
    return null;
  }
  if (record.userId !== user.id) {
    clearFormState(ctx);
    await notifyProblem(ctx, ACCESS_DENIED_TEXT);
    return null;
  }
  if (record.status === "SUBMITTED" || record.status === "CONSUMED") {
    clearFormState(ctx);
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, ALREADY_SUBMITTED_TEXT, menuKeyboard());
    return null;
  }
  if (record.status !== "COLLECTING") {
    clearFormState(ctx);
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, FORM_UNAVAILABLE_TEXT, menuKeyboard());
    return null;
  }
  const parsed = validateCustomerInputSchema(record.schemaSnapshot);
  if (!parsed.ok) {
    clearFormState(ctx);
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, CUSTOMER_INPUT_SCHEMA_BROKEN_TEXT, menuKeyboard());
    return null;
  }
  return { draft, schema: parsed.schema, fields: sortedFields(parsed.schema) };
}

/** Stores one answered value and advances to the next field / the review page. */
async function storeAnswerAndAdvance(
  ctx: BotContext,
  form: ActiveForm,
  fieldIndex: number,
  value: string,
): Promise<void> {
  const { draft, schema, fields } = form;
  draft.answers[fields[fieldIndex].key] = value;
  if (fieldIndex >= fields.length - 1) {
    draft.fieldIndex = fields.length - 1;
    draft.reviewing = true;
  } else {
    draft.fieldIndex = fieldIndex + 1;
    draft.reviewing = false;
  }
  await renderCurrentStep(ctx, draft, schema);
}

// --- callbacks -----------------------------------------------------------------------------

export const customerInputFormHandler = new Composer<BotContext>();

// Entry/re-entry: cinput:start:<first chars of the checkout id>. Resolution
// is OWNER-SCOPED (userId + id startsWith), so a forged/foreign short id
// resolves to nothing; an ambiguous prefix is refused outright.
customerInputFormHandler.callbackQuery(/^cinput:start:([0-9a-f-]{4,32})$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const matches = await prisma.checkoutSession.findMany({
    where: { id: { startsWith: ctx.match[1] }, userId: user.id },
    take: 2,
  });
  if (matches.length !== 1) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  const checkout = matches[0];
  const snapshot = await readFulfillmentSnapshot(checkout);
  // Prefer the frozen schema of an existing input row (the form the buyer
  // already saw); otherwise the checkout's fulfillment snapshot decides.
  let schema: CustomerInputSchema | null = null;
  const existing = await prisma.checkoutCustomerInput.findUnique({
    where: { checkoutSessionId: checkout.id },
  });
  if (existing !== null) {
    if (existing.userId !== user.id) {
      await safeAnswerCallback(ctx, ACCESS_DENIED_TEXT);
      return;
    }
    const parsed = validateCustomerInputSchema(existing.schemaSnapshot);
    schema = parsed.ok ? parsed.schema : null;
  }
  if (schema === null) {
    schema = snapshot.customerInputSchema;
  }
  if (schema === null) {
    await safeAnswerCallback(ctx, NO_SCHEMA_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  // Reconstruct the payment continuation so a cancel-then-resume buyer of a
  // mandatory pre-payment form (still-unpaid Apple ID build) is not stranded
  // after submitting. When THIS checkout is the one the active session draft
  // materialized for a WALLET payment, restore the wallet continuation (a
  // re-tap of «پرداخت با کیف پول ✅» settles the now-satisfied checkout) —
  // otherwise return to the payment-method screen for gateway/card. This keeps
  // wallet-only deployments (where the method screen lists no gateways) usable.
  let opts: { resumePayment: { label: string; callback: string } } | undefined;
  if (checkout.status === CheckoutStatus.PENDING && snapshot.requireInfoBeforeSettlement) {
    const walletDraft = ctx.session.temp.checkoutDraft;
    opts =
      walletDraft?.otherProductCheckoutId === checkout.id
        ? { resumePayment: { label: "پرداخت با کیف پول ✅", callback: CO_CB.WALLET_CONFIRM } }
        : {
            resumePayment: {
              label: "ادامه پرداخت 💳",
              callback: `user:pay:m:${checkout.id.slice(0, 8)}`,
            },
          };
  }
  await startCustomerInputForm(ctx, checkout.id, schema, opts);
});

// SELECT option picked (index-addressed; option text never rides callbacks).
customerInputFormHandler.callbackQuery(/^cinput:opt:(\d{1,2})$/, async (ctx) => {
  const form = await loadActiveForm(ctx);
  if (form === null) {
    return;
  }
  if (form.draft.reviewing === true) {
    await safeAnswerCallback(ctx, USE_BUTTONS_TEXT);
    return;
  }
  const index = Math.min(form.draft.fieldIndex, form.fields.length - 1);
  const field = form.fields[index];
  const option = field.type === "SELECT" ? field.options?.[Number(ctx.match[1])] : undefined;
  if (option === undefined) {
    await safeAnswerCallback(ctx, USE_BUTTONS_TEXT);
    return;
  }
  const validation = validateFieldValue(field, option);
  if (!validation.ok) {
    await safeAnswerCallback(ctx, validation.error);
    return;
  }
  await safeAnswerCallback(ctx);
  await storeAnswerAndAdvance(ctx, form, index, validation.value);
});

// Skip an OPTIONAL field (stores the empty value the validator accepts).
customerInputFormHandler.callbackQuery("cinput:skip", async (ctx) => {
  const form = await loadActiveForm(ctx);
  if (form === null) {
    return;
  }
  if (form.draft.reviewing === true) {
    await safeAnswerCallback(ctx, USE_BUTTONS_TEXT);
    return;
  }
  const index = Math.min(form.draft.fieldIndex, form.fields.length - 1);
  const field = form.fields[index];
  if (field.required) {
    await safeAnswerCallback(ctx, "این فیلد الزامی است و قابل رد شدن نیست.");
    return;
  }
  await safeAnswerCallback(ctx);
  await storeAnswerAndAdvance(ctx, form, index, "");
});

customerInputFormHandler.callbackQuery("cinput:back", async (ctx) => {
  const form = await loadActiveForm(ctx);
  if (form === null) {
    return;
  }
  const { draft, schema, fields } = form;
  if (draft.reviewing === true) {
    draft.reviewing = false;
    draft.fieldIndex = fields.length - 1;
  } else if (draft.fieldIndex > 0) {
    draft.fieldIndex -= 1;
  } else {
    await safeAnswerCallback(ctx);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderCurrentStep(ctx, draft, schema);
});

// Cancel: confirm first; "yes" leaves the DB row COLLECTING so a later
// re-entry (cinput:start on the order) restarts the form from field 0.
customerInputFormHandler.callbackQuery("cinput:cancel", async (ctx) => {
  const form = await loadActiveForm(ctx);
  if (form === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    CANCEL_CONFIRM_TEXT,
    new InlineKeyboard()
      .text("بله، لغو شود", "cinput:cancel:yes")
      .text("ادامه فرم", "cinput:cancel:no"),
  );
});

customerInputFormHandler.callbackQuery("cinput:cancel:yes", async (ctx) => {
  const draft = ctx.session.temp.customerInputForm as CustomerInputFormDraft | undefined;
  if (ctx.session.currentFlow !== CUSTOMER_INPUT_FORM_FLOW || draft === undefined) {
    await safeAnswerCallback(ctx, NO_ACTIVE_FORM_TEXT);
    return;
  }
  const checkoutSessionId = draft.checkoutSessionId;
  clearFormState(ctx);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    CANCELLED_TEXT,
    // Direct re-entry route (owner-scoped resolution; 12-char prefix keeps
    // the callback data far below Telegram's 64-byte cap).
    new InlineKeyboard()
      .text("ادامه فرم 📝", `cinput:start:${checkoutSessionId.slice(0, 12)}`)
      .row()
      .text("منوی اصلی", CB.USER_MENU),
  );
});

customerInputFormHandler.callbackQuery("cinput:cancel:no", async (ctx) => {
  const form = await loadActiveForm(ctx);
  if (form === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await renderCurrentStep(ctx, form.draft, form.schema);
});

// Final confirm: the ONLY persistence point. submitCheckoutInput re-validates
// everything server-side, encrypts and CAS-flips COLLECTING -> SUBMITTED.
customerInputFormHandler.callbackQuery("cinput:confirm", async (ctx) => {
  const form = await loadActiveForm(ctx);
  if (form === null) {
    return;
  }
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const { draft, schema, fields } = form;
  if (draft.reviewing !== true) {
    await safeAnswerCallback(ctx, USE_BUTTONS_TEXT);
    return;
  }
  const result = await submitCheckoutInput(draft.checkoutSessionId, user.id, draft.answers);
  if (!result.ok) {
    await safeAnswerCallback(ctx);
    if (result.fieldKey !== undefined) {
      // Server-side validation caught a bad answer - jump back to that field.
      const fieldIndex = fields.findIndex((field) => field.key === result.fieldKey);
      draft.reviewing = false;
      draft.fieldIndex = fieldIndex >= 0 ? fieldIndex : 0;
      await renderCurrentStep(ctx, draft, schema, result.error);
      return;
    }
    clearFormState(ctx);
    await safeEditOrReply(ctx, result.error, menuKeyboard());
    return;
  }
  const checkoutSessionId = draft.checkoutSessionId;
  const resumePayment = draft.resumePayment;
  clearFormState(ctx);
  await safeAnswerCallback(ctx);

  // Post-submit dispatch: when the checkout already settled into a paid
  // order (info was completed AFTER payment approval), hand off to the
  // fulfillment pipeline - it consumes the submission, advances the order
  // and notifies exactly once. Otherwise (pre-approval / pre-payment
  // collection) route the buyer back to payment. A hand-off failure is only
  // logged: the row stays SUBMITTED and the fulfillment side retries
  // consumption idempotently.
  let handedOff = false;
  try {
    const order = await prisma.order.findUnique({
      where: { checkoutSessionId },
      include: { otherProductOrder: true },
    });
    if (order !== null && order.otherProductOrder !== null) {
      handedOff = true;
      await safeEditOrReply(ctx, SAVED_AFTER_PAYMENT_TEXT, menuKeyboard());
      await onCustomerInputCompleted(ctx.api, order.id);
    }
  } catch (err) {
    logger.error("customer-input post-submit dispatch failed", {
      checkoutSessionId,
      error: errorMessage(err),
    });
  }
  if (!handedOff) {
    // §4 continuation: the form was the MANDATORY pre-payment gate and the
    // checkout is still unpaid - offer the buyer the exact button that resumes
    // payment (wallet re-tap settles the now-satisfied checkout; gateway/card
    // returns to the payment-method screen). Without this the buyer would be
    // stranded on a menu-only acknowledgement and could never complete the
    // purchase they started.
    const keyboard =
      resumePayment !== undefined
        ? new InlineKeyboard()
            .text(resumePayment.label, resumePayment.callback)
            .row()
            .text("منوی اصلی", CB.USER_MENU)
        : menuKeyboard();
    await safeEditOrReply(ctx, CUSTOMER_INPUT_SAVED_NOTICE, keyboard);
  }
});

// --- text intake ---------------------------------------------------------------------------

/** Text answers for the "customer_input:form" flow (routed from app.ts). */
export const customerInputFormTextHandler = new Composer<BotContext>();

customerInputFormTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== CUSTOMER_INPUT_FORM_FLOW) {
    return next();
  }
  const text = ctx.message.text;
  // Commands abandon the flow (the DB row stays COLLECTING; re-entry via the
  // order button restarts the form) and run normally.
  if (text.startsWith("/")) {
    clearFormState(ctx);
    return next();
  }
  const form = await loadActiveForm(ctx);
  if (form === null) {
    return;
  }
  const { draft, schema, fields } = form;
  if (draft.reviewing === true) {
    await safeReply(ctx, USE_BUTTONS_TEXT);
    await renderCurrentStep(ctx, draft, schema);
    return;
  }
  const index = Math.min(draft.fieldIndex, fields.length - 1);
  const field = fields[index];
  const validation = validateFieldValue(field, text);
  if (!validation.ok) {
    // Persian validation error re-prompts the SAME field.
    await renderCurrentStep(ctx, draft, schema, validation.error);
    return;
  }
  await storeAnswerAndAdvance(ctx, form, index, validation.value);
});
