import { randomUUID } from "node:crypto";
import http from "node:http";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Short panel HTTP timeout so the timeout tests finish quickly. Must be set
// before the adapters module is imported.
process.env.PANEL_HTTP_TIMEOUT_MS = "700";

import { XuiAdapter, XuiClient } from "@zedbot/panel-adapters";

// =============================================================================
// XUI / Sanaei 3X-UI adapter against a mock HTTP server reproducing the
// GLOBAL client API contract pinned at MHSanaei/3x-ui commit
// 4e928a1ce0945a6e956aa63365034ec24d2b1387:
//
//   POST {base}/login                          form-encoded; HTTP 200 with
//                                              {"success":false} on bad creds
//   GET  {base}/panel/api/inbounds/list        inbound inventory
//   GET  {base}/panel/api/clients/list         [{...client, inboundIds, traffic}]
//   GET  {base}/panel/api/clients/get/{email}  {client, inboundIds, usedTraffic}
//   POST {base}/panel/api/clients/add          {client, inboundIds}; secrets
//                                              generated server-side; duplicate
//                                              email+same subId = idempotent
//                                              reuse; foreign subId = error
//   POST {base}/panel/api/clients/del/{email}  removes ALL attachments+traffic
//   GET  {base}/panel/api/clients/links/{email} panel-built config URLs
//
// The legacy per-inbound endpoints (POST /panel/api/inbounds/addClient,
// .../delClient/...) were REMOVED upstream - this mock answers them with 404
// exactly like the real panel, proving the adapter never calls them.
// =============================================================================

const XUI_USER = "xadmin";
const XUI_PASS = "xui-secret-pass";
const SESSION = "mock-3xui-session-value-123";
const GIB = 1024n * 1024n * 1024n;

interface MockInbound {
  id: number;
  enable: boolean;
  protocol: string;
  remark: string;
  port: number;
}

interface MockClientRow {
  email: string;
  subId: string;
  uuid?: string;
  password?: string;
  totalGB: number;
  expiryTime: number;
  enable: boolean;
  comment?: string;
  flow?: string;
  reset: number;
}

const mock = {
  basePath: "" as string,
  inbounds: [] as MockInbound[],
  clients: [] as MockClientRow[],
  attachments: new Map<string, Set<number>>(), // email -> inbound ids
  traffic: new Map<string, { up: number; down: number }>(),
  wrongCredentials: false,
  /** Simulate a pre-global-client panel: clients endpoints answer 404 HTML. */
  noClientsApi: false,
  addCalls: [] as Array<{ client: Record<string, unknown>; inboundIds: number[] }>,
  /** Fail the server-side attach loop AT this inbound (earlier ones persist). */
  failAttachAtInbound: null as number | null,
  hangAdd: false,
  delFail: false,
  linksFail: false,
  listClientsNonJson: false,
  legacyEndpointCalls: 0,
};

function resetMock(): void {
  mock.basePath = "";
  mock.inbounds = [];
  mock.clients = [];
  mock.attachments = new Map();
  mock.traffic = new Map();
  mock.wrongCredentials = false;
  mock.noClientsApi = false;
  mock.addCalls = [];
  mock.failAttachAtInbound = null;
  mock.hangAdd = false;
  mock.delFail = false;
  mock.linksFail = false;
  mock.listClientsNonJson = false;
  mock.legacyEndpointCalls = 0;
}

function addInbound(partial: Partial<MockInbound> & { id: number }): MockInbound {
  const inbound: MockInbound = {
    enable: true,
    protocol: "vless",
    remark: `inbound-${partial.id}`,
    port: 10000 + partial.id,
    ...partial,
  };
  mock.inbounds.push(inbound);
  return inbound;
}

function clientJson(row: MockClientRow): Record<string, unknown> {
  const t = mock.traffic.get(row.email);
  return {
    id: mock.clients.indexOf(row) + 1,
    email: row.email,
    subId: row.subId,
    uuid: row.uuid ?? "",
    password: row.password ?? "",
    auth: "",
    flow: row.flow ?? "",
    totalGB: row.totalGB,
    expiryTime: row.expiryTime,
    enable: row.enable,
    comment: row.comment ?? "",
    reset: row.reset,
    inboundIds: [...(mock.attachments.get(row.email) ?? [])].sort((a, b) => a - b),
    traffic:
      t === undefined
        ? null
        : {
            email: row.email,
            up: t.up,
            down: t.down,
            total: row.totalGB,
            expiryTime: row.expiryTime,
            enable: row.enable,
            lastOnline: 0,
          },
  };
}

