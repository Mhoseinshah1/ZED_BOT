import http from "node:http";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Short panel HTTP timeout so the timeout tests finish quickly. Must be set
// before the adapters module is imported.
process.env.PANEL_HTTP_TIMEOUT_MS = "700";

import { XuiAdapter, XuiClient, type XuiCredentials } from "@zedbot/panel-adapters";

// =============================================================================
// XUI API_TOKEN authentication mode against a mock server reproducing a
// token-authenticated SANAEI-compatible deployment:
//   - the same /panel/api/inbounds routes as stock 3x-ui
//   - every API request requires `Authorization: Bearer <token>`
//   - requests without a valid token are redirected to the login page
//     (302) or rejected with 401, exactly like real deployments
//   - /login still exists (for humans) - the token client must NEVER call it
// The SESSION_COOKIE mode must stay fully functional and remain the default
// when no authMode is configured.
// =============================================================================

const API_TOKEN = "staging-api-token-secret-xyz";
const XUI_USER = "xadmin";
const XUI_PASS = "xui-secret-pass";
const SESSION = "mock-session-cookie-value";
const GIB = 1024n * 1024n * 1024n;

interface MockClient {
  id?: string;
  password?: string;
  email: string;
  totalGB: number;
  expiryTime: number;
  enable: boolean;
  subId?: string;
  flow?: string;
}

const mock = {
  clients: [] as MockClient[], // single inbound id=1 (vless)
  loginCalls: 0,
  apiCalls: 0,
  lastAuthHeader: null as string | null,
  /** Reject the bearer token with this status (401) instead of accepting it. */
  rejectTokenWith: null as number | null,
  /** Redirect unauthenticated/invalid requests instead of 401. */
  redirectOnAuthFailure: false,
  hangList: false,
};

function resetMock(): void {
  mock.clients = [];
  mock.loginCalls = 0;
  mock.apiCalls = 0;
  mock.lastAuthHeader = null;
  mock.rejectTokenWith = null;
  mock.redirectOnAuthFailure = false;
  mock.hangList = false;
}

