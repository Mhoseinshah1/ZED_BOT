import { describe, expect, it } from "vitest";

import {
  MarzbanAdapter,
  MarzbanClient,
  XuiAdapter,
  XuiClient,
} from "@zedbot/panel-adapters";

// =============================================================================
// OPT-IN staging verification against REAL panels. Disabled by default -
// these suites run ONLY when the corresponding staging environment variables
// are set, and must NEVER point at production panels:
//
//   MARZBAN_STAGING_URL / MARZBAN_STAGING_USERNAME / MARZBAN_STAGING_PASSWORD
//   MARZBAN_STAGING_TEMPLATE            (existing template user on staging)
//   XUI_STAGING_URL / XUI_STAGING_USERNAME / XUI_STAGING_PASSWORD
//   XUI_STAGING_INBOUND_IDS             (comma-separated, e.g. "1,2")
//
// Behavior:
//   - created accounts/clients are prefixed "zedstaging_" + timestamp
//   - cleanup: Marzban DELETE /api/user/{u}; XUI delClient. If cleanup fails
//     the test logs the safe username so it can be removed manually.
//   - credentials are never printed; assertions only touch safe fields.
// =============================================================================

const marzbanEnv = {
  url: process.env.MARZBAN_STAGING_URL ?? "",
  username: process.env.MARZBAN_STAGING_USERNAME ?? "",
  password: process.env.MARZBAN_STAGING_PASSWORD ?? "",
  template: process.env.MARZBAN_STAGING_TEMPLATE ?? "",
};
const hasMarzbanStaging =
  marzbanEnv.url !== "" && marzbanEnv.username !== "" && marzbanEnv.password !== "";

const xuiEnv = {
  url: process.env.XUI_STAGING_URL ?? "",
  username: process.env.XUI_STAGING_USERNAME ?? "",
  password: process.env.XUI_STAGING_PASSWORD ?? "",
  inboundIds: (process.env.XUI_STAGING_INBOUND_IDS ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n)),
};
const hasXuiStaging = xuiEnv.url !== "" && xuiEnv.username !== "" && xuiEnv.password !== "";

const GIB = 1024n * 1024n * 1024n;

function stagingUsername(): string {
  return `zedstaging_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`;
}

describe.runIf(hasMarzbanStaging)("Marzban staging verification (opt-in)", () => {
  const client = new MarzbanClient({
    baseUrl: marzbanEnv.url,
    username: marzbanEnv.username,
    password: marzbanEnv.password,
  });
  const adapter = new MarzbanAdapter(client);

  it("authenticated readiness passes on the staging panel", async () => {
    const result = await adapter.checkProvisioningReadiness({
      templateUsername: marzbanEnv.template === "" ? null : marzbanEnv.template,
    });
    expect(result.checks.find((c) => c.key === "auth")?.ok).toBe(true);
    expect(result.checks.find((c) => c.key === "read-endpoint")?.ok).toBe(true);
  }, 30_000);

  it.runIf(marzbanEnv.template !== "")(
    "creates, reads and deletes a temporary staging account",
    async () => {
      const username = stagingUsername();
      const created = await adapter.createServiceAccount({
        username,
        note: "zedbot staging test - safe to delete",
        volumeBytes: 1n * GIB,
        durationDays: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
        templateUsername: marzbanEnv.template,
      });
      expect(created.ok).toBe(true);
      expect(created.username).toBe(username);

      const read = await adapter.getServiceAccount({ username });
      expect(read.ok).toBe(true);
      expect(read.totalBytes).toBe(1n * GIB);

      // Cleanup; on failure the safe username is printed for manual removal.
      const token = await client.getToken();
      expect(token.ok).toBe(true);
      const deleted = await client.deleteUser(token.token ?? "", username);
      if (!deleted.ok) {
        console.warn(`MANUAL CLEANUP NEEDED: staging Marzban account "${username}"`);
      }
      expect(deleted.ok).toBe(true);
      const gone = await adapter.getServiceAccount({ username });
      expect(gone.notFound).toBe(true);
    },
    60_000,
  );
});

describe.runIf(hasXuiStaging)("XUI staging verification (opt-in)", () => {
  const client = new XuiClient({
    baseUrl: xuiEnv.url,
    username: xuiEnv.username,
    password: xuiEnv.password,
    apiVariant: "SANAEI",
  });
  const adapter = new XuiAdapter(client);

  it("authenticated readiness passes on the staging panel", async () => {
    const result = await adapter.checkProvisioningReadiness({ inboundIds: xuiEnv.inboundIds });
    expect(result.checks.find((c) => c.key === "auth")?.ok).toBe(true);
    expect(result.checks.find((c) => c.key === "read-endpoint")?.ok).toBe(true);
  }, 30_000);

  it.runIf(xuiEnv.inboundIds.length > 0)(
    "creates, reads and deletes a temporary staging client",
    async () => {
      const username = stagingUsername();
      const created = await adapter.createServiceAccount({
        username,
        note: "zedbot staging test - safe to delete",
        volumeBytes: 1n * GIB,
        durationDays: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
        inboundIds: xuiEnv.inboundIds,
      });
      expect(created.ok).toBe(true);
      expect(created.remoteClientId).toBeDefined();

      const read = await adapter.getServiceAccount({ username });
      expect(read.ok).toBe(true);

      // Cleanup via delClient, recovering each per-inbound identifier from
      // the live inbound list (multi-inbound clients have distinct ids).
      // On failure the safe label is printed for manual removal.
      const login = await client.login();
      expect(login.ok).toBe(true);
      const listed = await client.listInbounds(login.cookie ?? "");
      let allDeleted = listed.ok;
      if (listed.ok && Array.isArray(listed.envelope?.obj)) {
        for (const inbound of listed.envelope.obj as Array<{ id: number; settings?: string }>) {
          let clients: Array<{ id?: string; password?: string; email?: string }> = [];
          try {
            clients = (JSON.parse(inbound.settings ?? "{}") as { clients?: typeof clients }).clients ?? [];
          } catch {
            continue;
          }
          for (const entry of clients) {
            if (typeof entry.email === "string" && entry.email.startsWith(username)) {
              const identifier = entry.id ?? entry.password ?? "";
              const deleted = await client.deleteClient(login.cookie ?? "", inbound.id, identifier);
              allDeleted = allDeleted && deleted.ok;
            }
          }
        }
      }
      if (!allDeleted) {
        console.warn(`MANUAL CLEANUP NEEDED: staging XUI clients labeled "${username}-*"`);
      }
      const gone = await adapter.getServiceAccount({ username });
      expect(gone.notFound).toBe(true);
    },
    60_000,
  );
});
