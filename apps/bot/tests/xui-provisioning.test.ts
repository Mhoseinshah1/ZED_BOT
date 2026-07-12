import http from "node:http";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Short panel HTTP timeout so the timeout tests finish quickly. Must be set
// before the adapters module is imported.
process.env.PANEL_HTTP_TIMEOUT_MS = "700";

import { XuiAdapter, XuiClient } from "@zedbot/panel-adapters";

// =============================================================================
// XUI / Sanaei 3X-UI adapter against a mock HTTP server reproducing the real
// SANAEI API contract:
//   POST {base}/login                        form-encoded; HTTP 200 with
//                                            {"success":false} on bad creds;
//                                            session cookie on success
//   GET  {base}/panel/api/inbounds/list      {"success":true,"obj":[...]},
//                                            settings as a JSON STRING,
//                                            clientStats per inbound
//   POST {base}/panel/api/inbounds/addClient {"id","settings"} JSON; enforces
//                                            panel-wide unique client emails
//   POST {base}/panel/api/inbounds/{id}/delClient/{clientId}
// Unauthenticated API calls are redirected (302) exactly like the real panel.
// =============================================================================

const XUI_USER = "xadmin";
const XUI_PASS = "xui-secret-pass";
const SESSION = "mock-3xui-session-value-123";
const GIB = 1024n * 1024n * 1024n;

interface MockClient {
  id?: string;
  password?: string;
  email: string;
  flow?: string;
  totalGB: number;
  expiryTime: number;
  enable: boolean;
  limitIp?: number;
  tgId?: string;
  subId?: string;
  reset?: number;
}

interface MockInbound {
  id: number;
  enable: boolean;
  protocol: string;
  remark: string;
  port: number;
  clients: MockClient[];
  /** Overrides the serialized settings JSON (malformed-settings test). */
  rawSettings?: string;
  stats: Array<{ email: string; up: number; down: number; total: number; expiryTime: number; enable: boolean }>;
}

const mock = {
  basePath: "" as string,
  inbounds: [] as MockInbound[],
  wrongCredentials: false,
  hangLogin: false,
  listNonJson: false,
  addClientCalls: [] as Array<{ inboundId: number; client: MockClient }>,
  /** inboundId -> behavior for addClient. */
  addClientFail: new Map<number, "reject" | "hang">(),
  delClientCalls: [] as Array<{ inboundId: number; clientId: string }>,
  delClientFail: false,
  lastListCookie: null as string | null,
};

function resetMock(): void {
  mock.basePath = "";
  mock.inbounds = [];
  mock.wrongCredentials = false;
  mock.hangLogin = false;
  mock.listNonJson = false;
  mock.addClientCalls = [];
  mock.addClientFail = new Map();
  mock.delClientCalls = [];
  mock.delClientFail = false;
  mock.lastListCookie = null;
}

function addInbound(partial: Partial<MockInbound> & { id: number }): MockInbound {
  const inbound: MockInbound = {
    enable: true,
    protocol: "vless",
    remark: `inbound-${partial.id}`,
    port: 10000 + partial.id,
    clients: [],
    stats: [],
    ...partial,
  };
  mock.inbounds.push(inbound);
  return inbound;
}

