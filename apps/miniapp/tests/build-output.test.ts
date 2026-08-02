import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// =============================================================================
// The built bundle (F21-F25).
//
// These assert the properties the deployment configuration DEPENDS ON. The CSP
// omits `'unsafe-inline'` from `style-src` and `script-src`, which is only
// correct as long as the build keeps emitting external files - so the claim is
// checked against the real output rather than assumed.
//
// The suite runs after `pnpm build` (CI builds before it tests). Without a
// build it reports the skip loudly rather than passing silently.
// =============================================================================

const distDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
const indexPath = path.join(distDir, "index.html");
const built = existsSync(indexPath);

if (!built) {
  console.warn("mini app build output tests skipped: run `pnpm --filter @zedbot/miniapp build`");
}

describe.skipIf(!built)("mini app build output", () => {
  const html = built ? readFileSync(indexPath, "utf8") : "";

  it("F21 emits no inline style or script, so the CSP needs no unsafe-inline", () => {
    // `<script src=...>` is fine; a `<script>` with a body is not, and neither
    // is a `<style>` block or a style attribute. Any of them would force
    // 'unsafe-inline' into the policy, which is the one relaxation that makes
    // a CSP stop being a defence against injected markup.
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle\s*=\s*["']/i);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i);
  });

  it("F22 references every asset through the /miniapp/ base", () => {
    const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      if (reference.startsWith("http")) {
        // The only external origin is Telegram's WebApp bridge, which the CSP
        // names in script-src.
        expect(reference, reference).toBe("https://telegram.org/js/telegram-web-app.js");
        continue;
      }
      // Nothing root-relative: a "/assets/..." would 404 under the sub-path and
      // would also escape the one location carrying the framing exception.
      expect(reference.startsWith("/miniapp/"), reference).toBe(true);
    }
  });

  it("F23 content-hashes every asset filename", () => {
    const assets = readdirSync(path.join(distDir, "assets"));
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      // `<name>-<hash>.<ext>` - the hash is what makes a year of immutable
      // caching safe, because a changed file can never reuse a cached name.
      expect(asset, asset).toMatch(/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/);
    }
  });

  it("F24 ships no CSP of its own", () => {
    // Nginx is the single authority. A <meta http-equiv> policy would INTERSECT
    // with the header, producing a combined policy nobody wrote - the classic
    // way a CSP quietly stops doing what its author believes it does.
    expect(html).not.toMatch(/http-equiv\s*=\s*["']Content-Security-Policy/i);
  });

  it("F25 bakes in no secret and no user data", () => {
    const bundle = readdirSync(path.join(distDir, "assets"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(path.join(distDir, "assets", name), "utf8"))
      .join("\n");
    // A build-time leak is permanent: the bundle is one artifact served to
    // every visitor.
    // "ZARINPAL"/"NOWPAYMENTS" alone are no longer forbidden: they are the
    // PaymentGatewayType wire codes the commerce screens legitimately render
    // through i18n. What must never appear are the credential-bearing env
    // names and connection strings.
    for (const forbidden of [
      "APP_SECRET",
      "TELEGRAM_BOT_TOKEN",
      "DATABASE_URL",
      "ZARINPAL_MERCHANT_ID",
      "ZARINPAL_CALLBACK_URL",
      "NOWPAYMENTS_API_KEY",
      "NOWPAYMENTS_IPN_SECRET",
      "postgresql://",
      "redis://",
    ]) {
      expect(bundle, forbidden).not.toContain(forbidden);
    }
    // The API is reached through relative paths only - no absolute host is
    // compiled in, which is what keeps the app same-origin by construction.
    expect(bundle).toContain("/api/miniapp");
    expect(bundle).not.toMatch(/https?:\/\/[^"'`\s]*\/api\/miniapp/);
  });
});
