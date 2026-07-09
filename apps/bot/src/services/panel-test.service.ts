import type { Panel } from "@zedbot/database";
import { decryptSecret, errorMessage } from "@zedbot/shared";
import {
  MarzbanAdapter,
  MarzbanClient,
  XuiAdapter,
  XuiClient,
  type PanelHealthResult,
} from "@zedbot/panel-adapters";

import { logger } from "../core/logger.js";

/**
 * Decrypts the panel's stored credential and runs the adapter's
 * testConnection. Credentials are decrypted only here and never logged or
 * returned. Any decryption/config failure is reported as a safe result.
 */
export async function testPanelConnection(panel: Panel): Promise<PanelHealthResult> {
  try {
    if (panel.type === "MARZBAN") {
      if (panel.username === null || panel.passwordEncrypted === null) {
        return { ok: false, message: "اطلاعات ورود مرزبان کامل نیست." };
      }
      const password = decryptSecret(panel.passwordEncrypted);
      const adapter = new MarzbanAdapter(
        new MarzbanClient({ baseUrl: panel.baseUrl, username: panel.username, password }),
      );
      return await adapter.testConnection();
    }
    if (panel.tokenEncrypted === null) {
      return { ok: false, message: "توکن پنل ثبت نشده است." };
    }
    const token = decryptSecret(panel.tokenEncrypted);
    const adapter = new XuiAdapter(new XuiClient({ baseUrl: panel.baseUrl, token }));
    return await adapter.testConnection();
  } catch (err) {
    // Covers decryption failures (e.g. APP_SECRET changed) - never expose it.
    logger.warn("panel test connection failed", { panelId: panel.id, error: errorMessage(err) });
    return { ok: false, message: "اجرای تست اتصال ممکن نشد. تنظیمات پنل را بررسی کنید." };
  }
}
