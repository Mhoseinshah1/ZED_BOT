import { prisma, type ConnectionGuideApp } from "@zedbot/database";
import {
  clampHtmlMessage,
  GUIDE_MAX_ACTIVE_APPS_PER_PLATFORM,
  GUIDE_PAGE_TEXT_MAX,
  GUIDE_PLATFORM_CODE,
  guidePlatformFromCode,
  isValidGuideSlug,
  slugifyGuideName,
  validateHttpsDownloadUrl,
} from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "connection-guides-core-tests-secret-0123456789";

import {
  createGuideApp,
  disableConnectionGuides,
  enableConnectionGuides,
  evaluateGuideReadiness,
  getActiveGuideAppsForPlatform,
  getAvailablePlatforms,
  invalidateGuideCache,
  isConnectionGuideEntryVisible,
  isConnectionGuidesEnabled,
  listGuideAppsForPlatformAdmin,
  moveGuideApp,
  resolveGuideMethods,
  setGuideAppActive,
  updateGuideAppFields,
  validateGuideAppInput,
} from "../src/services/connection-guide.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";

// =============================================================================
// §3/§4/§12/§19 - shared validators + the guide core service. Pure URL/slug
// validation, method resolution, readiness gate, bounded active reads, cache
// invalidation and entry visibility, over a real DB.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

describe("HTTPS download-URL validation (§12) - pure, never fetches", () => {
  it("accepts a normal https URL", () => {
    expect(validateHttpsDownloadUrl("https://apps.apple.com/app/id123")).toEqual({
      ok: true,
      url: "https://apps.apple.com/app/id123",
    });
  });
  it("rejects non-https schemes (http/javascript/data/file/ftp/custom)", () => {
    for (const u of [
      "http://example.com/app",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "ftp://example.com/app",
      "app://import?url=secret",
    ]) {
      expect(validateHttpsDownloadUrl(u).ok, u).toBe(false);
    }
  });
  it("rejects embedded credentials", () => {
    const r = validateHttpsDownloadUrl("https://user:pass@example.com/app");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("HAS_CREDENTIALS");
  });
  it("rejects INTERNAL control characters (which the URL parser would strip) and over-length URLs", () => {
    // A tab/newline embedded inside the URL is rejected BEFORE parsing (the
    // WHATWG parser would otherwise silently strip it).
    expect(validateHttpsDownloadUrl("https://example.com/a\tb").ok).toBe(false);
    expect(validateHttpsDownloadUrl("https://exa\u0000mple.com/app").ok).toBe(false);
    expect(validateHttpsDownloadUrl(`https://example.com/${"a".repeat(600)}`).ok).toBe(false);
    // Trailing whitespace is trimmed, not a control-char rejection.
    expect(validateHttpsDownloadUrl("https://example.com/app\n").ok).toBe(true);
  });
  it("a rejection reason never echoes the raw URL", () => {
    const r = validateHttpsDownloadUrl("javascript:alert('SECRETTOKEN')");
    expect(JSON.stringify(r)).not.toContain("SECRETTOKEN");
  });
});

describe("clampHtmlMessage (§P1) - HTML-aware, tag-balanced truncation", () => {
  it("returns short text unchanged", () => {
    expect(clampHtmlMessage("<b>hi</b>")).toBe("<b>hi</b>");
  });
  it("clamps to the limit and re-closes a tag left open by the cut", () => {
    const html = `<b>${"a".repeat(5000)}</b>`; // opening tag near the start, close at the very end
    const out = clampHtmlMessage(html);
    expect(out.length).toBeLessThanOrEqual(GUIDE_PAGE_TEXT_MAX);
    // The <b> opened before the cut must be re-closed so Telegram accepts the HTML.
    expect(out.endsWith("</b>")).toBe(true);
    // No dangling partial tag or entity at the boundary.
    expect(/<[^>]*$/.test(out)).toBe(false);
    expect(/&[^;]{0,9}$/.test(out)).toBe(false);
  });
  it("never cuts in the middle of a tag", () => {
    // Put a long run then a tag right around the budget boundary.
    const html = `${"x".repeat(GUIDE_PAGE_TEXT_MAX - 3)}<i>tail</i>`;
    const out = clampHtmlMessage(html);
    expect(out.length).toBeLessThanOrEqual(GUIDE_PAGE_TEXT_MAX);
    // Either the <i> is fully present+closed, or it was dropped entirely — never half a tag.
    expect(/<[^>]*$/.test(out)).toBe(false);
  });
});

describe("slug format + platform codes", () => {
  it("validates the bounded safe slug format", () => {
    expect(isValidGuideSlug("v2rayng")).toBe(true);
    expect(isValidGuideSlug("app-2")).toBe(true);
    expect(isValidGuideSlug("-bad")).toBe(false);
    expect(isValidGuideSlug("bad-")).toBe(false);
    expect(isValidGuideSlug("Bad")).toBe(false);
    expect(isValidGuideSlug("a".repeat(40))).toBe(false);
  });
  it("slugifies non-ASCII names to a safe fallback", () => {
    expect(isValidGuideSlug(slugifyGuideName("V2RayNG"))).toBe(true);
    expect(slugifyGuideName("برنامه فارسی")).toBe("app");
  });
  it("round-trips platform code <-> platform", () => {
    expect(guidePlatformFromCode(GUIDE_PLATFORM_CODE.IOS)).toBe("IOS");
    expect(guidePlatformFromCode("nope")).toBeNull();
  });
});