let server: http.Server;
let host = "";
const hanging: http.ServerResponse[] = [];

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";

      if (req.method === "POST" && url === "/login") {
        mock.loginCalls += 1;
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          const params = new URLSearchParams(body);
          if (params.get("username") !== XUI_USER || params.get("password") !== XUI_PASS) {
            json(res, 200, { success: false, msg: "Invalid username or password" });
            return;
          }
          json(
            res,
            200,
            { success: true, msg: "Login Successfully" },
            { "Set-Cookie": `3x-ui=${SESSION}; Path=/; HttpOnly` },
          );
        });
        return;
      }

      // API area: valid bearer token OR valid session cookie authenticates.
      mock.apiCalls += 1;
      mock.lastAuthHeader = req.headers.authorization ?? null;
      const bearerOk =
        mock.rejectTokenWith === null && req.headers.authorization === `Bearer ${API_TOKEN}`;
      const cookieOk = (req.headers.cookie ?? "") === `3x-ui=${SESSION}`;
      if (!bearerOk && !cookieOk) {
        if (mock.redirectOnAuthFailure) {
          res.writeHead(302, { Location: "/" });
          res.end();
          return;
        }
        json(res, mock.rejectTokenWith ?? 401, { success: false, msg: "Unauthorized" });
        return;
      }

      if (req.method === "GET" && url === "/panel/api/inbounds/list") {
        if (mock.hangList) {
          hanging.push(res);
          return;
        }
        json(res, 200, {
          success: true,
          obj: [
            {
              id: 1,
              enable: true,
              protocol: "vless",
              remark: "token-mode",
              port: 443,
              settings: JSON.stringify({ clients: mock.clients }),
              clientStats: mock.clients.map((c, i) => ({
                id: i + 1,
                inboundId: 1,
                email: c.email,
                up: 100,
                down: 200,
                total: c.totalGB,
                expiryTime: c.expiryTime,
                enable: true,
              })),
            },
          ],
        });
        return;
      }
      if (req.method === "POST" && url === "/panel/api/inbounds/addClient") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          const payload = JSON.parse(body) as { id: number; settings: string };
          const client = (JSON.parse(payload.settings) as { clients: MockClient[] }).clients[0];
          if (mock.clients.some((c) => c.email === client.email)) {
            json(res, 200, { success: false, msg: "Duplicate email" });
            return;
          }
          mock.clients.push(client);
          json(res, 200, { success: true, msg: "Client added" });
        });
        return;
      }
      const delMatch = /^\/panel\/api\/inbounds\/1\/delClient\/([^/]+)$/.exec(url);
      if (req.method === "POST" && delMatch !== null) {
        const clientId = decodeURIComponent(delMatch[1]);
        mock.clients = mock.clients.filter((c) => c.id !== clientId && c.password !== clientId);
        json(res, 200, { success: true, msg: "" });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<html>not found</html>");
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(() => {
  for (const res of hanging) {
    res.destroy();
  }
  server.close();
});

afterEach(() => {
  resetMock();
});

function tokenAdapter(overrides: Partial<XuiCredentials> = {}): XuiAdapter {
  return new XuiAdapter(
    new XuiClient({
      baseUrl: host,
      authMode: "API_TOKEN",
      token: API_TOKEN,
      apiVariant: "SANAEI",
      ...overrides,
    }),
  );
}

function cookieAdapter(): XuiAdapter {
  // No authMode: SESSION_COOKIE must be the default (backward compatible).
  return new XuiAdapter(
    new XuiClient({ baseUrl: host, username: XUI_USER, password: XUI_PASS }),
  );
}

const USERNAME = "zed_1001_tokmode1";

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    username: USERNAME,
    note: "zedbot order:tokmode1 tg:1001",
    volumeBytes: 5n * GIB,
    durationDays: 30,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    templateUsername: null,
    dataLimitResetStrategy: null,
    subscriptionBaseUrl: null,
    inboundIds: [1],
    protocolSettings: null,
    trafficResetCycle: null,
    ...overrides,
  };
}

