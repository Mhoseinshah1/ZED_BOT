import type { Panel } from "@zedbot/database";

import {
  runPanelReadinessCheck,
  type PanelReadinessReport,
} from "./panel-readiness.service.js";

/**
 * Admin "test connection" surface: runs the full authenticated
 * provisioning-readiness check (login, read access, template/inbound
 * validation) and persists the result on the panel row. A merely reachable
 * URL or a successful login alone never marks the panel ready.
 *
 * Credentials are decrypted only inside the adapter factory and never
 * logged or returned; the report contains sanitized Persian lines only.
 */
export async function testPanelConnection(panel: Panel): Promise<PanelReadinessReport> {
  return runPanelReadinessCheck(panel);
}