let server: http.Server;
let host = "";
const hanging: http.ServerResponse[] = [];

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

function html404(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/html" });
  res.end("<html>not found</html>");
}

/** Server-side add semantics per the pinned upstream client_crud.go. */
function handleAdd(res: http.ServerResponse, payload: { client: Record<string, unknown>; inboundIds: number[] }): void {
  mock.addCalls.push(payload);
  const c = payload.client;
  const email = typeof c["email"] === "string" ? (c["email"] as string) : "";
  if (email === "") {
    json(res, 200, { success: false, msg: "client email is required" });
    return;
  }
  if (!Array.isArray(payload.inboundIds) || payload.inboundIds.length === 0) {
    json(res, 200, { success: false, msg: "at least one inbound is required" });
    return;
  }
  let subId = typeof c["subId"] === "string" ? (c["subId"] as string) : "";
  if (subId === "") {
    subId = randomUUID();
  }
  let row = mock.clients.find((r) => r.email === email);
  if (row !== undefined) {
    if (row.subId !== subId) {
      json(res, 200, { success: false, msg: `email already in use: ${email}` });
      return;
    }
    // Idempotent re-add: stored credentials are reused.
  } else {
    if (mock.clients.some((r) => r.subId === subId && r.email !== email)) {
      json(res, 200, { success: false, msg: `subId already in use: ${subId}` });
      return;
    }
    row = {
      email,
      subId,
      totalGB: typeof c["totalGB"] === "number" ? (c["totalGB"] as number) : 0,
      expiryTime: typeof c["expiryTime"] === "number" ? (c["expiryTime"] as number) : 0,
      enable: c["enable"] !== false,
      comment: typeof c["comment"] === "string" ? (c["comment"] as string) : undefined,
      flow: typeof c["flow"] === "string" ? (c["flow"] as string) : undefined,
      reset: typeof c["reset"] === "number" ? (c["reset"] as number) : 0,
      // Caller-provided secrets would be honored, but the adapter omits
      // them - fillProtocolDefaults generates per attached protocol below.
      ...(typeof c["id"] === "string" ? { uuid: c["id"] as string } : {}),
      ...(typeof c["password"] === "string" ? { password: c["password"] as string } : {}),
    };
    mock.clients.push(row);
  }
  // Attach loop with per-protocol secret defaults (fillProtocolDefaults).
  for (const ibId of payload.inboundIds) {
    if (mock.failAttachAtInbound === ibId) {
      json(res, 200, { success: false, msg: `attach failed on inbound ${ibId}` });
      return;
    }
    const inbound = mock.inbounds.find((i) => i.id === ibId);
    if (inbound === undefined) {
      json(res, 200, { success: false, msg: `inbound ${ibId} not found` });
      return;
    }
    if (inbound.protocol === "vless" || inbound.protocol === "vmess") {
      row.uuid = row.uuid ?? randomUUID();
    } else if (inbound.protocol === "trojan") {
      row.password = row.password ?? randomUUID().replaceAll("-", "");
    }
    const set = mock.attachments.get(email) ?? new Set<number>();
    set.add(ibId); // dedupe: re-adding is a no-op
    mock.attachments.set(email, set);
    if (!mock.traffic.has(email)) {
      mock.traffic.set(email, { up: 0, down: 0 });
    }
  }
  json(res, 200, { success: true, msg: "Client added" });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      const bp = mock.basePath;
      if (bp !== "" && !url.startsWith(`${bp}/`)) {
        html404(res);
        return;
      }
      const path = bp === "" ? url : url.slice(bp.length);

      if (req.method === "POST" && path === "/login") {
        const params = new URLSearchParams(await readBody(req));
        if (
          mock.wrongCredentials ||
          params.get("username") !== XUI_USER ||
          params.get("password") !== XUI_PASS
        ) {
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

      if ((req.headers.cookie ?? "") !== `3x-ui=${SESSION}`) {
        res.writeHead(302, { Location: `${bp}/` });
        res.end();
        return;
      }

      if (req.method === "GET" && path === "/panel/api/inbounds/list") {
        json(res, 200, { success: true, msg: "", obj: mock.inbounds });
        return;
      }

      // Legacy per-inbound client endpoints: REMOVED upstream -> 404.
      if (path.startsWith("/panel/api/inbounds/addClient") || /\/delClient\//.test(path)) {
        mock.legacyEndpointCalls += 1;
        html404(res);
        return;
      }

      if (path.startsWith("/panel/api/clients/") && mock.noClientsApi) {
        html404(res);
        return;
      }

      if (req.method === "GET" && path === "/panel/api/clients/list") {
        if (mock.listClientsNonJson) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html>old panel page</html>");
          return;
        }
        json(res, 200, { success: true, msg: "", obj: mock.clients.map(clientJson) });
        return;
      }

      const getMatch = /^\/panel\/api\/clients\/get\/([^/]+)$/.exec(path);
      if (req.method === "GET" && getMatch !== null) {
        const email = decodeURIComponent(getMatch[1]);
        const row = mock.clients.find((r) => r.email === email);
        if (row === undefined) {
          json(res, 200, { success: false, msg: "record not found" });
          return;
        }
        const t = mock.traffic.get(email);
        json(res, 200, {
          success: true,
          msg: "",
          obj: {
            client: clientJson(row),
            inboundIds: [...(mock.attachments.get(email) ?? [])].sort((a, b) => a - b),
            usedTraffic: (t?.up ?? 0) + (t?.down ?? 0),
          },
        });
        return;
      }

      if (req.method === "POST" && path === "/panel/api/clients/add") {
        if (mock.hangAdd) {
          hanging.push(res);
          return;
        }
        const payload = JSON.parse(await readBody(req)) as {
          client: Record<string, unknown>;
          inboundIds: number[];
        };
        handleAdd(res, payload);
        return;
      }

      const delMatch = /^\/panel\/api\/clients\/del\/([^/]+)$/.exec(path);
      if (req.method === "POST" && delMatch !== null) {
        if (mock.delFail) {
          json(res, 200, { success: false, msg: "Error deleting client" });
          return;
        }
        const email = decodeURIComponent(delMatch[1]);
        const before = mock.clients.length;
        mock.clients = mock.clients.filter((r) => r.email !== email);
        mock.attachments.delete(email);
        mock.traffic.delete(email);
        json(res, 200, { success: before !== mock.clients.length, msg: "" });
        return;
      }

      const linksMatch = /^\/panel\/api\/clients\/links\/([^/]+)$/.exec(path);
      if (req.method === "GET" && linksMatch !== null) {
        if (mock.linksFail) {
          json(res, 200, { success: false, msg: "obtain failed" });
          return;
        }
        const email = decodeURIComponent(linksMatch[1]);
        const row = mock.clients.find((r) => r.email === email);
        const ids = [...(mock.attachments.get(email) ?? [])];
        const urls = ids.map((id) => {
          const inbound = mock.inbounds.find((i) => i.id === id);
          const secret = row?.uuid !== undefined && row.uuid !== "" ? row.uuid : (row?.password ?? "");
          return `${inbound?.protocol ?? "vless"}://${secret}@panel.example:${inbound?.port ?? 0}#${email}`;
        });
        json(res, 200, { success: true, msg: "", obj: urls });
        return;
      }

      html404(res);
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

describe("XUI provisioning (global client API contract)", () => {
  it("1. logs in with form credentials and creates ONE global client", async () => {
    addInbound({ id: 1 });
    const health = await adapter().testConnection();
    expect(health.ok).toBe(true);

    const result = await adapter().createServiceAccount(createInput());
    expect(result.ok).toBe(true);
    // ONE client, email = the deterministic username with NO inbound suffix.
    expect(mock.clients).toHaveLength(1);
    expect(mock.clients[0].email).toBe(USERNAME);
    expect(mock.legacyEndpointCalls).toBe(0); // removed endpoints never called
  });

  it("2. reports invalid credentials (HTTP 200 + success:false) as auth failure", async () => {
    mock.wrongCredentials = true;
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
    expect(mock.clients[0].email).toBe(USERNAME);

    const wrong = await adapter({ base: `${host}/wrongpath` }).createServiceAccount(
      createInput({ username: "zed_1001_wrongbp1" }),
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.diagnostic?.code).toBe("unsupported-variant");
  });

  it("4. readiness validates the global client API and configured inbounds", async () => {
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
    expect(mock.addCalls).toHaveLength(0); // validated BEFORE any mutation
  });

  it("6. refuses unsupported protocols and disabled inbounds", async () => {
    addInbound({ id: 1, protocol: "shadowsocks" });
    const result = await adapter().createServiceAccount(createInput());
    expect(result.ok).toBe(false);
    expect(result.diagnostic?.code).toBe("unsupported-protocol");
    expect(mock.addCalls).toHaveLength(0);

    resetMock();
    addInbound({ id: 1, enable: false });
    const disabled = await adapter().createServiceAccount(createInput());
    expect(disabled.ok).toBe(false);
    expect(disabled.diagnostic?.code).toBe("inbound-disabled");
  });

  it("7. detects pre-global-client panel versions as unsupported", async () => {
    addInbound({ id: 1 });
    mock.noClientsApi = true; // clients endpoints 404 like an old panel
    const ready = await adapter().checkProvisioningReadiness({ inboundIds: [1] });
    expect(ready.ready).toBe(false);
    expect(ready.checks.find((c) => c.key === "read-endpoint")?.ok).toBe(false);
    expect(ready.diagnostic?.code).toBe("unsupported-variant");

    const create = await adapter().createServiceAccount(createInput());
    expect(create.ok).toBe(false);
    expect(create.uncertain).toBeUndefined();
    expect(create.diagnostic?.code).toBe("unsupported-variant");
  });

  it("8. creates a VLESS client with universal fields only (server-side secrets)", async () => {
    addInbound({ id: 1, protocol: "vless" });
    const result = await adapter().createServiceAccount(createInput());
    expect(result.ok).toBe(true);
    expect(result.username).toBe(USERNAME);
    expect(result.subscriptionToken).toBe(USERNAME);
    expect(result.remoteInboundIds).toEqual([1]);

    // The payload carried ONLY universal fields - no client-side secrets,
    // and no tgId (an int64 upstream; a string would be rejected).
    const sent = mock.addCalls[0].client;
    expect(sent["id"]).toBeUndefined();
    expect(sent["password"]).toBeUndefined();
    expect(sent["tgId"]).toBeUndefined();
    expect(sent["flow"]).toBeUndefined(); // never guessed
    expect(sent["email"]).toBe(USERNAME);
    expect(sent["subId"]).toBe(USERNAME);
    expect(sent["totalGB"]).toBe(Number(10n * GIB)); // bytes despite the name
    expect(sent["expiryTime"]).toBe(new Date("2027-01-01T00:00:00Z").getTime());
    expect(sent["enable"]).toBe(true);
    expect(sent["comment"]).toBe("zedbot order:abcd1234 tg:1001");

    // The server generated the UUID; the read-back returned it.
    expect(mock.clients[0].uuid).toMatch(UUID_RE);
    expect(result.remoteClientId).toBe(mock.clients[0].uuid);

    // Explicitly configured flow is passed through.
    resetMock();
    addInbound({ id: 1, protocol: "vless" });
    const flowed = await adapter().createServiceAccount(
      createInput({ username: "zed_1001_flowed01", protocolSettings: { flow: "xtls-rprx-vision" } }),
    );
    expect(flowed.ok).toBe(true);
    expect(mock.addCalls[0].client["flow"]).toBe("xtls-rprx-vision");
  });

  it("9. creates a VMess client (server-generated uuid)", async () => {
    addInbound({ id: 1, protocol: "vmess" });
    const result = await adapter().createServiceAccount(createInput());
    expect(result.ok).toBe(true);
    expect(mock.clients[0].uuid).toMatch(UUID_RE);
    expect(mock.clients[0].password).toBeUndefined();
    expect(result.remoteClientId).toBe(mock.clients[0].uuid);
  });

  it("10. creates a Trojan client (server-generated password)", async () => {
    addInbound({ id: 1, protocol: "trojan" });
    const result = await adapter().createServiceAccount(createInput());
    expect(result.ok).toBe(true);
    expect(mock.clients[0].uuid).toBeUndefined();
    expect(mock.clients[0].password).toMatch(/^[0-9a-f]{32}$/);
    expect(result.remoteClientId).toBe(mock.clients[0].password);
  });

  it("11. never sends or copies client secrets; identities stay unique", async () => {
    addInbound({ id: 1, protocol: "vless" });
    mock.clients.push({
      email: "someone-else",
      subId: "someoneelse",
      uuid: "11111111-1111-4111-8111-111111111111",
      totalGB: 0,
      expiryTime: 0,
      enable: true,
      reset: 0,
    });
    mock.attachments.set("someone-else", new Set([1]));

    const first = await adapter().createServiceAccount(createInput());
    const second = await adapter().createServiceAccount(createInput({ username: "zed_1002_other001" }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    for (const call of mock.addCalls) {
      expect(call.client["id"]).toBeUndefined();
      expect(call.client["password"]).toBeUndefined();
    }
    const uuids = mock.clients.map((c) => c.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
    expect(first.remoteClientId).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(first.remoteClientId).not.toBe(second.remoteClientId);
  });

  it("12. duplicate retry is idempotent; a foreign subId is a conflict", async () => {
    addInbound({ id: 1, protocol: "vless" });
    const first = await adapter().createServiceAccount(createInput());
    expect(first.ok).toBe(true);

    // Retry: the server reuses stored credentials + dedupes attachments.
    const retry = await adapter().createServiceAccount(createInput());
    expect(retry.ok).toBe(true);
    expect(retry.remoteClientId).toBe(first.remoteClientId);
    expect(mock.clients).toHaveLength(1);
    expect([...(mock.attachments.get(USERNAME) ?? [])]).toEqual([1]);

    // Same email, foreign subId: pre-check reports a conflict, no mutation.
    mock.clients[0].subId = "foreign-sub-id";
    const addsBefore = mock.addCalls.length;
    const conflict = await adapter().createServiceAccount(createInput());
    expect(conflict.ok).toBe(false);
    expect(conflict.uncertain).toBeUndefined();
    expect(conflict.diagnostic?.code).toBe("conflict");
    expect(mock.addCalls.length).toBe(addsBefore);
  });

  it("13. multi-inbound = ONE client attached to every configured inbound", async () => {
    addInbound({ id: 1, protocol: "vless" });
    addInbound({ id: 2, protocol: "trojan" });
    const result = await adapter().createServiceAccount(createInput({ inboundIds: [1, 2] }));
    expect(result.ok).toBe(true);
    // One global client - NOT one client per inbound.
    expect(mock.clients).toHaveLength(1);
    expect(mock.clients[0].email).toBe(USERNAME);
    expect(mock.clients[0].subId).toBe(USERNAME);
    expect([...(mock.attachments.get(USERNAME) ?? [])].sort()).toEqual([1, 2]);
    // One shared traffic record; both protocol secrets on the same row.
    expect(mock.traffic.size).toBe(1);
    expect(mock.clients[0].uuid).toMatch(UUID_RE);
    expect(mock.clients[0].password).toMatch(/^[0-9a-f]{32}$/);
    expect(result.remoteInboundIds).toEqual([1, 2]);
    const metadata = result.remoteMetadata as { subId: string; email: string; inboundIds: number[] };
    expect(metadata.email).toBe(USERNAME);
    expect(metadata.inboundIds).toEqual([1, 2]);
  });

  it("14. partial attach failure triggers ONE confirmed compensating delete", async () => {
    addInbound({ id: 1, protocol: "vless" });
    addInbound({ id: 2, protocol: "vless" });
    mock.failAttachAtInbound = 2; // inbound 1 attaches, then the server errors
    const result = await adapter().createServiceAccount(createInput({ inboundIds: [1, 2] }));
    expect(result.ok).toBe(false);
    // Cleanup (del/{email}) confirmed via re-read -> DEFINITE failure.
    expect(result.uncertain).toBeUndefined();
    expect(mock.clients).toHaveLength(0); // the whole client is gone
    expect(mock.attachments.size).toBe(0);
    expect(mock.traffic.size).toBe(0);
  });

  it("15. unconfirmable cleanup and in-flight timeouts return UNKNOWN", async () => {
    addInbound({ id: 1, protocol: "vless" });
    addInbound({ id: 2, protocol: "vless" });
    mock.failAttachAtInbound = 2;
    mock.delFail = true; // deletion fails -> re-read still shows the client
    const result = await adapter().createServiceAccount(createInput({ inboundIds: [1, 2] }));
    expect(result.ok).toBe(false);
    expect(result.uncertain).toBe(true);
    expect(result.diagnostic?.code).toBe("partial-state");
    expect(result.diagnostic?.certainty).toBe("unknown");
    expect(mock.clients).toHaveLength(1); // orphan remains (documented)

    // A TIMED-OUT add is UNKNOWN even when the re-read looks clean: the
    // hung request may land after the verification read.
    resetMock();
    addInbound({ id: 1, protocol: "vless" });
    mock.hangAdd = true;
    const inflight = await adapter().createServiceAccount(createInput({ username: "zed_1001_inflight" }));
    expect(inflight.ok).toBe(false);
    expect(inflight.uncertain).toBe(true);
    expect(inflight.diagnostic?.certainty).toBe("unknown");
  });

  it("16. subscription URL only from explicit config; config links from the panel", async () => {
    addInbound({ id: 1 });
    const bare = await adapter().createServiceAccount(createInput());
    expect(bare.ok).toBe(true);
    expect(bare.subscriptionUrl).toBeUndefined(); // never fabricated
    // Real panel-built config links (links/{email}).
    expect(bare.configLinks).toBeDefined();
    expect(bare.configLinks?.[0]).toContain(`#${USERNAME}`);

    resetMock();
    addInbound({ id: 1 });
    const withBase = await adapter().createServiceAccount(
      createInput({ subscriptionBaseUrl: "https://sub.example.com:2096/sub" }),
    );
    expect(withBase.subscriptionUrl).toBe(`https://sub.example.com:2096/sub/${USERNAME}`);

    // A failing links endpoint never fails the (already created) service.
    resetMock();
    addInbound({ id: 1 });
    mock.linksFail = true;
    const noLinks = await adapter().createServiceAccount(createInput({ username: "zed_1001_nolinks1" }));
    expect(noLinks.ok).toBe(true);
    expect(noLinks.configLinks).toBeUndefined();
  });

  it("17. readiness requires auth + clients API + valid configured inbounds", async () => {
    addInbound({ id: 1 });
    const noIds = await adapter().checkProvisioningReadiness({ inboundIds: [] });
    expect(noIds.ready).toBe(false);
    expect(noIds.diagnostic?.code).toBe("config-incomplete");
    expect(noIds.checks.find((c) => c.key === "auth")?.ok).toBe(true);

    const missing = await adapter().checkProvisioningReadiness({ inboundIds: [7] });
    expect(missing.ready).toBe(false);
    expect(missing.diagnostic?.code).toBe("inbound-missing");

    const ok = await adapter().checkProvisioningReadiness({ inboundIds: [1] });
    expect(ok.ready).toBe(true);
    expect(ok.capabilities).toContain("createService");
    expect(ok.capabilities).toContain("readService");
    // Lifecycle capabilities are real now (update/resetTraffic implemented
    // + contract-tested); deleteService stays honestly absent.
    expect(ok.capabilities).toContain("renewService");
    expect(ok.capabilities).toContain("addVolume");
    expect(ok.capabilities).toContain("addTime");
    expect(ok.capabilities).toContain("toggleService");
    expect(ok.capabilities).toContain("regenerateSubscription");
    expect(ok.capabilities).not.toContain("deleteService"); // honest capabilities
  });

  it("18. handles timeouts and non-JSON responses structurally", async () => {
    const dead = new XuiAdapter(
      new XuiClient({ baseUrl: "http://127.0.0.1:1", username: XUI_USER, password: XUI_PASS }),
    );
    const unreachable = await dead.createServiceAccount(createInput());
    expect(unreachable.ok).toBe(false);
    expect(unreachable.uncertain).toBeUndefined(); // login is pre-mutation
    expect(["timeout", "unreachable"]).toContain(unreachable.diagnostic?.code);

    addInbound({ id: 1 });
    mock.listClientsNonJson = true;
    const nonJson = await adapter().createServiceAccount(createInput());
    expect(nonJson.ok).toBe(false);
    expect(nonJson.diagnostic?.code).toBe("unsupported-variant");
    expect(nonJson.errorMessage).not.toContain("<html>");
  });

  it("19. never leaks credentials, cookies or client secrets in results", async () => {
    addInbound({ id: 1, protocol: "trojan" });
    mock.failAttachAtInbound = 1;
    const failed = await adapter().createServiceAccount(createInput());
    const dump = JSON.stringify({ ...failed, remoteClientId: undefined });
    expect(dump).not.toContain(XUI_PASS);
    expect(dump).not.toContain(SESSION);

    mock.wrongCredentials = true;
    const auth = await adapter().createServiceAccount(createInput({ username: "zed_1001_leak0001" }));
    expect(JSON.stringify(auth.diagnostic)).not.toContain(XUI_PASS);
  });

  it("20. reconciliation reads the global inventory with positive absence", async () => {
    addInbound({ id: 1, protocol: "vless" });
    addInbound({ id: 2, protocol: "trojan" });
    const created = await adapter().createServiceAccount(createInput({ inboundIds: [1, 2] }));
    expect(created.ok).toBe(true);

    // One shared traffic record drives usage.
    const t = mock.traffic.get(USERNAME);
    if (t !== undefined) {
      t.up = 1000;
      t.down = 2500;
    }
    const read = await adapter().getServiceAccount({ username: USERNAME });
    expect(read.ok).toBe(true);
    expect(read.totalBytes).toBe(10n * GIB);
    expect(read.usedBytes).toBe(3500n);
    expect(read.status).toBe("active");
    expect(read.expiresAt?.getTime()).toBe(new Date("2027-01-01T00:00:00Z").getTime());
    expect(read.subscriptionToken).toBe(USERNAME);

    // Disabled client -> disabled status.
    mock.clients.find((c) => c.email === USERNAME)!.enable = false;
    const disabled = await adapter().getServiceAccount({ username: USERNAME });
    expect(disabled.status).toBe("disabled");

    // LEGACY services (pre-migration per-inbound labels) still read and
    // aggregate so old rows keep syncing/reconciling.
    const legacyUser = "zed_9_legacy01";
    mock.clients.push(
      { email: `${legacyUser}-1`, subId: legacyUser, uuid: randomUUID(), totalGB: Number(5n * GIB), expiryTime: 0, enable: true, reset: 0 },
      { email: `${legacyUser}-2`, subId: legacyUser, uuid: randomUUID(), totalGB: Number(5n * GIB), expiryTime: 0, enable: true, reset: 0 },
    );
    mock.traffic.set(`${legacyUser}-1`, { up: 10, down: 20 });
    mock.traffic.set(`${legacyUser}-2`, { up: 5, down: 5 });
    mock.attachments.set(`${legacyUser}-1`, new Set([1]));
    mock.attachments.set(`${legacyUser}-2`, new Set([2]));
    const legacy = await adapter().getServiceAccount({ username: legacyUser });
    expect(legacy.ok).toBe(true);
    expect(legacy.totalBytes).toBe(5n * GIB);
    expect(legacy.usedBytes).toBe(40n);

    // Absent client with a fully readable inventory -> POSITIVE notFound.
    const absent = await adapter().getServiceAccount({ username: "zed_9999_absent01" });
    expect(absent.ok).toBe(false);
    expect(absent.notFound).toBe(true);

    // Unreadable inventory never reports notFound.
    mock.listClientsNonJson = true;
    const unsure = await adapter().getServiceAccount({ username: "zed_9999_absent01" });
    expect(unsure.ok).toBe(false);
    expect(unsure.notFound).toBeUndefined();

    const dead = new XuiAdapter(
      new XuiClient({ baseUrl: "http://127.0.0.1:1", username: XUI_USER, password: XUI_PASS }),
    );
    const unreachable = await dead.getServiceAccount({ username: USERNAME });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.notFound).toBeUndefined();
  });
});