describe("method availability (§10) - pure", () => {
  const app = (over: Partial<ConnectionGuideApp> = {}) =>
    ({
      supportsSubscription: true,
      supportsQr: true,
      supportsIndividualConfigs: true,
      ...over,
    }) as ConnectionGuideApp;
  const svc = (over: Record<string, unknown> = {}) =>
    ({ subscriptionUrl: "https://s", configLinks: ["vmess://a"], ...over }) as never;

  it("subscription requires BOTH the payload and the app flag", () => {
    expect(resolveGuideMethods(app(), svc()).subscription).toBe(true);
    expect(resolveGuideMethods(app({ supportsSubscription: false }), svc()).subscription).toBe(false);
    expect(resolveGuideMethods(app(), svc({ subscriptionUrl: null })).subscription).toBe(false);
  });
  it("configs require BOTH the payload and the app flag", () => {
    expect(resolveGuideMethods(app(), svc()).configs).toBe(true);
    expect(resolveGuideMethods(app({ supportsIndividualConfigs: false }), svc()).configs).toBe(false);
    expect(resolveGuideMethods(app(), svc({ configLinks: [] })).configs).toBe(false);
  });
  it("qr requires the app flag AND a QR-able payload", () => {
    expect(resolveGuideMethods(app(), svc()).qr).toBe(true);
    expect(resolveGuideMethods(app({ supportsQr: false }), svc()).qr).toBe(false);
    expect(resolveGuideMethods(app(), svc({ subscriptionUrl: null, configLinks: [] })).qr).toBe(false);
  });
  it("a QR-ONLY app still exposes the QR action for the available payload", () => {
    const qrOnly = app({
      supportsSubscription: false,
      supportsIndividualConfigs: false,
      supportsQr: true,
    });
    const m = resolveGuideMethods(qrOnly, svc({ configLinks: [] })); // only a subscription payload
    expect(m.subscription).toBe(false);
    expect(m.configs).toBe(false);
    expect(m.qrSubscription).toBe(true); // QR keyed to the payload, not the text-link flag
    expect(m.qrConfigs).toBe(false);
    expect(m.qr).toBe(true);
    expect(m.anyAvailable).toBe(true); // NOT a dead-end app
  });
});

describe("validateGuideAppInput (§4) - typed errors, no content echo", () => {
  const base = {
    platform: "IOS",
    displayName: "V2Box",
    iconEmoji: "📱",
    primaryDownloadUrl: "https://apps.apple.com/app",
    alternateDownloadUrl: null,
    supportsSubscription: true,
    supportsQr: true,
    supportsIndividualConfigs: true,
    instructions: "لینک اشتراک را وارد کنید.",
    troubleshooting: "",
    sortOrder: 0,
  };
  it("accepts a valid record", () => {
    expect(validateGuideAppInput(base).ok).toBe(true);
  });
  it("rejects an invalid platform / non-https url / empty name / no method", () => {
    expect(validateGuideAppInput({ ...base, platform: "WATCH" }).ok).toBe(false);
    expect(validateGuideAppInput({ ...base, primaryDownloadUrl: "http://x" }).ok).toBe(false);
    expect(validateGuideAppInput({ ...base, displayName: "" }).ok).toBe(false);
    expect(
      validateGuideAppInput({
        ...base,
        supportsSubscription: false,
        supportsQr: false,
        supportsIndividualConfigs: false,
      }).ok,
    ).toBe(false);
  });
  it("accepts a complex multi-code-unit (ZWJ) emoji as the icon", () => {
    // 👨‍👩‍👧‍👦 is 11 UTF-16 code units — the icon bound must not reject a single emoji.
    expect("👨‍👩‍👧‍👦".length).toBeGreaterThan(8);
    expect(validateGuideAppInput({ ...base, iconEmoji: "👨‍👩‍👧‍👦" }).ok).toBe(true);
    // A pasted paragraph is still rejected.
    expect(validateGuideAppInput({ ...base, iconEmoji: "x".repeat(64) }).ok).toBe(false);
  });
});

