import http from "node:http";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Short panel HTTP timeout so the timeout tests finish quickly. Must be set
// before the adapters module is imported.
process.env.PANEL_HTTP_TIMEOUT_MS = "700";

import { MarzbanAdapter, MarzbanClient } from "@zedbot/panel-adapters";

// =============================================================================
// Marzban adapter against a mock HTTP server reproducing the documented
// Marzban API contract (also covers RickPanelAPI-compatible variants, which
// expose the same endpoints/fields):
//   POST /api/admin/token   form-encoded OAuth2 password grant
//   GET  /api/user/{u}      user object or 404 {"detail": "User not found"}
//   POST /api/user          create; 409 on duplicate; 422 validation errors
// No fake successes: every assertion checks the real payload the adapter
// sent or the real state the mock stored.
// =============================================================================

const ADMIN_USER = "paneladmin";
const ADMIN_PASS = "panel-secret-pass";
const TOKEN = "mock-access-token-123";
const GIB = 1024n * 1024n * 1024n;

interface MockUser {
  username: string;
  proxies: Record<string, Record<string, unknown>>;
  inbounds: Record<string, string[]>;
  data_limit: number;
  data_limit_reset_strategy?: string;
  expire: number;
  status: string;
  note: string;
  subscription_url?: string;
  used_traffic?: number;
  links?: string[];
}

// Mutable mock behavior knobs (reset per test).
const mock = {
  users: new Map<string, MockUser>(),
  lastTokenRequest: null as { contentType: string; body: string } | null,
  createPayloads: [] as Array<Record<string, unknown>>,
  createCount: 0,
  /** Force a specific create response: status + raw body. */
  createResponse: null as { status: number; body: string; contentType?: string } | null,
  /** Hang POST /api/user without responding (timeout path). */
  hangCreate: false,
  /** Hang GET /api/user/* (makes the post-timeout probe fail too). */
  hangGetUser: false,
  /** Force the token endpoint to reject credentials. */
  wrongCredentials: false,
  /** Force a non-JSON 200 on the token endpoint. */
  tokenNonJson: false,
  /** subscription_url value assigned to created users. */
  subscriptionUrl: "/sub/TOKEN123" as string | undefined,
};

function resetMock(): void {
  mock.users.clear();
  mock.lastTokenRequest = null;
  mock.createPayloads = [];
  mock.createCount = 0;
  mock.createResponse = null;
  mock.hangCreate = false;
  mock.hangGetUser = false;
  mock.wrongCredentials = false;
  mock.tokenNonJson = false;
  mock.subscriptionUrl = "/sub/TOKEN123";
}

