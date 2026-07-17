import { decryptSecret, encryptSecret, maskSecretEdges } from "@zedbot/shared";

import { escapeHtml } from "../utils/html.js";

// =============================================================================
// Specialized-workflows phase: structured customer-input form schemas.
//
// A CustomerInputSchema describes the pre-fulfillment form a buyer fills for
// a specialized OTHER_PRODUCT (Telegram Premium target account, personalized
// AI-account email, ...). Schemas are stored on Product.customerInputSchema
// (Json) and snapshotted per checkout/order; THIS module is the single
// validation + rendering authority for them.
//
// Security invariants:
//   - Values are stored ENCRYPTED (encryptSecret / APP_SECRET) - the helpers
//     at the bottom are the only encode/decode path.
//   - renderSafeSummary is the ONLY display form: every value HTML-escaped,
//     `sensitive` fields (passwords MUST set it) masked with maskSecretEdges,
//     never rendered in full.
//   - Schema labels/options reject raw HTML (< and >) and template-looking
//     sequences (${ and {{) so admin-authored schemas can never inject
//     markup or executable-looking expressions into Telegram messages.
//   - SELECT options are index-addressed by callers (callback data carries an
//     option INDEX, never option text), so callback size safety only needs
//     the count/length caps enforced here.
// =============================================================================

export const SCHEMA_MAX_FIELDS = 10;
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const FIELD_LABEL_MAX = 100;
export const FIELD_VALUE_MAX = 1000;
export const MULTILINE_VALUE_MAX = 2000;
export const SELECT_OPTIONS_MIN = 2;
export const SELECT_OPTIONS_MAX = 10;
export const SELECT_OPTION_MAX = 60;

export type CustomerInputFieldType =
  | "TEXT"
  | "EMAIL"
  | "PHONE"
  | "TELEGRAM_USERNAME"
  | "MULTILINE_TEXT"
  | "SELECT";

const FIELD_TYPES: readonly CustomerInputFieldType[] = [
  "TEXT",
  "EMAIL",
  "PHONE",
  "TELEGRAM_USERNAME",
  "MULTILINE_TEXT",
  "SELECT",
];

export interface CustomerInputField {
  /** Stable machine key - never shown to users, never re-labeled. */
  key: string;
  /** Persian display label (<=100 chars, no raw HTML). */
  label: string;
  required: boolean;
  type: CustomerInputFieldType;
  minLength?: number;
  maxLength?: number;
  /** SELECT only: 2..10 options, each <=60 chars (index-based callbacks). */
  options?: string[];
  order: number;
  /** Masked in every review/summary (maskSecretEdges). Passwords MUST set it. */
  sensitive?: boolean;
  /** Render an extra security notice next to this field. */
  securityWarning?: boolean;
}

export interface CustomerInputSchema {
  version: 1;
  fields: CustomerInputField[];
}

// --- schema validation ----------------------------------------------------------------------

export type SchemaValidation =
  | { ok: true; schema: CustomerInputSchema }
  | { ok: false; errors: string[] };

/** Injection guard: no raw HTML brackets, no template-looking expressions. */
function hasUnsafeText(text: string): boolean {
  return (
    text.includes("<") || text.includes(">") || text.includes("${") || text.includes("{{")
  );
}

function typeValueCap(type: CustomerInputFieldType): number {
  return type === "MULTILINE_TEXT" ? MULTILINE_VALUE_MAX : FIELD_VALUE_MAX;
}

/**
 * Validates an untrusted schema value (admin input / stored Json) into a
 * normalized CustomerInputSchema. Structural checks only - unique keys,
 * count/length caps, per-type consistency, SELECT option shape and the
 * injection guard. Error strings are Persian (they surface to the admin who
 * authored the schema); the parsed schema copies only known properties.
 */
