import type { Panel } from "@zedbot/database";

// =============================================================================
// Editable-field and toggle registries. Short keys keep callback data small;
// the registries drive both keyboard rendering and text-input validation.
// =============================================================================

export type PanelPage = "detail" | "features" | "pricing" | "test" | "username" | "cfg";

export type FieldKind = "text" | "int" | "json-int-array" | "json-object";

export interface EditableField {
  key: string;
  column: keyof Panel & string;
  label: string;
  kind: FieldKind;
  /** Nullable fields can be cleared by sending "-". */
  nullable: boolean;
  page: PanelPage;
  /** Restrict the field to one panel type (undefined = both). */
  onlyFor?: "MARZBAN" | "XUI";
}

export const EDITABLE_FIELDS: EditableField[] = [
  // Basic (edited from the detail page)
  { key: "nm", column: "name", label: "نام پنل", kind: "text", nullable: false, page: "detail" },

  // Pricing
  { key: "pgb", column: "pricePerExtraGbToman", label: "قیمت هر گیگ حجم اضافه (تومان)", kind: "int", nullable: false, page: "pricing" },
  { key: "pday", column: "pricePerExtraDayToman", label: "قیمت هر روز زمان اضافه (تومان)", kind: "int", nullable: false, page: "pricing" },
  { key: "ploc", column: "locationChangePriceToman", label: "قیمت تغییر لوکیشن (تومان)", kind: "int", nullable: false, page: "pricing" },
  { key: "peu", column: "extraUserPriceToman", label: "قیمت کاربر اضافه (تومان)", kind: "int", nullable: false, page: "pricing" },
  { key: "cspg", column: "customServicePricePerGbToman", label: "سرویس دلخواه: قیمت هر گیگ (تومان)", kind: "int", nullable: false, page: "pricing" },
  { key: "cspd", column: "customServicePricePerDayToman", label: "سرویس دلخواه: قیمت هر روز (تومان)", kind: "int", nullable: false, page: "pricing" },
  { key: "csming", column: "customServiceMinGb", label: "سرویس دلخواه: حداقل گیگ", kind: "int", nullable: true, page: "pricing" },
  { key: "csmaxg", column: "customServiceMaxGb", label: "سرویس دلخواه: حداکثر گیگ", kind: "int", nullable: true, page: "pricing" },
  { key: "csmind", column: "customServiceMinDays", label: "سرویس دلخواه: حداقل روز", kind: "int", nullable: true, page: "pricing" },
  { key: "csmaxd", column: "customServiceMaxDays", label: "سرویس دلخواه: حداکثر روز", kind: "int", nullable: true, page: "pricing" },

  // Test settings
  { key: "tvm", column: "testVolumeMb", label: "حجم تست (مگابایت)", kind: "int", nullable: true, page: "test" },
  { key: "tdm", column: "testDurationMinutes", label: "مدت تست (دقیقه)", kind: "int", nullable: true, page: "test" },
  { key: "tpn", column: "testProductName", label: "نام محصول تست", kind: "text", nullable: true, page: "test" },
  { key: "tloc", column: "testLocation", label: "لوکیشن تست", kind: "text", nullable: true, page: "test" },
  { key: "tmt", column: "testMessageTemplate", label: "قالب پیام تست", kind: "text", nullable: true, page: "test" },
  { key: "tga", column: "testGuideAfterCreate", label: "راهنمای بعد از ساخت تست", kind: "text", nullable: true, page: "test" },

  // Username settings
  { key: "uct", column: "usernameCustomText", label: "متن دلخواه username", kind: "text", nullable: true, page: "username" },
  { key: "urand", column: "usernameRandomLength", label: "طول بخش تصادفی", kind: "int", nullable: true, page: "username" },
  { key: "usq", column: "usernameSequenceLastNumber", label: "آخرین شماره ترتیبی", kind: "int", nullable: false, page: "username" },
  { key: "rup", column: "representativeUsernamePrefix", label: "پیشوند username نماینده", kind: "text", nullable: true, page: "username" },
  { key: "rsq", column: "representativeSequenceLastNumber", label: "آخرین شماره ترتیبی نماینده", kind: "int", nullable: false, page: "username" },

  // Marzban / XUI settings
  { key: "sd", column: "subscriptionDomain", label: "دامنه ساب", kind: "text", nullable: true, page: "cfg" },
  { key: "tu", column: "templateUsername", label: "اکانت نمونه (template username)", kind: "text", nullable: true, page: "cfg" },
  { key: "itn", column: "inboundTemplateName", label: "نام اینباند نمونه", kind: "text", nullable: true, page: "cfg", onlyFor: "MARZBAN" },
  { key: "rs", column: "resetStrategy", label: "استراتژی ریست", kind: "text", nullable: true, page: "cfg", onlyFor: "MARZBAN" },
  { key: "iid", column: "inboundIds", label: "شناسه‌های inbound", kind: "json-int-array", nullable: true, page: "cfg", onlyFor: "XUI" },
  { key: "ps", column: "protocolSettings", label: "تنظیمات پروتکل (JSON)", kind: "json-object", nullable: true, page: "cfg", onlyFor: "XUI" },
];

export function findField(key: string): EditableField | undefined {
  return EDITABLE_FIELDS.find((f) => f.key === key);
}

