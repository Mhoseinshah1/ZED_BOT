import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// =============================================================================
// The Mini App framing exception in the GENERATED production Nginx config
// (N01-N10), plus the production smoke script.
//
// Rendered through the same `nginx-setup.sh --print` path the installer uses,
// then asserted as text and - for N10 - handed to a real `nginx -t`.
//
// What these tests defend:
//
//   * `X-Frame-Options: DENY` must survive everywhere except /miniapp. It is
//     the header that stops the whole panel being framed, and an edit that
//     drops it from the server block would be invisible until someone framed
//     the site.
//   * Nginx add_header inheritance is all-or-nothing per level: a location
//     declaring ANY add_header inherits NONE from its server. That one rule is
//     what removes DENY for the Mini App - and what silently removes nosniff,
//     Referrer-Policy and HSTS if someone forgets to repeat them.
//   * Once XFO is gone, CSP frame-ancestors is the only framing authority, so
//     its directives are asserted individually rather than as one blob.
//
// The origin-server half of proofs 5, 7, 8 and 9 - which document a path
// actually returns, as opposed to which location handles it - lives in
// apps/api/tests/miniapp-static.test.ts, where a real Fastify instance answers.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptsDir = path.join(repoRoot, "scripts");

function renderConfig(kind: "http" | "https", domain = "bot.example.com", port = "3000"): string {
  const result = spawnSync("bash", [path.join(scriptsDir, "nginx-setup.sh"), "--print", kind], {
    encoding: "utf8",
    env: {
      ...process.env,
      APP_DOMAIN: domain,
      API_PORT: port,
      ZEDBOT_ENV_FILE: "/nonexistent-env-for-tests",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

/**
 * Extracts one `location` block by a string in its opening line.
 *
 * Brace-counted rather than regex-sliced: the block contains braces inside
 * quoted header values, and a lazy match would cut the CSP in half and make
 * every assertion below vacuously pass.
 */
function locationBlock(config: string, openingContains: string): string {
  const lines = config.split("\n");
  // The LAST match, not the first: the file holds two server blocks, and the
  // :80 one only redirects. Everything under test lives in the TLS block.
  const start = lines.reduce(
    (found, line, index) =>
      line.trimStart().startsWith("location") && line.includes(openingContains) ? index : found,
    -1,
  );
  expect(start, `no location line containing ${openingContains}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  const collected: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    collected.push(lines[i]);
    depth += (lines[i].match(/\{/g) ?? []).length;
    depth -= (lines[i].match(/\}/g) ?? []).length;
    if (depth === 0 && i > start) {
      break;
    }
  }
  return collected.join("\n");
}

/** Everything in the TLS server block that is NOT inside a location block. */
function serverLevelDirectives(config: string): string {
  const lines = config.split("\n");
  const out: string[] = [];
  let inLocation = 0;
  for (const line of lines) {
    if (inLocation === 0 && line.trimStart().startsWith("location")) {
      inLocation = 1;
      continue;
    }
    if (inLocation > 0) {
      inLocation += (line.match(/\{/g) ?? []).length;
      inLocation -= (line.match(/\}/g) ?? []).length;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Header DIRECTIVES only - comments explaining them must not count. */
function addHeaders(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("add_header "));
}

function cspOf(block: string): string {
  const csp = /add_header Content-Security-Policy "([^"]+)"/.exec(block)?.[1];
  expect(csp, "no Content-Security-Policy in the block").toBeTruthy();
  return csp as string;
}

/**
 * The location regex, as a JS RegExp.
 *
 * Nginx location regexes are PCRE and this one is also valid JavaScript, so
 * every routing claim below is EVALUATED rather than asserted from the shape of
 * the string.
 */
function miniAppLocationRegex(block: string): RegExp {
  const pattern = /location ~ (\S+) \{/.exec(block)?.[1];
  expect(pattern, "no regex location for the Mini App").toBeTruthy();
  return new RegExp(pattern as string);
}

const REQUIRED_CSP_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "frame-ancestors",
  "base-uri",
  "form-action",
  "object-src",
];

const https = renderConfig("https");
const miniapp = locationBlock(https, "/miniapp");
const rootLocation = locationBlock(https, "location / {");
const serverLevel = serverLevelDirectives(https);

describe("mini app Nginx configuration", () => {
  it("N01 every non-Mini-App route still receives X-Frame-Options: DENY", () => {
    expect(serverLevel).toContain('add_header X-Frame-Options "DENY" always;');
    // `location /` declares NO add_header of its own, so it inherits the whole
    // server block. That is how /, /api, /api/miniapp, the payment callbacks,
    // /health and /version all keep DENY without repeating it.
    expect(addHeaders(rootLocation)).toHaveLength(0);
    const regex = miniAppLocationRegex(miniapp);
    for (const route of [
      "/",
      "/api",
      "/api/miniapp",
      "/api/miniapp/me",
      "/health",
      "/version",
      "/payments/zarinpal/callback",
      "/payments/nowpayments/ipn",
    ]) {
      expect(regex.test(route), `${route} must fall through to location /`).toBe(false);
    }
  });

  it("N02 the /miniapp location carries no X-Frame-Options at all", () => {
    // Not "not DENY" - not present. Any value would override frame-ancestors in
    // browsers that honour both, and blank the app inside Telegram.
    expect(addHeaders(miniapp).some((line) => /X-Frame-Options/i.test(line))).toBe(false);
    const regex = miniAppLocationRegex(miniapp);
    for (const route of ["/miniapp", "/miniapp/", "/miniapp/assets/index-abc123.js"]) {
      expect(regex.test(route), `${route} must be handled by the exception`).toBe(true);
    }
  });

  it("N03 Mini App routes carry the expected CSP frame-ancestors", () => {
    const csp = cspOf(miniapp);
    const ancestors = /frame-ancestors ([^;]+)/.exec(csp)?.[1].trim().split(/\s+/) ?? [];
    expect(ancestors.length).toBeGreaterThan(0);
    for (const source of ancestors) {
      // Every entry is an explicit https Telegram origin. No wildcard, no
      // scheme-only source, no OWNER-supplied free text.
      expect(source, `${source} must be an explicit https origin`).toMatch(
        /^https:\/\/[a-z0-9.-]+$/,
      );
      expect(source.endsWith(".telegram.org"), `${source} must be a telegram.org origin`).toBe(true);
    }
    expect(ancestors).toContain("https://web.telegram.org");
    expect(csp).not.toMatch(/frame-ancestors[^;]*\*/);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toMatch(/(^|[ ;])\*([ ;]|$)/);
    expect(csp).not.toMatch(/https:\/\/\*/);
    for (const directive of REQUIRED_CSP_DIRECTIVES) {
      expect(csp, `missing ${directive}`).toMatch(new RegExp(`(^|; )${directive} `));
    }
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    // Native Android/iOS/desktop clients open the Mini App as a TOP-LEVEL
    // document, where frame-ancestors does not apply, so this list cannot
    // affect them.
  });

  it("N04 all other security headers remain present on Mini App responses", () => {
    const headers = addHeaders(miniapp).join("\n");
    expect(headers).toContain('add_header X-Content-Type-Options "nosniff" always;');
    expect(headers).toContain('add_header Referrer-Policy "no-referrer" always;');
    expect(headers).toContain(
      'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
    );
    // Nginx drops ALL inherited add_headers once a location declares one, so
    // every header the server block sets - except the one deliberately dropped
    // - has to be repeated. Deriving the list from the server block means a
    // header added there later cannot be forgotten here without failing.
    const serverHeaderNames = addHeaders(serverLevel)
      .map((line) => /add_header\s+([A-Za-z-]+)/.exec(line)?.[1] ?? "")
      .filter((name) => name !== "" && name !== "X-Frame-Options");
    expect(serverHeaderNames.length).toBeGreaterThan(0);
    for (const name of serverHeaderNames) {
      expect(headers, `${name} must be re-declared inside /miniapp`).toContain(
        `add_header ${name}`,
      );
    }
  });

  it("N05 /api/miniapp still resolves to the API and is never SPA content", () => {
    const regex = miniAppLocationRegex(miniapp);
    expect(regex.test("/api/miniapp")).toBe(false);
    expect(regex.test("/api/miniapp/me")).toBe(false);
    // ...and nothing under /miniapp can be REWRITTEN onto it. `proxy_pass
    // http://host:port;` with no URI part forwards the request path verbatim;
    // a trailing path would replace the matched prefix and let
    // /miniapp/api/miniapp/me land on the JSON API carrying the relaxed
    // framing headers.
    const proxyPass = /proxy_pass\s+([^;]+);/.exec(miniapp)?.[1] ?? "";
    expect(proxyPass).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(proxyPass.endsWith("/")).toBe(false);
    expect(miniapp).not.toContain("rewrite ");
    expect(miniapp).not.toContain("try_files");
  });

  it("N06 /health, /version and payment callbacks are routed unchanged", () => {
    // The Mini App work added exactly one location and touched nothing else:
    // these paths still reach `location /` with the server block's headers.
    const regex = miniAppLocationRegex(miniapp);
    for (const route of [
      "/health",
      "/version",
      "/payments/zarinpal/callback",
      "/payments/nowpayments/ipn",
    ]) {
      expect(regex.test(route), `${route} must not enter the Mini App location`).toBe(false);
    }
    expect(rootLocation).toContain("proxy_pass http://127.0.0.1:3000;");
    expect(rootLocation).toContain("proxy_set_header X-Forwarded-Proto https;");
    expect(https).toContain("client_max_body_size 20m;");
    // The ACME challenge on :80 is untouched, so certificate renewal keeps
    // working.
    expect(https).toContain("location /.well-known/acme-challenge/");
  });

  it("N07 SPA fallback is confined to /miniapp and is the API's job, not Nginx's", () => {
    // Nginx does NOT serve files and does NOT decide what a frontend route is:
    // it proxies /miniapp/* to the API verbatim, and the API distinguishes a
    // frontend route from a missing asset (proved in the API suite). Keeping
    // the decision in one place is what stops the two from disagreeing - an
    // Nginx `try_files ... /index.html` would answer 200-with-HTML for a
    // missing bundle file no matter what the API did.
    expect(miniapp).not.toContain("try_files");
    expect(miniapp).not.toContain("root ");
    expect(miniapp).not.toContain("alias ");
    // ...and the fallback cannot reach outside /miniapp, because no other
    // location mentions index.html at all.
    expect(https).not.toContain("index.html");
  });

  it("N08 a missing asset is proxied through, so the API can answer a real 404", () => {
    const regex = miniAppLocationRegex(miniapp);
    expect(regex.test("/miniapp/assets/does-not-exist-deadbeef.js")).toBe(true);
    // No local file serving in this location means Nginx has no way to invent
    // a 200 for a file that is not there.
    expect(miniapp).not.toContain("root ");
    expect(miniapp).not.toContain("alias ");
    expect(miniapp).not.toMatch(/error_page\s+404/);
  });

  it("N09 traversal and encoded-path variants cannot escape the Mini App root", () => {
    const regex = miniAppLocationRegex(miniapp);
    // Nginx resolves "." and ".." segments BEFORE location matching, so a
    // traversal attempt is normalised and then matched. Both outcomes are safe:
    // it either stays under /miniapp, or it leaves and lands in `location /`
    // with the STRICT headers. What must never happen is escaping upward while
    // keeping the relaxed framing.
    expect(regex.test("/api/miniapp/me")).toBe(false); // '/miniapp/../api/miniapp/me' normalises here
    expect(regex.test("/etc/passwd")).toBe(false); // '/miniapp/../../etc/passwd' normalises here
    // A literal, unnormalised traversal still cannot escape: nothing in this
    // location maps a URL onto a filesystem path, so there is no path to
    // traverse. The document root lives inside the API process.
    expect(miniapp).not.toContain("root ");
    expect(miniapp).not.toContain("alias ");
    // Nor can an adjacent prefix borrow the exception.
    for (const excluded of ["/miniappfoo", "/miniapp2", "/xminiapp", "/miniap"]) {
      expect(regex.test(excluded), `${excluded} must NOT match`).toBe(false);
    }
  });

  it("N10 the generated configuration passes nginx -t", () => {
    const nginxBinary = spawnSync("sh", ["-c", "command -v nginx"], { encoding: "utf8" });
    if (nginxBinary.status !== 0 || nginxBinary.stdout.trim() === "") {
      // Reported rather than silently green: a skipped syntax check must not
      // read as a passing one.
      console.warn("N10 skipped: no nginx binary on PATH");
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), "zedbot-nginx-"));
    const cert = path.join(dir, "cert.pem");
    const key = path.join(dir, "key.pem");
    const openssl = spawnSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", cert, "-days", "1",
        "-subj", "/CN=bot.example.com",
      ],
      { encoding: "utf8" },
    );
    expect(openssl.status, openssl.stderr).toBe(0);

    // NO DIRECTIVE IS EVER SUBSTITUTED OUT. This test previously deleted
    // `http2 on;` when the local nginx was older than 1.25.1 — and that
    // exemption is precisely how a config that cannot start on the deployed
    // server passed CI. The generated file now requests HTTP/2 on the listen
    // line, which every nginx since 1.9.5 accepts, so there is nothing left to
    // excuse and the exemption is gone. See N11.
    //
    // The three remaining substitutions are about the ENVIRONMENT, not the
    // configuration. Every location, header, CSP and protocol directive stays
    // byte-identical to what the installer writes.
    //
    //  1. certificate paths — `nginx -t` genuinely loads the files, and
    //     Let's Encrypt has not run inside a test container.
    let server = https
      .replace(/ssl_certificate\s+\S+;/, `ssl_certificate ${cert};`)
      .replace(/ssl_certificate_key\s+\S+;/, `ssl_certificate_key ${key};`)
      .replace(/^\s*include \/etc\/letsencrypt\/options-ssl-nginx\.conf;\s*$/m, "");
    //  2. IPv6 listeners — `nginx -t` OPENS the listening sockets, so a host
    //     without IPv6 fails on `[::]` with an errno that says nothing about
    //     the configuration.
    if (!existsSync("/proc/net/if_inet6")) {
      server = server.replace(/^\s*listen \[::\][^\n]*\n/gm, "");
    }
    //  3. Privileged ports — same reason, one step further. `nginx -t` binds 80
    //     and 443, which an unprivileged CI runner cannot do, and it reports
    //     that as a failed config test even after printing "syntax is ok". Only
    //     the port number changes; `ssl http2` and everything after it is kept,
    //     so the protocol directives really are the ones being validated.
    server = server
      .replace(/\blisten (\[::\]:)?80;/g, (_m, v6) => `listen ${v6 ?? ""}18080;`)
      .replace(
        /\blisten (\[::\]:)?443 (ssl[^\n;]*);/g,
        (_m, v6, rest) => `listen ${v6 ?? ""}18443 ${rest};`,
      );
    // The rewrite must not have quietly dropped the protocol request — if it
    // had, nginx -t would pass for the wrong reason.
    expect(server, server).toContain("18443 ssl http2;");
    mkdirSync(path.join(dir, "logs"), { recursive: true });
    const confPath = path.join(dir, "nginx.conf");
    writeFileSync(
      confPath,
      [
        "worker_processes 1;",
        `pid ${path.join(dir, "nginx.pid")};`,
        `error_log ${path.join(dir, "logs", "error.log")};`,
        "events { worker_connections 64; }",
        "http {",
        "    access_log off;",
        `    client_body_temp_path ${path.join(dir, "client_body")};`,
        `    proxy_temp_path ${path.join(dir, "proxy")};`,
        `    fastcgi_temp_path ${path.join(dir, "fastcgi")};`,
        `    uwsgi_temp_path ${path.join(dir, "uwsgi")};`,
        `    scgi_temp_path ${path.join(dir, "scgi")};`,
        server,
        "}",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync("nginx", ["-t", "-c", confPath, "-p", dir], { encoding: "utf8" });
    const output = `${result.stdout}${result.stderr}`;

    // The assertion that matters: every directive parsed and is legal in the
    // context it appears in. `nginx -t` prints this verdict separately from
    // its exit code precisely because it also tries to OPEN the listeners.
    expect(output, output).toContain("syntax is ok");

    // The exit code is required too - but a socket error is a property of the
    // machine, not of the configuration, and treating one as a config failure
    // would make this test fail on any host that happens to lack a port or an
    // address family. Those are reported and tolerated; anything else still
    // fails, so a genuine error cannot hide behind the exemption.
    if (result.status !== 0) {
      const socketOnly = output
        .split("\n")
        .filter((line) => line.includes("[emerg]"))
        .every((line) => /bind\(\) to |socket\(\) \[/.test(line));
      expect(socketOnly, output).toBe(true);
      console.warn(`N10: config is valid; nginx could not open its listeners here:\n${output}`);
      return;
    }
    expect(output, output).toContain("test is successful");
  });

  it("N10b HTTP/2 is requested on the listen line, in exactly one style", () => {
    // THE DEPLOYED SERVER IS THE AUTHORITY. `http2 on;` is a separate directive
    // that only exists from nginx 1.25.1. The Ubuntu LTS this project installs
    // on ships 1.24, where it is an unknown directive: `nginx -t` fails, the
    // reverse proxy never starts, and the whole panel is unreachable. It shipped
    // once because N10 deleted the directive before validating on an older
    // binary — the config under test was not the config being deployed.
    //
    // `listen ... http2` has been accepted since 1.9.5 and is only deprecated
    // (a warning) on newer builds, so it is the one spelling correct everywhere
    // this repository is installed.
    expect(https).toContain("listen 443 ssl http2;");
    expect(https).toContain("listen [::]:443 ssl http2;");

    // NEVER BOTH. nginx refuses a server block that requests HTTP/2 twice, so a
    // "belt and braces" edit that left the old directive in place would break
    // exactly the servers it was meant to support.
    expect(https, "the 1.25-only directive must be gone").not.toMatch(/^\s*http2\s+on;/m);
    // And the plain form must not survive anywhere either — a stray
    // `listen 443 ssl;` would silently serve HTTP/1.1 only.
    expect(https).not.toMatch(/^\s*listen (\[::\]:)?443 ssl;\s*$/m);
  });

  it("N10c the local nginx accepts the exact listen line the installer writes", () => {
    // A direct, minimal check of the one directive the deployed server rejected.
    // N10 validates the whole file; this one isolates the line so a failure says
    // "this spelling is not supported here" rather than "something in the config
    // is wrong".
    const nginxBinary = spawnSync("sh", ["-c", "command -v nginx"], { encoding: "utf8" });
    if (nginxBinary.status !== 0 || nginxBinary.stdout.trim() === "") {
      console.warn("N10c skipped: no nginx binary on PATH");
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), "zedbot-nginx-listen-"));
    const cert = path.join(dir, "cert.pem");
    const key = path.join(dir, "key.pem");
    const openssl = spawnSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", cert, "-days", "1",
        "-subj", "/CN=bot.example.com",
      ],
      { encoding: "utf8" },
    );
    expect(openssl.status, openssl.stderr).toBe(0);
    mkdirSync(path.join(dir, "logs"), { recursive: true });

    const listen = existsSync("/proc/net/if_inet6")
      ? "        listen 18443 ssl http2;\n        listen [::]:18443 ssl http2;"
      : "        listen 18443 ssl http2;";
    const confPath = path.join(dir, "nginx.conf");
    writeFileSync(
      confPath,
      [
        "worker_processes 1;",
        `pid ${path.join(dir, "nginx.pid")};`,
        `error_log ${path.join(dir, "logs", "error.log")};`,
        "events { worker_connections 64; }",
        "http {",
        "    access_log off;",
        `    client_body_temp_path ${path.join(dir, "client_body")};`,
        `    proxy_temp_path ${path.join(dir, "proxy")};`,
        `    fastcgi_temp_path ${path.join(dir, "fastcgi")};`,
        `    uwsgi_temp_path ${path.join(dir, "uwsgi")};`,
        `    scgi_temp_path ${path.join(dir, "scgi")};`,
        "    server {",
        listen,
        "        server_name bot.example.com;",
        `        ssl_certificate ${cert};`,
        `        ssl_certificate_key ${key};`,
        "        location / { return 204; }",
        "    }",
        "}",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync("nginx", ["-t", "-c", confPath, "-p", dir], { encoding: "utf8" });
    const output = `${result.stdout}${result.stderr}`;
    expect(output, output).toContain("syntax is ok");
    // The specific failure this guards against, named so a regression is
    // obvious from the assertion alone.
    expect(output).not.toContain('unknown directive "http2"');
  });
});