export function validateCustomerInputSchema(value: unknown): SchemaValidation {
  const errors: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["ساختار فرم باید یک شیء JSON باشد."] };
  }
  const root = value as Record<string, unknown>;
  if (root.version !== 1) {
    errors.push("نسخه فرم پشتیبانی نمی‌شود (فقط نسخه 1).");
  }
  const rawFields = root.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    errors.push("فرم باید حداقل یک فیلد داشته باشد.");
    return { ok: false, errors };
  }
  if (rawFields.length > SCHEMA_MAX_FIELDS) {
    errors.push(`فرم حداکثر ${SCHEMA_MAX_FIELDS} فیلد می‌تواند داشته باشد.`);
    return { ok: false, errors };
  }

  const seenKeys = new Set<string>();
  const fields: CustomerInputField[] = [];
  rawFields.forEach((rawField: unknown, index: number) => {
    const at = `فیلد ${index + 1}`;
    if (rawField === null || typeof rawField !== "object" || Array.isArray(rawField)) {
      errors.push(`${at}: ساختار فیلد نامعتبر است.`);
      return;
    }
    const f = rawField as Record<string, unknown>;

    const key = typeof f.key === "string" ? f.key : "";
    if (!FIELD_KEY_PATTERN.test(key)) {
      errors.push(`${at}: کلید فیلد نامعتبر است (حروف کوچک انگلیسی، اعداد و _؛ حداکثر 32).`);
    } else if (seenKeys.has(key)) {
      errors.push(`${at}: کلید تکراری است (${key}).`);
    } else {
      seenKeys.add(key);
    }

    const label = typeof f.label === "string" ? f.label.trim() : "";
    if (label.length === 0 || label.length > FIELD_LABEL_MAX) {
      errors.push(`${at}: برچسب باید متنی بین 1 تا ${FIELD_LABEL_MAX} کاراکتر باشد.`);
    } else if (hasUnsafeText(label)) {
      errors.push(`${at}: برچسب نباید شامل < > یا عبارت‌های قالب ({{ و \${) باشد.`);
    }

    if (typeof f.required !== "boolean") {
      errors.push(`${at}: مقدار required باید true/false باشد.`);
    }

    const type = f.type;
    if (typeof type !== "string" || !FIELD_TYPES.includes(type as CustomerInputFieldType)) {
      errors.push(`${at}: نوع فیلد نامعتبر است.`);
      return;
    }
    const fieldType = type as CustomerInputFieldType;
    const cap = typeValueCap(fieldType);

    let minLength: number | undefined;
    if (f.minLength !== undefined) {
      if (!Number.isInteger(f.minLength) || (f.minLength as number) < 0) {
        errors.push(`${at}: حداقل طول نامعتبر است.`);
      } else {
        minLength = f.minLength as number;
      }
    }
    let maxLength: number | undefined;
    if (f.maxLength !== undefined) {
      if (
        !Number.isInteger(f.maxLength) ||
        (f.maxLength as number) < 1 ||
        (f.maxLength as number) > cap
      ) {
        errors.push(`${at}: حداکثر طول باید عددی بین 1 تا ${cap} باشد.`);
      } else {
        maxLength = f.maxLength as number;
      }
    }
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      errors.push(`${at}: حداقل طول از حداکثر طول بزرگ‌تر است.`);
    }

    let options: string[] | undefined;
    if (fieldType === "SELECT") {
      const rawOptions = f.options;
      if (
        !Array.isArray(rawOptions) ||
        rawOptions.length < SELECT_OPTIONS_MIN ||
        rawOptions.length > SELECT_OPTIONS_MAX
      ) {
        errors.push(
          `${at}: فیلد انتخابی باید بین ${SELECT_OPTIONS_MIN} تا ${SELECT_OPTIONS_MAX} گزینه داشته باشد.`,
        );
      } else {
        const cleaned: string[] = [];
        const seenOptions = new Set<string>();
        for (const rawOption of rawOptions as unknown[]) {
          const option = typeof rawOption === "string" ? rawOption.trim() : "";
          if (option.length === 0 || option.length > SELECT_OPTION_MAX) {
            errors.push(`${at}: هر گزینه باید متنی بین 1 تا ${SELECT_OPTION_MAX} کاراکتر باشد.`);
            break;
          }
          if (hasUnsafeText(option)) {
            errors.push(`${at}: گزینه‌ها نباید شامل < > یا عبارت‌های قالب باشند.`);
            break;
          }
          if (seenOptions.has(option)) {
            errors.push(`${at}: گزینه تکراری است.`);
            break;
          }
          seenOptions.add(option);
          cleaned.push(option);
        }
        if (cleaned.length === (rawOptions as unknown[]).length) {
          options = cleaned;
        }
      }
    } else if (f.options !== undefined) {
      errors.push(`${at}: فقط فیلدهای انتخابی می‌توانند گزینه داشته باشند.`);
    }

    const order = typeof f.order === "number" && Number.isFinite(f.order) ? f.order : null;
    if (order === null) {
      errors.push(`${at}: ترتیب فیلد (order) باید عدد باشد.`);
    }
    if (f.sensitive !== undefined && typeof f.sensitive !== "boolean") {
      errors.push(`${at}: مقدار sensitive باید true/false باشد.`);
    }
    if (f.securityWarning !== undefined && typeof f.securityWarning !== "boolean") {
      errors.push(`${at}: مقدار securityWarning باید true/false باشد.`);
    }

    fields.push({
      key,
      label,
      required: f.required === true,
      type: fieldType,
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(options !== undefined ? { options } : {}),
      order: order ?? index + 1,
      ...(f.sensitive === true ? { sensitive: true } : {}),
      ...(f.securityWarning === true ? { securityWarning: true } : {}),
    });
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, schema: { version: 1, fields } };
}