let server: http.Server;
let host = "";
const hangingResponses: http.ServerResponse[] = [];

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function inboundJson(inbound: MockInbound): Record<string, unknown> {
  return {
    id: inbound.id,
    enable: inbound.enable,
    protocol: inbound.protocol,
    remark: inbound.remark,
    port: inbound.port,
    // The real panel stores settings as a JSON STRING inside the JSON doc.
    settings: inbound.rawSettings ?? JSON.stringify({ clients: inbound.clients, decryption: "none" }),
    streamSettings: JSON.stringify({ network: "tcp" }),
    clientStats: inbound.stats.map((s, i) => ({ id: i + 1, inboundId: inbound.id, ...s })),
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      const bp = mock.basePath;
      if (bp !== "" && !url.startsWith(`${bp}/`)) {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html>not found</html>");
        return;
      }
      const path = bp === "" ? url : url.slice(bp.length);

      if (req.method === "POST" && path === "/login") {
        if (mock.hangLogin) {
          hangingResponses.push(res);
          return;
        }
        const params = new URLSearchParams(await readBody(req));
        if (
          mock.wrongCredentials ||
          params.get("username") !== XUI_USER ||
          params.get("password") !== XUI_PASS
        ) {
          // Real 3x-ui: HTTP 200 with success=false on bad credentials.
          json(res, 200, { success: false, msg: "Invalid username or password" });
          return;
        }
        json(
          res,
          200,
          { success: true, msg: "Login Successfully", obj: null },
          { "Set-Cookie": `3x-ui=${SESSION}; Path=/; HttpOnly` },
        );
        return;
      }

      // Authenticated area: the real panel redirects to the login page.
      if ((req.headers.cookie ?? "") !== `3x-ui=${SESSION}`) {
        res.writeHead(302, { Location: `${bp}/` });
        res.end();
        return;
      }

      if (req.method === "GET" && path === "/panel/api/inbounds/list") {
        mock.lastListCookie = req.headers.cookie ?? null;
        if (mock.listNonJson) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html>legacy panel page</html>");
          return;
        }
        json(res, 200, { success: true, msg: "", obj: mock.inbounds.map(inboundJson) });
        return;
      }

      if (req.method === "POST" && path === "/panel/api/inbounds/addClient") {
        const body = JSON.parse(await readBody(req)) as { id: number; settings: string };
        const behavior = mock.addClientFail.get(body.id);
        if (behavior === "hang") {
          hangingResponses.push(res);
          return;
        }
        if (behavior === "reject") {
          json(res, 200, { success: false, msg: "An error occurred while adding a client" });
          return;
        }
        const inbound = mock.inbounds.find((i) => i.id === body.id);
        if (inbound === undefined) {
          json(res, 200, { success: false, msg: "Inbound not found" });
          return;
        }
        const settings = JSON.parse(body.settings) as { clients: MockClient[] };
        const client = settings.clients[0];
        // Real 3x-ui enforces panel-wide unique emails.
        const duplicate = mock.inbounds.some((i) => i.clients.some((c) => c.email === client.email));
        if (duplicate) {
          json(res, 200, { success: false, msg: "Duplicate email" });
          return;
        }
        inbound.clients.push(client);
        inbound.stats.push({
          email: client.email,
          up: 0,
          down: 0,
          total: client.totalGB,
          expiryTime: client.expiryTime,
          enable: true,
        });
        mock.addClientCalls.push({ inboundId: body.id, client });
        json(res, 200, { success: true, msg: "Client added" });
        return;
      }

      const delMatch = /^\/panel\/api\/inbounds\/(\d+)\/delClient\/([^/]+)$/.exec(path);
      if (req.method === "POST" && delMatch !== null) {
        const inboundId = Number(delMatch[1]);
        const clientId = decodeURIComponent(delMatch[2]);
        mock.delClientCalls.push({ inboundId, clientId });
        if (mock.delClientFail) {
          json(res, 200, { success: false, msg: "Error deleting client" });
          return;
        }
        const inbound = mock.inbounds.find((i) => i.id === inboundId);
        if (inbound !== undefined) {
          const before = inbound.clients.length;
          inbound.clients = inbound.clients.filter((c) => c.id !== clientId && c.password !== clientId);
          inbound.stats = inbound.stats.filter((s) =>
            inbound.clients.some((c) => c.email === s.email),
          );
          json(res, 200, { success: before !== inbound.clients.length, msg: "" });
          return;
        }
        json(res, 200, { success: false, msg: "Inbound not found" });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<html>not found</html>");
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      host = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  for (const res of hangingResponses) {
    res.destroy();
  }
  server.close();
});

afterEach(() => {
  resetMock();
});

function adapter(opts: { base?: string; username?: string; password?: string } = {}): XuiAdapter {
  return new XuiAdapter(
    new XuiClient({
      baseUrl: opts.base ?? host,
      username: opts.username ?? XUI_USER,
      password: opts.password ?? XUI_PASS,
      apiVariant: "SANAEI",
    }),
  );
}