describe("mini app production smoke script", () => {
  const smokePath = path.join(scriptsDir, "miniapp-smoke.sh");
  const smoke = readFileSync(smokePath, "utf8");

  it("N11 parses as bash and is read-only", () => {
    const syntax = spawnSync("bash", ["-n", smokePath], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
    // Three GETs, nothing else. Safe to point at production.
    expect(smoke).not.toMatch(/-X\s+(POST|PUT|PATCH|DELETE)/);
    expect(smoke).not.toContain("--data");
  });

  it("N12 asserts DENY on /, /health and /api/miniapp/me", () => {
    for (const route of ["/health", "/api/miniapp/me"]) {
      expect(smoke, `must probe ${route}`).toContain(route);
    }
    expect(smoke).toContain("x-frame-options");
    expect(smoke).toContain("deny");
  });

  it("N13 asserts no XFO and a valid CSP on /miniapp", () => {
    expect(smoke).toContain("/miniapp/");
    expect(smoke).toContain("frame-ancestors");
    expect(smoke).toContain("x-content-type-options");
    expect(smoke).toContain("referrer-policy");
    expect(smoke).toContain("strict-transport-security");
  });

  it("N14 asserts immutable caching and the right MIME type on hashed assets", () => {
    expect(smoke).toContain("immutable");
    expect(smoke).toContain("content-type");
    expect(smoke).toContain("/miniapp/assets/");
  });

  it("N15 needs no Telegram client and no credentials", () => {
    expect(smoke).not.toContain("api.telegram.org");
    expect(smoke).not.toContain("initData");
    expect(smoke).not.toContain("BOT_TOKEN");
  });
});