// --- per-field value validation -------------------------------------------------------------

const EMAIL_VALUE_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/;
const PHONE_PATTERN = /^\+?\d{7,15}$/;

export const FIELD_REQUIRED_TEXT = "این فیلد الزامی است.";
export const INVALID_EMAIL_TEXT = "ایمیل واردشده معتبر نیست.";
export const INVALID_PHONE_TEXT = "شماره تلفن معتبر نیست (7 تا 15 رقم، با یا بدون +).";
export const INVALID_TELEGRAM_USERNAME_TEXT =
  "نام کاربری تلگرام معتبر نیست (5 تا 32 کاراکتر انگلیسی، عدد یا _).";
export const INVALID_SELECT_TEXT = "لطفاً یکی از گزینه‌های موجود را انتخاب کنید.";
export const SINGLE_LINE_ONLY_TEXT = "این فیلد باید در یک خط وارد شود.";

/** Persian/Arabic digits -> ASCII (mirrors the stock-threshold normalizer). */
function normalizeDigits(text: string): string {
  return text
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

export type FieldValueValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validates ONE submitted value against its field definition. Returns the
 * normalized value to store (trimmed; TELEGRAM_USERNAME without the leading
 * @; PHONE with Persian digits normalized and separators removed; SELECT as
 * the canonical option text). Error strings are Persian (user-facing).
 */
export function validateFieldValue(
  field: CustomerInputField,
  raw: string,
): FieldValueValidation {
  const value = raw.replace(/\r\n/g, "\n").trim();
  if (value.length === 0) {
    return field.required
      ? { ok: false, error: FIELD_REQUIRED_TEXT }
      : { ok: true, value: "" };
  }
  const cap = Math.min(field.maxLength ?? typeValueCap(field.type), typeValueCap(field.type));
  const min = field.minLength ?? 1;
  if (value.length > cap || value.length < min) {
    return { ok: false, error: `طول مقدار باید بین ${min} تا ${cap} کاراکتر باشد.` };
  }

  switch (field.type) {
    case "TEXT": {
      if (value.includes("\n")) {
        return { ok: false, error: SINGLE_LINE_ONLY_TEXT };
      }
      return { ok: true, value };
    }
    case "MULTILINE_TEXT": {
      return { ok: true, value };
    }
    case "EMAIL": {
      if (!EMAIL_VALUE_PATTERN.test(value)) {
        return { ok: false, error: INVALID_EMAIL_TEXT };
      }
      return { ok: true, value };
    }
    case "PHONE": {
      const phone = normalizeDigits(value).replace(/[\s()-]/g, "");
      if (!PHONE_PATTERN.test(phone)) {
        return { ok: false, error: INVALID_PHONE_TEXT };
      }
      return { ok: true, value: phone };
    }
    case "TELEGRAM_USERNAME": {
      const username = value.startsWith("@") ? value.slice(1) : value;
      if (!TELEGRAM_USERNAME_PATTERN.test(username)) {
        return { ok: false, error: INVALID_TELEGRAM_USERNAME_TEXT };
      }
      return { ok: true, value: username };
    }
    case "SELECT": {
      const option = (field.options ?? []).find((candidate) => candidate === value);
      if (option === undefined) {
        return { ok: false, error: INVALID_SELECT_TEXT };
      }
      return { ok: true, value: option };
    }
  }
}

// --- default schemas (specialized kinds) ----------------------------------------------------

/**
 * Telegram Premium: which account receives the subscription. Stable keys -
 * downstream fulfillment reads them by name; only the optional note may be
 * omitted by the buyer.
 */
export const TELEGRAM_PREMIUM_DEFAULT_SCHEMA: CustomerInputSchema = {
  version: 1,
  fields: [
    {
      key: "telegram_account",
      label: "نام کاربری تلگرام حساب موردنظر",
      required: true,
      type: "TELEGRAM_USERNAME",
      order: 1,
    },
    {
      key: "requested_identifier",
      label: "شماره تلفن یا شناسه حساب (در صورت نداشتن نام کاربری)",
      required: false,
      type: "TEXT",
      maxLength: 100,
      order: 2,
    },
    {
      key: "customer_note",
      label: "توضیحات تکمیلی (اختیاری)",
      required: false,
      type: "MULTILINE_TEXT",
      maxLength: 500,
      order: 3,
    },
  ],
};

/** Personalized AI account: the buyer's own account email + optional note. */
export const PERSONALIZED_AI_DEFAULT_SCHEMA: CustomerInputSchema = {
  version: 1,
  fields: [
    {
      key: "account_email",
      label: "ایمیل حساب شما برای فعال‌سازی",
      required: true,
      type: "EMAIL",
      order: 1,
    },
    {
      key: "customer_note",
      label: "توضیحات تکمیلی (اختیاری)",
      required: false,
      type: "MULTILINE_TEXT",
      maxLength: 500,
      order: 2,
    },
  ],
};

// --- safe rendering -------------------------------------------------------------------------

/**
 * Persian review text of submitted values, safe for Telegram HTML parse
 * mode: labels and values are HTML-escaped, `sensitive` values are masked
 * with maskSecretEdges BEFORE rendering - a full password can never appear
 * in any summary, admin message or log line built from this. Missing /
 * empty optional values render as a dash.
 */
export function renderSafeSummary(
  schema: CustomerInputSchema,
  values: Record<string, string>,
): string {
  const fields = [...schema.fields].sort((a, b) => a.order - b.order);
  const lines: string[] = [];
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === "") {
      lines.push(`${escapeHtml(field.label)}: —`);
      continue;
    }
    const display = field.sensitive === true ? maskSecretEdges(raw) : raw;
    lines.push(`${escapeHtml(field.label)}: ${escapeHtml(display)}`);
  }
  return lines.join("\n");
}

// --- encrypted value storage ----------------------------------------------------------------

/** values -> AES-256-GCM payload for CheckoutCustomerInput.valuesEncrypted. */
export function encodeValuesEncrypted(values: Record<string, string>): string {
  return encryptSecret(JSON.stringify(values));
}

/**
 * Decrypts + shape-checks a stored payload. Throws on tampered data, a
 * changed APP_SECRET or a non-{string: string} shape - callers must handle
 * failures without ever logging the payload.
 */
export function decodeValuesEncrypted(payload: string): Record<string, string> {
  const parsed: unknown = JSON.parse(decryptSecret(payload));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid encrypted customer-input payload.");
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error("Invalid encrypted customer-input payload.");
    }
    values[key] = value;
  }
  return values;
}