const USERNAME = "zed_1001_abcd1234";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    username: USERNAME,
    note: "zedbot order:abcd1234 tg:1001",
    volumeBytes: 10n * GIB,
    durationDays: 30,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    templateUsername: null,
    dataLimitResetStrategy: null,
    subscriptionBaseUrl: null,
    inboundIds: [1],
    protocolSettings: null,
    trafficResetCycle: null,
    ...overrides,
  };
}

describe("XUI provisioning (HTTP contract)", () => {
  it("1. logs in with form credentials and reuses the session cookie", async () => {
    addInbound({ id: 1 });
    const health = await adapter().testConnection();
    expect(health.ok).toBe(true);

    const result = await adapter().createServiceAccount(createInput());
    expect(result.ok).toBe(true);
    // The authenticated list call carried the session cookie.
    expect(mock.lastListCookie).toBe(`3x-ui=${SESSION}`);
  });

  it("2. reports invalid credentials (HTTP 200 + success:false) as auth failure", async () => {
    mock.wrongCredentials = true;
    const health = await adapter().testConnection();
    expect(health.ok).toBe(false);

    const result = await adapter().createServiceAccount(createInput());
    expect(result.ok).toBe(false);
    expect(result.uncertain).toBeUndefined();
    expect(result.diagnostic?.code).toBe("auth-failed");
    expect(JSON.stringify(result)).not.toContain(XUI_PASS);
  });

  it("3. works behind a custom reverse-proxy base path", async () => {
    mock.basePath = "/secretpath";
    addInbound({ id: 1 });
    const result = await adapter({ base: `${host}/secretpath/` }).createServiceAccount(createInput());
    expect(result.ok).toBe(true);
    expect(mock.inbounds[0].clients).toHaveLength(1);

    // Wrong base path = login endpoint 404 -> unsupported variant/base path.
    const wrong = await adapter({ base: `${host}/wrongpath` }).createServiceAccount(createInput({ username: "zed_1001_wrongbp1" }));
    expect(wrong.ok).toBe(false);
    expect(wrong.diagnostic?.code).toBe("unsupported-variant");
  });

  it("4. retrieves and validates the inbound list for readiness", async () => {
    addInbound({ id: 1, protocol: "vless" });
    addInbound({ id: 2, protocol: "vmess" });
    const result = await adapter().checkProvisioningReadiness({ inboundIds: [1, 2] });
    expect(result.ready).toBe(true);
    expect(result.checks.find((c) => c.key === "read-endpoint")?.ok).toBe(true);
    expect(result.checks.find((c) => c.key === "inbounds")?.ok).toBe(true);
  });

  it("5. fails definitively when a configured inbound id does not exist", async () => {
    addInbound({ id: 1 });
    const result = await adapter().createServiceAccount(createInput({ inboundIds: [1, 99] }));
    expect(result.ok).toBe(false);
    expect(result.uncertain).toBeUndefined();
    expect(result.diagnostic?.code).toBe("inbound-missing");
    // Validated BEFORE any mutation: nothing was created anywhere.
    expect(mock.addClientCalls).toHaveLength(0);
  });

  it("6. refuses unsupported inbound protocols", async () => {
    addInbound({ id: 1, protocol: "shadowsocks" });
    const result = await adapter().createServiceAccount(createInput());
    expect(result.ok).toBe(false);
    expect(result.diagnostic?.code).toBe("unsupported-protocol");
    expect(mock.addClientCalls).toHaveLength(0);

    // Disabled inbounds are refused too.
    resetMock();
    addInbound({ id: 1, enable: false });
    const disabled = await adapter().createServiceAccount(createInput());
    expect(disabled.ok).toBe(false);
    expect(disabled.diagnostic?.code).toBe("inbound-disabled");
  });

  it("7. detects malformed settings JSON stored inside the inbound", async () => {
    addInbound({ id: 1, rawSettings: "{not-valid-json" });
    const result = await adapter().createServiceAccount(createInput());
    expect(result.ok).toBe(false);
    expect(result.diagnostic?.code).toBe("inbound-malformed");
    expect(mock.addClientCalls).toHaveLength(0);
  });

  it("8. creates a VLESS client with the full documented field set", async () => {
    addInbound({ id: 1, protocol: "vless" });
    const result = await adapter().createServiceAccount(createInput());
    expect(result.ok).toBe(true);
    expect(result.username).toBe(USERNAME);
    expect(result.remoteInboundIds).toEqual([1]);
    expect(result.subscriptionToken).toBe(USERNAME);

    const client = mock.inbounds[0].clients[0];
    expect(client.id).toMatch(UUID_RE);
    expect(client.password).toBeUndefined();
    expect(client.email).toBe(`${USERNAME}-1`);
    expect(client.totalGB).toBe(Number(10n * GIB)); // bytes despite the name
    expect(client.expiryTime).toBe(new Date("2027-01-01T00:00:00Z").getTime());
    expect(client.enable).toBe(true);
    expect(client.subId).toBe(USERNAME);
    expect(client.flow).toBe(""); // no flow unless explicitly configured
    expect(result.remoteClientId).toBe(client.id);

    // Explicitly configured flow is applied to VLESS clients.
    resetMock();
    addInbound({ id: 1, protocol: "vless" });
    const flowed = await adapter().createServiceAccount(
      createInput({ username: "zed_1001_flowed01", protocolSettings: { flow: "xtls-rprx-vision" } }),
    );
    expect(flowed.ok).toBe(true);
    expect(mock.inbounds[0].clients[0].flow).toBe("xtls-rprx-vision");
  });

  it("9. creates a VMess client (uuid, no flow field)", async () => {
    addInbound({ id: 1, protocol: "vmess" });
    const result = await adapter().createServiceAccount(createInput());
    expect(result.ok).toBe(true);
    const client = mock.inbounds[0].clients[0];
    expect(client.id).toMatch(UUID_RE);
    expect(client.flow).toBeUndefined();
    expect(client.password).toBeUndefined();
  });

  it("10. creates a Trojan client with a secure random password", async () => {
    addInbound({ id: 1, protocol: "trojan" });
    const result = await adapter().createServiceAccount(createInput());
    expect(result.ok).toBe(true);
    const client = mock.inbounds[0].clients[0];
    expect(client.id).toBeUndefined();
    expect(client.password).toMatch(/^[0-9a-f]{32}$/);
    expect(result.remoteClientId).toBe(client.password);
  });

  it("11. never reuses another client's credentials", async () => {
    const inbound = addInbound({ id: 1, protocol: "vless" });
    inbound.clients.push({
      id: "11111111-1111-4111-8111-111111111111",
      email: "someone-else",
      totalGB: 0,
      expiryTime: 0,
      enable: true,
      subId: "someoneelse",
    });
    const first = await adapter().createServiceAccount(createInput());
    const second = await adapter().createServiceAccount(createInput({ username: "zed_1002_other001" }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const ids = mock.inbounds[0].clients.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // all distinct
    expect(first.remoteClientId).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(first.remoteClientId).not.toBe(second.remoteClientId);
  });

  it("12. a duplicate retry recovers the existing client instead of creating another", async () => {
    addInbound({ id: 1, protocol: "vless" });
    const first = await adapter().createServiceAccount(createInput());
    expect(first.ok).toBe(true);
    const callsAfterFirst = mock.addClientCalls.length;

    const retry = await adapter().createServiceAccount(createInput());
    expect(retry.ok).toBe(true);
    expect(retry.remoteClientId).toBe(first.remoteClientId);
    expect(mock.addClientCalls.length).toBe(callsAfterFirst); // no new addClient
    expect(mock.inbounds[0].clients).toHaveLength(1);

    // Conflicting data (same label, foreign subId) -> safe conflict error.
    mock.inbounds[0].clients[0].subId = "foreign-sub-id";
    const conflict = await adapter().createServiceAccount(createInput());
    expect(conflict.ok).toBe(false);
    expect(conflict.uncertain).toBeUndefined();
    expect(conflict.diagnostic?.code).toBe("conflict");
  });

  it("13. provisions one client identity into every configured inbound", async () => {
    addInbound({ id: 1, protocol: "vless" });
    addInbound({ id: 2, protocol: "trojan" });
    const result = await adapter().createServiceAccount(createInput({ inboundIds: [1, 2] }));
    expect(result.ok).toBe(true);
    expect(result.remoteInboundIds).toEqual([1, 2]);
    expect(mock.inbounds[0].clients[0].email).toBe(`${USERNAME}-1`);
    expect(mock.inbounds[1].clients[0].email).toBe(`${USERNAME}-2`);
    // Shared subscription id groups the clients into one subscription.
    expect(mock.inbounds[0].clients[0].subId).toBe(USERNAME);
    expect(mock.inbounds[1].clients[0].subId).toBe(USERNAME);
    const metadata = result.remoteMetadata as { clients: Array<{ inboundId: number; email: string }> };
    expect(metadata.clients).toHaveLength(2);
  });

  it("14. partial multi-inbound failure triggers confirmed compensating cleanup", async () => {
    addInbound({ id: 1, protocol: "vless" });
    addInbound({ id: 2, protocol: "vless" });
    mock.addClientFail.set(2, "reject");
    const result = await adapter().createServiceAccount(createInput({ inboundIds: [1, 2] }));
    expect(result.ok).toBe(false);
    // Cleanup was confirmed via re-read -> DEFINITE failure (refund-safe).
    expect(result.uncertain).toBeUndefined();
    expect(mock.delClientCalls.length).toBeGreaterThan(0);
    expect(mock.inbounds[0].clients).toHaveLength(0); // client 1 removed
    expect(mock.inbounds[1].clients).toHaveLength(0);
  });

  it("15. unconfirmable cleanup returns UNKNOWN, never definite failure", async () => {
    addInbound({ id: 1, protocol: "vless" });
    addInbound({ id: 2, protocol: "vless" });
    mock.addClientFail.set(2, "reject");
    mock.delClientFail = true; // deletion fails -> re-read still shows client 1
    const result = await adapter().createServiceAccount(createInput({ inboundIds: [1, 2] }));
    expect(result.ok).toBe(false);
    expect(result.uncertain).toBe(true);
    expect(result.diagnostic?.code).toBe("partial-state");
    expect(result.diagnostic?.certainty).toBe("unknown");
    expect(mock.inbounds[0].clients).toHaveLength(1); // orphan remains (documented)

    // A TIMED-OUT addClient is UNKNOWN even when the re-read looks clean:
    // the hung request may land after the verification read.
    resetMock();
    addInbound({ id: 1, protocol: "vless" });
    mock.addClientFail.set(1, "hang");
    const inflight = await adapter().createServiceAccount(createInput({ username: "zed_1001_inflight" }));
    expect(inflight.ok).toBe(false);
    expect(inflight.uncertain).toBe(true);
    expect(inflight.diagnostic?.certainty).toBe("unknown");
  });

  it("16. returns a subscription URL only when the operator configured a real base", async () => {
    addInbound({ id: 1 });
    const bare = await adapter().createServiceAccount(createInput());
    expect(bare.ok).toBe(true);
    expect(bare.subscriptionUrl).toBeUndefined(); // never fabricated

    resetMock();
    addInbound({ id: 1 });
    const withBase = await adapter().createServiceAccount(
      createInput({ subscriptionBaseUrl: "https://sub.example.com:2096/sub" }),
    );
    expect(withBase.subscriptionUrl).toBe(`https://sub.example.com:2096/sub/${USERNAME}`);
  });

  it("17. readiness requires auth + inbound list + valid configured inbounds", async () => {
    addInbound({ id: 1 });
    const noIds = await adapter().checkProvisioningReadiness({ inboundIds: [] });
    expect(noIds.ready).toBe(false);
    expect(noIds.diagnostic?.code).toBe("config-incomplete");
    expect(noIds.checks.find((c) => c.key === "auth")?.ok).toBe(true); // login worked, still not ready

    const missing = await adapter().checkProvisioningReadiness({ inboundIds: [7] });
    expect(missing.ready).toBe(false);
    expect(missing.diagnostic?.code).toBe("inbound-missing");

    const ok = await adapter().checkProvisioningReadiness({ inboundIds: [1] });
    expect(ok.ready).toBe(true);
    expect(ok.capabilities).toContain("createService");
    expect(ok.capabilities).toContain("readService");
    expect(ok.capabilities).not.toContain("renewService"); // honest capabilities
  });

  it("18. handles timeouts and non-JSON responses structurally", async () => {
    mock.hangLogin = true;
    const timedOut = await adapter().createServiceAccount(createInput());
    expect(timedOut.ok).toBe(false);
    expect(timedOut.uncertain).toBeUndefined(); // login is pre-mutation
    expect(timedOut.diagnostic?.code).toBe("timeout");

    resetMock();
    addInbound({ id: 1 });
    mock.listNonJson = true;
    const nonJson = await adapter().createServiceAccount(createInput());
    expect(nonJson.ok).toBe(false);
    expect(nonJson.diagnostic?.code).toBe("unsupported-variant");
    expect(nonJson.errorMessage).not.toContain("<html>");
  });

  it("19. never leaks credentials, cookies or client secrets in results/diagnostics", async () => {
    addInbound({ id: 1, protocol: "trojan" });
    mock.addClientFail.set(1, "reject");
    const failed = await adapter().createServiceAccount(createInput());
    const dump = JSON.stringify(failed);
    expect(dump).not.toContain(XUI_PASS);
    expect(dump).not.toContain(SESSION);

    mock.wrongCredentials = true;
    const auth = await adapter().createServiceAccount(createInput({ username: "zed_1001_leak0001" }));
    expect(JSON.stringify(auth.diagnostic)).not.toContain(XUI_PASS);
  });

  it("20. supports reconciliation reads with positive absence detection", async () => {
    addInbound({ id: 1, protocol: "vless" });
    addInbound({ id: 2, protocol: "trojan" });
    const created = await adapter().createServiceAccount(createInput({ inboundIds: [1, 2] }));
    expect(created.ok).toBe(true);

    // Existing service: aggregated quota/expiry/status + usage from stats.
    mock.inbounds[0].stats[0].up = 1000;
    mock.inbounds[0].stats[0].down = 2000;
    mock.inbounds[1].stats[0].down = 500;
    const read = await adapter().getServiceAccount({ username: USERNAME });
    expect(read.ok).toBe(true);
    expect(read.totalBytes).toBe(10n * GIB);
    expect(read.usedBytes).toBe(3500n);
    expect(read.status).toBe("active");
    expect(read.expiresAt?.getTime()).toBe(new Date("2027-01-01T00:00:00Z").getTime());
    expect(read.subscriptionToken).toBe(USERNAME);

    // Disabled client -> disabled status.
    mock.inbounds[0].clients[0].enable = false;
    const disabled = await adapter().getServiceAccount({ username: USERNAME });
    expect(disabled.status).toBe("disabled");

    // Absent client with a fully readable panel -> POSITIVE notFound.
    const absent = await adapter().getServiceAccount({ username: "zed_9999_absent01" });
    expect(absent.ok).toBe(false);
    expect(absent.notFound).toBe(true);

    // A malformed inbound removes the proof of absence: NOT notFound.
    addInbound({ id: 3, rawSettings: "{broken" });
    const unsure = await adapter().getServiceAccount({ username: "zed_9999_absent01" });
    expect(unsure.ok).toBe(false);
    expect(unsure.notFound).toBeUndefined();

    // Unreachable panel never reports notFound either.
    const dead = new XuiAdapter(
      new XuiClient({ baseUrl: "http://127.0.0.1:1", username: XUI_USER, password: XUI_PASS }),
    );
    const unreachable = await dead.getServiceAccount({ username: USERNAME });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.notFound).toBeUndefined();
  });
});