let server: http.Server;
let baseUrl = "";
const hangingResponses: http.ServerResponse[] = [];

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function userJson(user: MockUser): Record<string, unknown> {
  return {
    username: user.username,
    status: user.status,
    proxies: user.proxies,
    inbounds: user.inbounds,
    data_limit: user.data_limit,
    data_limit_reset_strategy: user.data_limit_reset_strategy ?? "no_reset",
    expire: user.expire,
    note: user.note,
    used_traffic: user.used_traffic ?? 0,
    subscription_url: mock.subscriptionUrl,
    links: user.links ?? [],
    // RickPanelAPI-compatible panels add extra fields; the adapter must
    // tolerate unknown keys.
    extra_vendor_field: { nested: true },
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/api/admin/token") {
        const body = await readBody(req);
        mock.lastTokenRequest = { contentType: req.headers["content-type"] ?? "", body };
        if (mock.tokenNonJson) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html>login page</html>");
          return;
        }
        // Contract: form-encoded OAuth2 password grant only.
        if (!(req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) {
          json(res, 422, { detail: [{ loc: ["body", "grant_type"], msg: "field required" }] });
          return;
        }
        const params = new URLSearchParams(body);
        if (
          mock.wrongCredentials ||
          params.get("username") !== ADMIN_USER ||
          params.get("password") !== ADMIN_PASS
        ) {
          json(res, 401, { detail: "Incorrect username or password" });
          return;
        }
        json(res, 200, { access_token: TOKEN, token_type: "bearer" });
        return;
      }

      // Everything below requires the bearer token.
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        json(res, 401, { detail: "Not authenticated" });
        return;
      }

      const userMatch = /^\/api\/user\/([^/]+)$/.exec(url);
      if (req.method === "GET" && userMatch !== null) {
        // hangGetUser only affects service usernames (zed_*) so template
        // reads still answer and the create/probe path is reached.
        if (mock.hangGetUser && decodeURIComponent(userMatch[1]).startsWith("zed_")) {
          hangingResponses.push(res);
          return;
        }
        const user = mock.users.get(decodeURIComponent(userMatch[1]));
        if (user === undefined) {
          json(res, 404, { detail: "User not found" });
          return;
        }
        json(res, 200, userJson(user));
        return;
      }

      if (req.method === "POST" && url === "/api/user") {
        if (mock.hangCreate) {
          hangingResponses.push(res);
          return;
        }
        if (mock.createResponse !== null) {
          res.writeHead(mock.createResponse.status, {
            "Content-Type": mock.createResponse.contentType ?? "text/html",
          });
          res.end(mock.createResponse.body);
          return;
        }
        const payload = JSON.parse(await readBody(req)) as Record<string, unknown>;
        mock.createPayloads.push(payload);
        mock.createCount += 1;
        const username = payload["username"] as string;
        if (mock.users.has(username)) {
          json(res, 409, { detail: "User already exists" });
          return;
        }
        const user: MockUser = {
          username,
          proxies: (payload["proxies"] as MockUser["proxies"]) ?? {},
          inbounds: (payload["inbounds"] as MockUser["inbounds"]) ?? {},
          data_limit: (payload["data_limit"] as number) ?? 0,
          data_limit_reset_strategy: payload["data_limit_reset_strategy"] as string,
          expire: (payload["expire"] as number) ?? 0,
          status: (payload["status"] as string) ?? "active",
          note: (payload["note"] as string) ?? "",
        };
        mock.users.set(username, user);
        json(res, 200, userJson(user));
        return;
      }

      res.writeHead(404);
      res.end();
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${address.port}`;
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

function adapter(base = baseUrl, username = ADMIN_USER, password = ADMIN_PASS): MarzbanAdapter {
  return new MarzbanAdapter(new MarzbanClient({ baseUrl: base, username, password }));
}

/** Registers a template user on the mock panel. */
function addTemplate(
  name: string,
  proxies: MockUser["proxies"],
  inbounds: MockUser["inbounds"] = { vless: ["VLESS TCP"] },
): void {
  mock.users.set(name, {
    username: name,
    proxies,
    inbounds,
    data_limit: 999,
    expire: 0,
    status: "active",
    note: "template",
  });
}

const CREATE_INPUT = {
  username: "zed_1001_abcd1234",
  note: "zedbot order:abcd1234 tg:1001",
  volumeBytes: 10n * GIB,
  durationDays: 30,
  expiresAt: new Date("2027-01-01T00:00:00Z"),
  templateUsername: "tpl",
  dataLimitResetStrategy: null,
  subscriptionBaseUrl: null,
  inboundIds: null,
  protocolSettings: null,
  trafficResetCycle: null,
};

describe("Marzban provisioning (HTTP contract)", () => {
  it("1. authenticates and creates a service account with the documented payload", async () => {
    addTemplate("tpl", { vless: { id: "template-uuid", flow: "xtls-rprx-vision" } });
    const result = await adapter().createServiceAccount({ ...CREATE_INPUT });
    expect(result.ok).toBe(true);
    expect(result.username).toBe(CREATE_INPUT.username);
    expect(mock.users.has(CREATE_INPUT.username)).toBe(true);

    const payload = mock.createPayloads[0];
    expect(payload["username"]).toBe(CREATE_INPUT.username);
    expect(payload["data_limit"]).toBe(Number(10n * GIB));
    expect(payload["expire"]).toBe(Math.floor(CREATE_INPUT.expiresAt.getTime() / 1000));
    expect(payload["data_limit_reset_strategy"]).toBe("no_reset");
    expect(payload["status"]).toBe("active");
    expect(payload["note"]).toBe(CREATE_INPUT.note);
    // Only documented fields - nothing sent blindly.
    expect(Object.keys(payload).sort()).toEqual([
      "data_limit",
      "data_limit_reset_strategy",
      "expire",
      "inbounds",
      "note",
      "proxies",
      "status",
      "username",
    ]);
  });

  it("2. sends the login as a form-encoded OAuth2 password grant", async () => {
    addTemplate("tpl", { vless: {} });
    await adapter().createServiceAccount({ ...CREATE_INPUT });
    expect(mock.lastTokenRequest).not.toBeNull();
    expect(mock.lastTokenRequest?.contentType).toContain("application/x-www-form-urlencoded");
    const params = new URLSearchParams(mock.lastTokenRequest?.body ?? "");
    expect(params.get("grant_type")).toBe("password");
    expect(params.get("username")).toBe(ADMIN_USER);
  });

  it("3. reports invalid credentials as a definite auth failure", async () => {
    mock.wrongCredentials = true;
    const result = await adapter().createServiceAccount({ ...CREATE_INPUT });
    expect(result.ok).toBe(false);
    expect(result.uncertain).toBeUndefined();
    expect(result.diagnostic?.code).toBe("auth-failed");
    expect(mock.createCount).toBe(0);
    // Credentials never leak into messages/diagnostics.
    expect(JSON.stringify(result)).not.toContain(ADMIN_PASS);
  });

  it("4. reports a missing template user with a structured diagnostic", async () => {
    const result = await adapter().createServiceAccount({ ...CREATE_INPUT });
    expect(result.ok).toBe(false);
    expect(result.diagnostic?.code).toBe("template-not-found");
    expect(result.diagnostic?.certainty).toBe("definite");
    expect(mock.createCount).toBe(0);
  });

  it("5. rejects a template without proxies", async () => {
    addTemplate("tpl", {});
    const result = await adapter().createServiceAccount({ ...CREATE_INPUT });
    expect(result.ok).toBe(false);
    expect(result.diagnostic?.code).toBe("template-invalid");
    expect(mock.createCount).toBe(0);
  });

  it("6. copies every protocol from a multi-protocol template", async () => {
    addTemplate(
      "tpl",
      { vless: { id: "u1", flow: "xtls-rprx-vision" }, vmess: { id: "u2" }, trojan: { password: "p1" } },
      { vless: ["VLESS TCP"], vmess: ["VMESS WS"], trojan: ["TROJAN TCP"] },
    );
    const result = await adapter().createServiceAccount({ ...CREATE_INPUT });
    expect(result.ok).toBe(true);
    const proxies = mock.createPayloads[0]["proxies"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(proxies).sort()).toEqual(["trojan", "vless", "vmess"]);
    const inbounds = mock.createPayloads[0]["inbounds"] as Record<string, string[]>;
    expect(inbounds["vmess"]).toEqual(["VMESS WS"]);
  });

  it("7. strips per-user secrets (id/password) but keeps reusable settings", async () => {
    addTemplate("tpl", {
      vless: { id: "template-secret-uuid", flow: "xtls-rprx-vision" },
      trojan: { password: "template-secret-pass" },
    });
    const result = await adapter().createServiceAccount({ ...CREATE_INPUT });
    expect(result.ok).toBe(true);
    const proxies = mock.createPayloads[0]["proxies"] as Record<string, Record<string, unknown>>;
    expect(proxies["vless"]).toEqual({ flow: "xtls-rprx-vision" });
    expect(proxies["trojan"]).toEqual({});
    expect(JSON.stringify(mock.createPayloads[0])).not.toContain("template-secret");
  });

  it("8. provisions from explicit protocol settings without a template", async () => {
    const result = await adapter().createServiceAccount({
      ...CREATE_INPUT,
      templateUsername: null,
      protocolSettings: {
        proxies: { vless: { flow: "", id: "pasted-secret" } },
        inbounds: { vless: ["VLESS TCP"] },
      },
    });
    expect(result.ok).toBe(true);
    const proxies = mock.createPayloads[0]["proxies"] as Record<string, Record<string, unknown>>;
    // Even operator-pasted secrets are stripped.
    expect(proxies["vless"]).toEqual({ flow: "" });
    expect(mock.createPayloads[0]["inbounds"]).toEqual({ vless: ["VLESS TCP"] });

    // Direct protocol-map shape is accepted too.
    const direct = await adapter().createServiceAccount({
      ...CREATE_INPUT,
      username: "zed_1001_direct01",
      templateUsername: null,
      protocolSettings: { vmess: {} },
    });
    expect(direct.ok).toBe(true);

    // Neither template nor explicit settings -> config-incomplete, no call.
    const none = await adapter().createServiceAccount({
      ...CREATE_INPUT,
      username: "zed_1001_none0001",
      templateUsername: null,
      protocolSettings: null,
    });
    expect(none.ok).toBe(false);
    expect(none.diagnostic?.code).toBe("config-incomplete");
  });

  it("9. absolutizes a relative subscription URL without duplicating path segments", async () => {
    addTemplate("tpl", { vless: {} });
    mock.subscriptionUrl = "/sub/TOKEN123";
    const plain = await adapter().createServiceAccount({
      ...CREATE_INPUT,
      subscriptionBaseUrl: "https://sub.example.com",
    });
    expect(plain.subscriptionUrl).toBe("https://sub.example.com/sub/TOKEN123");

    // Base already carrying the sub path prefix - never duplicated.
    const overlapping = await adapter().createServiceAccount({
      ...CREATE_INPUT,
      username: "zed_1001_overlap1",
      subscriptionBaseUrl: "https://sub.example.com/sub",
    });
    expect(overlapping.subscriptionUrl).toBe("https://sub.example.com/sub/TOKEN123");

    // Reverse-proxy prefix is preserved.
    const prefixed = await adapter().createServiceAccount({
      ...CREATE_INPUT,
      username: "zed_1001_prefix01",
      subscriptionBaseUrl: "https://proxy.example.com/marzban",
    });
    expect(prefixed.subscriptionUrl).toBe("https://proxy.example.com/marzban/sub/TOKEN123");
  });

  it("10. passes an absolute subscription URL through untouched", async () => {
    addTemplate("tpl", { vless: {} });
    mock.subscriptionUrl = "https://cdn.example.com/sub/ABS999";
    const result = await adapter().createServiceAccount({
      ...CREATE_INPUT,
      subscriptionBaseUrl: "https://sub.example.com",
    });
    expect(result.subscriptionUrl).toBe("https://cdn.example.com/sub/ABS999");
  });

  it("11. recovers a duplicate username only when it belongs to the same order", async () => {
    addTemplate("tpl", { vless: {} });
    // Pre-existing account from a crashed attempt of the SAME order.
    mock.users.set(CREATE_INPUT.username, {
      username: CREATE_INPUT.username,
      proxies: { vless: {} },
      inbounds: {},
      data_limit: Number(10n * GIB),
      expire: 0,
      status: "active",
      note: CREATE_INPUT.note,
    });
    const recovered = await adapter().createServiceAccount({ ...CREATE_INPUT });
    expect(recovered.ok).toBe(true);
    expect(recovered.username).toBe(CREATE_INPUT.username);

    // Same username but a DIFFERENT order's note -> conflict, never adopted.
    mock.users.set(CREATE_INPUT.username, {
      ...(mock.users.get(CREATE_INPUT.username) as MockUser),
      note: "zedbot order:ffffffff tg:9999",
    });
    const conflict = await adapter().createServiceAccount({ ...CREATE_INPUT });
    expect(conflict.ok).toBe(false);
    expect(conflict.uncertain).toBeUndefined();
    expect(conflict.diagnostic?.code).toBe("conflict");
  });

  it("12. survives non-JSON error responses with a sanitized message", async () => {
    addTemplate("tpl", { vless: {} });
    mock.createResponse = { status: 400, body: "<html>Bad Gateway-ish page</html>" };
    const result = await adapter().createServiceAccount({ ...CREATE_INPUT });
    expect(result.ok).toBe(false);
    expect(result.uncertain).toBeUndefined(); // 4xx = definite rejection
    expect(result.errorMessage).toContain("HTTP 400");
    expect(result.errorMessage).not.toContain("<html>");

    // Non-JSON 200 on the token endpoint is "malformed", not "unreachable".
    mock.tokenNonJson = true;
    const token = await adapter().getServiceAccount({ username: "whoever" });
    expect(token.ok).toBe(false);
    expect(token.errorMessage).toContain("non-JSON");
  });

  it("13. create timeouts recover landed accounts and never claim definite absence", async () => {
    addTemplate("tpl", { vless: {} });

    // Timeout but the request actually landed (account pre-exists with our
    // note): the read-back probe recovers it as a success.
    mock.users.set(CREATE_INPUT.username, {
      username: CREATE_INPUT.username,
      proxies: { vless: {} },
      inbounds: {},
      data_limit: Number(10n * GIB),
      expire: 0,
      status: "active",
      note: CREATE_INPUT.note,
    });
    mock.hangCreate = true;
    const recovered = await adapter().createServiceAccount({ ...CREATE_INPUT });
    expect(recovered.ok).toBe(true);
    expect(recovered.username).toBe(CREATE_INPUT.username);

    // Timeout with a 404 probe: the hung request may still land AFTER the
    // probe, so the outcome is UNKNOWN - never a refundable definite failure.
    const unknown404 = await adapter().createServiceAccount({
      ...CREATE_INPUT,
      username: "zed_1001_tmo40401",
    });
    expect(unknown404.ok).toBe(false);
    expect(unknown404.uncertain).toBe(true);

    // Probe hangs too -> UNKNOWN as well.
    mock.hangGetUser = true;
    const unknown = await adapter().createServiceAccount({
      ...CREATE_INPUT,
      username: "zed_1001_unknown1",
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.uncertain).toBe(true);
    expect(unknown.diagnostic?.certainty).toBe("unknown");

    // A 5xx RESPONSE (panel answered - nothing can still be in flight) plus
    // a 404 probe IS definite: refund-safe.
    mock.hangCreate = false;
    mock.hangGetUser = false;
    mock.createResponse = { status: 500, body: '{"detail":"internal error"}', contentType: "application/json" };
    const definite = await adapter().createServiceAccount({
      ...CREATE_INPUT,
      username: "zed_1001_definite",
    });
    expect(definite.ok).toBe(false);
    expect(definite.uncertain).toBeUndefined();
  });

  it("14. maps unlimited volume and unlimited expiry to 0/0", async () => {
    addTemplate("tpl", { vless: {} });
    const result = await adapter().createServiceAccount({
      ...CREATE_INPUT,
      volumeBytes: null,
      durationDays: 0,
      expiresAt: null,
    });
    expect(result.ok).toBe(true);
    expect(mock.createPayloads[0]["data_limit"]).toBe(0);
    expect(mock.createPayloads[0]["expire"]).toBe(0);
  });

  it("15. rejects volumes beyond the safe integer range without calling the panel", async () => {
    addTemplate("tpl", { vless: {} });
    const result = await adapter().createServiceAccount({
      ...CREATE_INPUT,
      volumeBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    });
    expect(result.ok).toBe(false);
    expect(result.uncertain).toBeUndefined();
    expect(result.diagnostic?.code).toBe("unsafe-volume");
    expect(mock.createCount).toBe(0);
    expect(mock.lastTokenRequest).toBeNull(); // failed before any HTTP call
  });

  it("16. normalizes base URLs: trailing slash and a pasted /api suffix", async () => {
    addTemplate("tpl", { vless: {} });
    const withApi = await adapter(`${baseUrl}/api`).createServiceAccount({ ...CREATE_INPUT });
    expect(withApi.ok).toBe(true);

    const withSlashes = await adapter(`${baseUrl}///`).createServiceAccount({
      ...CREATE_INPUT,
      username: "zed_1001_slashes1",
    });
    expect(withSlashes.ok).toBe(true);

    const withApiSlash = await adapter(`${baseUrl}/api/`).createServiceAccount({
      ...CREATE_INPUT,
      username: "zed_1001_apislash",
    });
    expect(withApiSlash.ok).toBe(true);
  });

  it("17. tolerates RickPanelAPI-style extra response fields (same documented contract)", async () => {
    // userJson() always includes extra vendor fields + token_type in auth -
    // this test pins that the adapter ignores unknown keys end to end.
    addTemplate("tpl", { vless: {} });
    const created = await adapter().createServiceAccount({ ...CREATE_INPUT });
    expect(created.ok).toBe(true);
    const read = await adapter().getServiceAccount({ username: CREATE_INPUT.username });
    expect(read.ok).toBe(true);
    expect(read.totalBytes).toBe(10n * GIB);
    expect(read.expiresAt?.getTime()).toBe(
      Math.floor(CREATE_INPUT.expiresAt.getTime() / 1000) * 1000,
    );
  });
});