describe("XUI API_TOKEN authentication mode", () => {
  it("authenticates with a bearer token and NEVER calls /login", async () => {
    const created = await tokenAdapter().createServiceAccount(createInput());
    expect(created.ok).toBe(true);
    expect(mock.loginCalls).toBe(0);
    expect(mock.lastAuthHeader).toBe(`Bearer ${API_TOKEN}`);
    expect(mock.clients).toHaveLength(1);
    expect(mock.clients[0].email).toBe(`${USERNAME}-1`);
  });

  it("testConnection is a REAL authenticated check, not reachability", async () => {
    const ok = await tokenAdapter().testConnection();
    expect(ok.ok).toBe(true);
    expect(mock.loginCalls).toBe(0);

    // The panel is perfectly reachable but the token is rejected: the test
    // must fail - a reachable login page is not authentication.
    mock.rejectTokenWith = 401;
    const rejected = await tokenAdapter().testConnection();
    expect(rejected.ok).toBe(false);
  });

  it("reports a rejected token (401) as a definite auth failure", async () => {
    mock.rejectTokenWith = 401;
    const result = await tokenAdapter().createServiceAccount(createInput());
    expect(result.ok).toBe(false);
    expect(result.uncertain).toBeUndefined();
    expect(result.diagnostic?.code).toBe("auth-failed");
    expect(mock.clients).toHaveLength(0);
    // The token never leaks into results/diagnostics.
    expect(JSON.stringify(result)).not.toContain(API_TOKEN);
  });

  it("reports a login-page redirect as auth failure (token not accepted)", async () => {
    mock.rejectTokenWith = 401;
    mock.redirectOnAuthFailure = true;
    const result = await tokenAdapter().createServiceAccount(createInput());
    expect(result.ok).toBe(false);
    expect(result.diagnostic?.code).toBe("auth-failed");
  });

  it("missing token is a config error without any network request", async () => {
    const result = await tokenAdapter({ token: undefined }).createServiceAccount(createInput());
    expect(result.ok).toBe(false);
    expect(result.diagnostic?.code).toBe("config-incomplete");
    expect(mock.apiCalls).toBe(0);
    expect(mock.loginCalls).toBe(0);
  });

  it("readiness reports reachable/auth/read-endpoint from the authenticated read", async () => {
    const ready = await tokenAdapter().checkProvisioningReadiness({ inboundIds: [1] });
    expect(ready.ready).toBe(true);
    expect(ready.checks.find((c) => c.key === "reachable")?.ok).toBe(true);
    expect(ready.checks.find((c) => c.key === "auth")?.ok).toBe(true);
    expect(ready.checks.find((c) => c.key === "read-endpoint")?.ok).toBe(true);
    expect(mock.loginCalls).toBe(0);

    mock.rejectTokenWith = 401;
    const rejected = await tokenAdapter().checkProvisioningReadiness({ inboundIds: [1] });
    expect(rejected.ready).toBe(false);
    expect(rejected.checks.find((c) => c.key === "reachable")?.ok).toBe(true);
    expect(rejected.checks.find((c) => c.key === "auth")?.ok).toBe(false);
    expect(rejected.diagnostic?.code).toBe("auth-failed");

    const dead = new XuiAdapter(
      new XuiClient({ baseUrl: "http://127.0.0.1:1", authMode: "API_TOKEN", token: API_TOKEN }),
    );
    const unreachable = await dead.checkProvisioningReadiness({ inboundIds: [1] });
    expect(unreachable.ready).toBe(false);
    expect(unreachable.checks.find((c) => c.key === "reachable")?.ok).toBe(false);
  });

  it("timeouts surface structurally in token mode", async () => {
    mock.hangList = true;
    const result = await tokenAdapter().getServiceAccount({ username: USERNAME });
    expect(result.ok).toBe(false);
    expect(result.notFound).toBeUndefined();
    expect(result.diagnostic?.code).toBe("timeout");
  });

  it("supports reads/reconciliation with positive absence in token mode", async () => {
    const created = await tokenAdapter().createServiceAccount(createInput());
    expect(created.ok).toBe(true);

    const read = await tokenAdapter().getServiceAccount({ username: USERNAME });
    expect(read.ok).toBe(true);
    expect(read.totalBytes).toBe(5n * GIB);
    expect(read.usedBytes).toBe(300n);
    expect(read.subscriptionToken).toBe(USERNAME);

    const absent = await tokenAdapter().getServiceAccount({ username: "zed_9999_ghost001" });
    expect(absent.ok).toBe(false);
    expect(absent.notFound).toBe(true);
  });

  it("retries stay idempotent in token mode", async () => {
    const first = await tokenAdapter().createServiceAccount(createInput());
    const retry = await tokenAdapter().createServiceAccount(createInput());
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(retry.remoteClientId).toBe(first.remoteClientId);
    expect(mock.clients).toHaveLength(1);
  });

  it("SESSION_COOKIE stays the default and fully functional", async () => {
    // No authMode configured -> the login flow runs exactly as before.
    const created = await cookieAdapter().createServiceAccount(
      createInput({ username: "zed_1001_cookie01" }),
    );
    expect(created.ok).toBe(true);
    expect(mock.loginCalls).toBe(1);
    expect(mock.clients.some((c) => c.email === "zed_1001_cookie01-1")).toBe(true);

    // Cookie mode with missing credentials is a config error, no network.
    const noCreds = new XuiAdapter(new XuiClient({ baseUrl: host }));
    const apiCallsBefore = mock.apiCalls;
    const loginCallsBefore = mock.loginCalls;
    const result = await noCreds.createServiceAccount(createInput({ username: "zed_1001_nocred01" }));
    expect(result.ok).toBe(false);
    expect(result.diagnostic?.code).toBe("config-incomplete");
    expect(mock.apiCalls).toBe(apiCallsBefore);
    expect(mock.loginCalls).toBe(loginCallsBefore);
  });
});
