import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// Same-origin static serving of the Mini App bundle (N05b, N07-N09b + assets).
//
// The origin-server half of the deployment proofs. Nginx decides WHICH location
// handles a path (proved in apps/bot/tests/miniapp-nginx.test.ts); this decides
// what the API actually answers, which is where the difference between "a
// frontend route" and "a missing asset" is made.
//
// Deliberately NOT a database test: static serving has no database in it, and a
// suite that skipped itself without DATABASE_URL would leave these guarantees
// unproven on a developer machine.
//
// The bundle is a fixture, not the real build output. Depending on
// `apps/miniapp/dist` would make this suite pass or fail on whether someone had
// run `vite build`, and the point is the serving rules, not the bundle.
// =============================================================================

const HASHED_ASSET = "index-a1b2c3d4.js";
const HASHED_STYLE = "index-e5f6a7b8.css";
const INDEX_MARKER = "<!--miniapp-index-fixture-->";

let app: FastifyInstance;
let root = "";

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "zedbot-miniapp-dist-"));
  mkdirSync(path.join(root, "assets"), { recursive: true });
  writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html><html lang="fa" dir="rtl"><head>${INDEX_MARKER}` +
      `<script type="module" src="/miniapp/assets/${HASHED_ASSET}"></script>` +
      `<link rel="stylesheet" href="/miniapp/assets/${HASHED_STYLE}"></head><body></body></html>`,
    "utf8",
  );
  writeFileSync(path.join(root, "assets", HASHED_ASSET), "export const ok = true;\n", "utf8");
  writeFileSync(path.join(root, "assets", HASHED_STYLE), ":root{--x:1}\n", "utf8");
  // A file that must never be served even though it lives under the root.
  writeFileSync(path.join(root, ".env"), "SECRET=must-not-be-served\n", "utf8");

  process.env.MINIAPP_DIST_DIR = root;
  const { miniAppStaticRoutes } = await import("../src/miniapp/static.js");
  app = Fastify({ logger: false });
  await app.register(miniAppStaticRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe("mini app static serving", () => {
  it("N07a /miniapp and /miniapp/ both return the SPA entry document, uncached", async () => {
    for (const url of ["/miniapp", "/miniapp/"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toContain(INDEX_MARKER);
      // index.html names the CURRENT hashed bundles, so a cached copy would
      // keep pointing at files the next deploy deletes.
      expect(response.headers["cache-control"], url).toBe("no-store");
      expect(response.headers["x-content-type-options"], url).toBe("nosniff");
    }
  });

  it("N07b an unknown frontend route under /miniapp returns the SPA document", async () => {
    for (const url of ["/miniapp/dashboard", "/miniapp/services/some-id", "/miniapp/wallet"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toContain(INDEX_MARKER);
      expect(response.headers["cache-control"], url).toBe("no-store");
    }
  });

  it("N08a a missing static asset returns a real 404, never the SPA document", async () => {
    // The failure this prevents: a half-deployed bundle answering 200 with
    // HTML, so the browser tries to execute a document as JavaScript and the
    // real problem shows up as a mystifying syntax error.
    for (const url of [
      "/miniapp/assets/index-deadbeef.js",
      "/miniapp/assets/missing.css",
      "/miniapp/favicon.ico",
      "/miniapp/manifest.webmanifest",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).not.toContain(INDEX_MARKER);
    }
  });

  it("N08b real assets are served with immutable caching and the right MIME type", async () => {
    const script = await app.inject({ method: "GET", url: `/miniapp/assets/${HASHED_ASSET}` });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("javascript");
    // Content-hashed name -> a stale copy is impossible by construction, so a
    // year of immutable caching needs no purge at deploy time.
    expect(script.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(script.headers["x-content-type-options"]).toBe("nosniff");

    const style = await app.inject({ method: "GET", url: `/miniapp/assets/${HASHED_STYLE}` });
    expect(style.statusCode).toBe(200);
    expect(style.headers["content-type"]).toContain("text/css");
    expect(style.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("N05b /miniapp/api is refused and is never answered as SPA content", async () => {
    // The path-confusion shape: if this returned the SPA document, a caller
    // could believe /miniapp/api/... reached the JSON API. It must not, and the
    // guarantee is enforced here as well as at the edge.
    for (const url of ["/miniapp/api", "/miniapp/api/miniapp/me", "/miniapp/api/anything"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).not.toContain(INDEX_MARKER);
      expect(response.json().code).toBe("NOT_FOUND");
    }
  });

  it("N09b traversal and encoded-path variants cannot escape the Mini App root", async () => {
    for (const url of [
      "/miniapp/../.env",
      "/miniapp/..%2f.env",
      "/miniapp/%2e%2e/.env",
      "/miniapp/%252e%252e%252f.env",
      "/miniapp/assets/../../.env",
      "/miniapp/a/../../../etc/passwd",
    ]) {
      const response = await app.inject({ method: "GET", url });
      // Either refused outright or answered with the SPA shell - never file
      // content from outside the bundle, and never the dotfile inside it.
      expect(response.body, url).not.toContain("must-not-be-served");
      expect(response.body, url).not.toContain("root:x:");
      expect([400, 403, 404], `${url} -> ${response.statusCode}`).toContain(response.statusCode);
    }
  });

  it("N09c a dotfile inside the bundle is never served", async () => {
    const response = await app.inject({ method: "GET", url: "/miniapp/.env" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("must-not-be-served");
  });

  it("N07c the SPA fallback is confined to /miniapp", async () => {
    // Nothing outside the prefix is claimed by this plugin, so /api/miniapp,
    // /health and /version keep reaching their own handlers.
    for (const url of ["/api/miniapp/me", "/health", "/version", "/", "/miniappfoo"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).not.toContain(INDEX_MARKER);
    }
  });

  it("N08c a bundle that was never built leaves the API otherwise healthy", async () => {
    // A missing frontend must not stop the process that also serves payment
    // callbacks. It registers nothing and says so in the log.
    const missing = mkdtempSync(path.join(tmpdir(), "zedbot-miniapp-empty-"));
    process.env.MINIAPP_DIST_DIR = missing;
    const { miniAppStaticRoutes } = await import("../src/miniapp/static.js");
    const bare = Fastify({ logger: false });
    bare.get("/health", async () => ({ ok: true }));
    await bare.register(miniAppStaticRoutes);
    await bare.ready();
    try {
      expect((await bare.inject({ method: "GET", url: "/miniapp" })).statusCode).toBe(404);
      expect((await bare.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await bare.close();
      process.env.MINIAPP_DIST_DIR = root;
    }
  });
});