d("guide core service (DB-backed)", () => {
  const tag = `gcore-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const created: string[] = [];

  async function makeApp(over: Record<string, unknown> = {}): Promise<ConnectionGuideApp> {
    const v = validateGuideAppInput({
      platform: "IOS",
      displayName: `${tag}-${created.length}`,
      iconEmoji: "📱",
      primaryDownloadUrl: "https://apps.apple.com/app",
      alternateDownloadUrl: null,
      supportsSubscription: true,
      supportsQr: true,
      supportsIndividualConfigs: true,
      instructions: "برنامه را نصب کنید و لینک اشتراک را وارد کنید.",
      troubleshooting: "",
      sortOrder: 0,
      ...over,
    });
    if (!v.ok) throw new Error("fixture invalid");
    const app = await createGuideApp(v.value, "admin-test");
    created.push(app.id);
    return app;
  }

  beforeAll(async () => {
    // Start from a clean slate so the readiness/enable assertions are deterministic.
    await prisma.connectionGuideApp.deleteMany({});
    await disableConnectionGuides();
    clearSettingsCache();
    invalidateGuideCache();
  });

  afterEach(() => {
    invalidateGuideCache();
  });

  afterAll(async () => {
    await prisma.connectionGuideApp.deleteMany({ where: { id: { in: created } } });
    await disableConnectionGuides();
    clearSettingsCache();
    await prisma.$disconnect();
  });

  it("defaults the master switch to disabled", async () => {
    clearSettingsCache();
    expect(await isConnectionGuidesEnabled()).toBe(false);
  });

  it("the enable gate BLOCKS with no active app and PASSES once one is valid+active", async () => {
    const blocked = await enableConnectionGuides();
    expect(blocked.ok).toBe(false);
    const app = await makeApp();
    await setGuideAppActive(app.id, true, "admin-test");
    const ok = await enableConnectionGuides();
    expect(ok.ok).toBe(true);
    clearSettingsCache();
    expect(await isConnectionGuidesEnabled()).toBe(true);
  });

  it("readiness reports an active-but-invalid app and refuses enable", async () => {
    // Corrupt an active app's URL directly (bypassing validation) -> invalid.
    const app = await makeApp();
    await setGuideAppActive(app.id, true, "admin-test");
    await prisma.connectionGuideApp.update({
      where: { id: app.id },
      data: { primaryDownloadUrl: "http://not-https" },
    });
    invalidateGuideCache();
    const readiness = await evaluateGuideReadiness();
    expect(readiness.invalidActiveCount).toBeGreaterThanOrEqual(1);
    expect(readiness.ready).toBe(false);
    // Fix it back so the suite's enabled state is consistent.
    await updateGuideAppFields(app.id, { primaryDownloadUrl: "https://apps.apple.com/app" }, "admin-test");
  });

  it("getAvailablePlatforms lists only platforms with an active app", async () => {
    const platforms = await getAvailablePlatforms();
    expect(platforms).toContain("IOS");
    expect(platforms).not.toContain("LINUX");
  });

  it("bounds active apps per platform to the cap", async () => {
    for (let i = 0; i < GUIDE_MAX_ACTIVE_APPS_PER_PLATFORM + 3; i += 1) {
      const app = await makeApp({ displayName: `${tag}-bulk-${i}` });
      await setGuideAppActive(app.id, true, "admin-test");
    }
    invalidateGuideCache();
    const apps = await getActiveGuideAppsForPlatform("IOS");
    expect(apps.length).toBeLessThanOrEqual(GUIDE_MAX_ACTIVE_APPS_PER_PLATFORM);
  });

  it("moveGuideApp reorders correctly even when apps share a duplicate sortOrder", async () => {
    // Scoped to ANDROID so it leaves the IOS/switch state the other tests rely on
    // untouched. All three share sortOrder=5 (a duplicate), so display order falls
    // back to displayName ASC.
    await prisma.connectionGuideApp.deleteMany({ where: { platform: "ANDROID" } });
    const a = await makeApp({ platform: "ANDROID", displayName: "AAA", sortOrder: 5 });
    const b = await makeApp({ platform: "ANDROID", displayName: "BBB", sortOrder: 5 });
    const c = await makeApp({ platform: "ANDROID", displayName: "CCC", sortOrder: 5 });
    // Display order with all sortOrder equal falls back to displayName ASC: A,B,C.
    const before = (await listGuideAppsForPlatformAdmin("ANDROID")).map((x) => x.id);
    expect(before).toEqual([a.id, b.id, c.id]);
    // Move the middle app (B) up — a strict-inequality swap would skip A (same
    // sortOrder) and jump; the index-based move must land B before A: B,A,C.
    const moved = await moveGuideApp(b.id, "up", "admin-test");
    expect(moved).toBe(true);
    const after = (await listGuideAppsForPlatformAdmin("ANDROID")).map((x) => x.id);
    expect(after).toEqual([b.id, a.id, c.id]);
    // Order is now gap-free and deterministic (0,1,2).
    const orders = (await listGuideAppsForPlatformAdmin("ANDROID")).map((x) => x.sortOrder);
    expect(orders).toEqual([0, 1, 2]);
    // Moving the top app up is a no-op.
    expect(await moveGuideApp(b.id, "up", "admin-test")).toBe(false);
  });

  it("entry visibility requires enabled + active app + a usable payload", async () => {
    clearSettingsCache();
    invalidateGuideCache();
    const withPayload = { subscriptionUrl: "https://s", configLinks: [] } as never;
    const noPayload = { subscriptionUrl: null, configLinks: [] } as never;
    expect(await isConnectionGuideEntryVisible(withPayload)).toBe(true);
    expect(await isConnectionGuideEntryVisible(noPayload)).toBe(false);
    await disableConnectionGuides();
    clearSettingsCache();
    expect(await isConnectionGuideEntryVisible(withPayload)).toBe(false);
  });
});