export function fieldsForPage(page: PanelPage, panelType: string): EditableField[] {
  return EDITABLE_FIELDS.filter(
    (f) => f.page === page && (f.onlyFor === undefined || f.onlyFor === panelType),
  );
}

// --- Toggles -----------------------------------------------------------------

export interface ToggleField {
  key: string;
  column: keyof Panel & string;
  label: string;
  /** Which page renders this toggle. */
  page: PanelPage;
}

export const TOGGLE_FIELDS: ToggleField[] = [
  { key: "sp", column: "showPanel", label: "نمایش پنل", page: "features" },
  { key: "sft", column: "showFreeTest", label: "نمایش تست رایگان", page: "features" },
  { key: "re", column: "renewalEnabled", label: "قابلیت تمدید", page: "features" },
  { key: "csf", column: "customServiceForF", label: "سرویس دلخواه برای F", page: "features" },
  { key: "csn", column: "customServiceForN", label: "سرویس دلخواه برای N", page: "features" },
  { key: "csn2", column: "customServiceForN2", label: "سرویس دلخواه برای N2", page: "features" },
  { key: "pul", column: "panelUserLimitEnabled", label: "محدودیت کاربر پنل", page: "features" },
  { key: "ul", column: "userLimitEnabled", label: "محدودیت کاربر", page: "features" },
  { key: "eup", column: "extraUserPurchaseEnabled", label: "خرید کاربر اضافه", page: "features" },
  { key: "sc", column: "sendConfigEnabled", label: "ارسال کانفیگ", page: "features" },
  { key: "hl", column: "happLinkEnabled", label: "لینک Happ", page: "features" },
  { key: "ck", column: "configKeyboardEnabled", label: "کیبورد کانفیگ", page: "features" },
  { key: "sl", column: "subscriptionLinkEnabled", label: "لینک اشتراک", page: "features" },
  { key: "fc", column: "firstConnectionEnabled", label: "اولین اتصال", page: "features" },
  { key: "ftfc", column: "freeTestFirstConnectionEnabled", label: "اولین اتصال تست رایگان", page: "features" },
  { key: "lc", column: "locationChangeEnabled", label: "تغییر لوکیشن", page: "features" },
  { key: "dsl", column: "dedicatedSubscriptionLinkEnabled", label: "لینک ساب اختصاصی", page: "features" },
  { key: "ucd", column: "userCanDisableService", label: "غیرفعال‌سازی توسط کاربر", page: "features" },
  { key: "uce", column: "userCanEnableService", label: "فعال‌سازی توسط کاربر", page: "features" },
  { key: "te", column: "testEnabled", label: "تست رایگان فعال", page: "test" },
  { key: "ale", column: "accountLimitEnabled", label: "محدودیت ظرفیت اکانت", page: "features" },
];

export function findToggle(key: string): ToggleField | undefined {
  return TOGGLE_FIELDS.find((t) => t.key === key);
}

export function togglesForPage(page: PanelPage): ToggleField[] {
  return TOGGLE_FIELDS.filter((t) => t.page === page);
}

// --- Input validation ---------------------------------------------------------

export type ValidationResult = { ok: true; value: unknown } | { ok: false; error: string };

const MAX_INT = 2_000_000_000;

/** Validates raw admin text input for a field. "-" clears nullable fields. */
export function validateFieldInput(field: EditableField, raw: string): ValidationResult {
  const text = raw.trim();
  if (field.nullable && text === "-") {
    return { ok: true, value: null };
  }
  switch (field.kind) {
    case "text": {
      if (text.length === 0 || text.length > 500) {
        return { ok: false, error: "متن باید بین ۱ تا ۵۰۰ کاراکتر باشد." };
      }
      return { ok: true, value: text };
    }
    case "int": {
      if (!/^\d+$/.test(text)) {
        return { ok: false, error: "لطفاً فقط یک عدد صحیح (۰ یا بیشتر) وارد کنید." };
      }
      const value = Number.parseInt(text, 10);
      if (value > MAX_INT) {
        return { ok: false, error: "عدد وارد شده بیش از حد بزرگ است." };
      }
      return { ok: true, value };
    }
    case "json-int-array": {
      // Accept "1,2,3" or JSON "[1,2,3]".
      let parsed: unknown;
      try {
        parsed = text.startsWith("[") ? JSON.parse(text) : text.split(",").map((p) => p.trim());
      } catch {
        return { ok: false, error: "فرمت نامعتبر. مثال: 1,2,3 یا [1,2,3]" };
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return { ok: false, error: "حداقل یک شناسه وارد کنید. مثال: 1,2,3" };
      }
      const numbers: number[] = [];
      for (const item of parsed) {
        const num = typeof item === "number" ? item : Number.parseInt(String(item), 10);
        if (!Number.isInteger(num) || num < 0) {
          return { ok: false, error: "همه شناسه‌ها باید عدد صحیح باشند. مثال: 1,2,3" };
        }
        numbers.push(num);
      }
      return { ok: true, value: numbers };
    }
    case "json-object": {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return { ok: false, error: "باید یک آبجکت JSON معتبر باشد. مثال: {\"flow\":\"xtls\"}" };
        }
        return { ok: true, value: parsed };
      } catch {
        return { ok: false, error: "JSON نامعتبر است. مثال: {\"flow\":\"xtls\"}" };
      }
    }
  }
}