describe("Marzban readiness (authenticated connection test)", () => {
  it("reports every step and is ready only with a valid configuration", async () => {
    addTemplate("tpl", { vless: {} });
    const ready = await adapter().checkProvisioningReadiness({ templateUsername: "tpl" });
    expect(ready.ready).toBe(true);
    expect(ready.checks.find((c) => c.key === "auth")?.ok).toBe(true);
    expect(ready.checks.find((c) => c.key === "read-endpoint")?.ok).toBe(true);
    expect(ready.checks.find((c) => c.key === "template")?.ok).toBe(true);
    expect(ready.capabilities).toContain("createService");
    expect(ready.capabilities).toContain("renewService");
  });

  it("login success alone is NOT readiness (no template, no explicit config)", async () => {
    const result = await adapter().checkProvisioningReadiness({});
    expect(result.checks.find((c) => c.key === "auth")?.ok).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.diagnostic?.code).toBe("config-incomplete");
  });

  it("flags a missing template while auth and read access pass", async () => {
    const result = await adapter().checkProvisioningReadiness({ templateUsername: "ghost" });
    expect(result.ready).toBe(false);
    expect(result.checks.find((c) => c.key === "auth")?.ok).toBe(true);
    expect(result.checks.find((c) => c.key === "template")?.ok).toBe(false);
    expect(result.diagnostic?.code).toBe("template-not-found");
  });

  it("flags wrong credentials as auth failure", async () => {
    mock.wrongCredentials = true;
    const result = await adapter().checkProvisioningReadiness({ templateUsername: "tpl" });
    expect(result.ready).toBe(false);
    expect(result.checks.find((c) => c.key === "auth")?.ok).toBe(false);
    expect(result.diagnostic?.code).toBe("auth-failed");
  });
});
