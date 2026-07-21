import { prisma, type ConnectionGuideApp, type Service } from "@zedbot/database";
import {
  CONNECTION_GUIDES_ENABLED_KEY,
  GUIDE_DISPLAY_NAME_MAX,
  GUIDE_DISPLAY_NAME_MIN,
  GUIDE_ICON_EMOJI_MAX,
  GUIDE_INSTRUCTIONS_MAX,
  GUIDE_INSTRUCTIONS_MIN,
  GUIDE_MAX_ACTIVE_APPS_PER_PLATFORM,
  GUIDE_PLATFORMS,
  GUIDE_SLUG_MAX,
  GUIDE_SORT_ORDER_MAX,
  GUIDE_SORT_ORDER_MIN,
  GUIDE_TROUBLESHOOTING_MAX,
  isGuidePlatform,
  isValidGuideSlug,
  slugifyGuideName,
  validateHttpsDownloadUrl,
  type GuidePlatform,
} from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { getBooleanSetting, setSetting } from "./settings.service.js";

// =============================================================================
// Device connection guides — core service (feat/device-connection-guides).
//
// Owner-agnostic, data-focused layer over ConnectionGuideApp: the master-switch
// read, active-app reads (bounded, cached), the method-availability resolver, the
// enable readiness gate, per-field input validation and the allowlisted admin
// mutations. It stores/returns ONLY operator-authored content and never a Service
// secret, and it mutates NO Service state. Every admin write invalidates the
// active-app cache. Rendering (Persian copy, keyboards) lives in the view layer.
// =============================================================================

export type { ConnectionGuideApp };

/** Reads the master switch (default FALSE). */
export async function isConnectionGuidesEnabled(): Promise<boolean> {
  return getBooleanSetting(CONNECTION_GUIDES_ENABLED_KEY, false);
}

// --- active-app cache (user-facing reads only) -------------------------------
// Short-TTL memo of the ACTIVE, non-archived apps used to render user guide
// pages. Holds only operator content (no Service/user data), is bounded to the
// active set, is invalidated on every admin write, and falls back to a direct
// query when absent/stale. Admin reads never use this cache — they always query
// fresh so an editor sees inactive/invalid rows immediately.
const CACHE_TTL_MS = 60_000;
let activeCache: { at: number; apps: ConnectionGuideApp[] } | null = null;

/** Drops the active-app cache. Call after every admin mutation. */
export function invalidateGuideCache(): void {
  activeCache = null;
}

const ACTIVE_ORDER = [{ platform: "asc" }, { sortOrder: "asc" }, { displayName: "asc" }] as const;

async function loadActiveApps(): Promise<ConnectionGuideApp[]> {
  const fresh = activeCache !== null && Date.now() - activeCache.at < CACHE_TTL_MS;
  if (fresh && activeCache !== null) {
    return activeCache.apps;
  }
  const apps = await prisma.connectionGuideApp.findMany({
    where: { isActive: true, archivedAt: null },
    orderBy: [...ACTIVE_ORDER],
  });
  activeCache = { at: Date.now(), apps };
  return apps;
}

/** All active apps (cached). Fails CLOSED (empty) on a DB error. */
export async function getActiveGuideApps(): Promise<ConnectionGuideApp[]> {
  try {
    return await loadActiveApps();
  } catch (err) {
    logger.warn("connection-guide active read failed", { error: String(err) });
    return [];
  }
}

/**
 * Active apps for one platform, ordered sortOrder ASC then displayName ASC, and
 * hard-bounded to GUIDE_MAX_ACTIVE_APPS_PER_PLATFORM so the app keyboard is never
 * unbounded. Returns the count actually present so the caller can note truncation.
 */
export async function getActiveGuideAppsForPlatform(
  platform: GuidePlatform,
): Promise<ConnectionGuideApp[]> {
  const all = await getActiveGuideApps();
  return all.filter((a) => a.platform === platform).slice(0, GUIDE_MAX_ACTIVE_APPS_PER_PLATFORM);
}

/** Platforms (in canonical order) that currently have >=1 active app. */
export async function getAvailablePlatforms(): Promise<GuidePlatform[]> {
  const all = await getActiveGuideApps();
  const present = new Set(all.map((a) => a.platform));
  return GUIDE_PLATFORMS.filter((p) => present.has(p));
}

/** A single ACTIVE app by slug (from the cached active set), or null. */
export async function getActiveGuideAppBySlug(slug: string): Promise<ConnectionGuideApp | null> {
  if (!isValidGuideSlug(slug)) {
    return null;
  }
  const all = await getActiveGuideApps();
  return all.find((a) => a.slug === slug) ?? null;
}

// --- payload + entry visibility ----------------------------------------------
/** The Service exposes at least one usable connection payload. */
export function serviceHasSubscription(service: Pick<Service, "subscriptionUrl">): boolean {
  return typeof service.subscriptionUrl === "string" && service.subscriptionUrl !== "";
}

export function serviceHasConfigLinks(service: Pick<Service, "configLinks">): boolean {
  return (
    Array.isArray(service.configLinks) &&
    service.configLinks.some((l) => typeof l === "string" && l !== "")
  );
}

export function serviceHasConnectionPayload(
  service: Pick<Service, "subscriptionUrl" | "configLinks">,
): boolean {
  return serviceHasSubscription(service) || serviceHasConfigLinks(service);
}

/**
 * Whether the «آموزش اتصال 📱» entry should be offered for `service`: the master
 * switch is on, at least one active guide app exists, AND the Service has a
 * usable connection payload. Fails CLOSED on any error.
 */
export async function isConnectionGuideEntryVisible(
  service: Pick<Service, "subscriptionUrl" | "configLinks">,
): Promise<boolean> {
  try {
    if (!serviceHasConnectionPayload(service)) {
      return false;
    }
    if (!(await isConnectionGuidesEnabled())) {
      return false;
    }
    return (await getAvailablePlatforms()).length > 0;
  } catch (err) {
    logger.warn("connection-guide entry visibility check failed", { error: String(err) });
    return false;
  }
}

// --- method availability -----------------------------------------------------
export interface GuideMethodAvailability {
  /** Subscription-link method: Service has a subscriptionUrl AND app supports it. */
  subscription: boolean;
  /** Individual-config method: Service has config links AND app supports them. */
  configs: boolean;
  /** QR method: app supports QR AND at least one QR-able payload is available. */
  qr: boolean;
  /** Any usable method at all. */
  anyAvailable: boolean;
}

/** Resolves which connection methods are BOTH offered by the app AND backed by a
 * real payload on this Service. Pure — reads only the app flags + the Service's
 * own payload presence (never the secret values). */
export function resolveGuideMethods(
  app: Pick<ConnectionGuideApp, "supportsSubscription" | "supportsQr" | "supportsIndividualConfigs">,
  service: Pick<Service, "subscriptionUrl" | "configLinks">,
): GuideMethodAvailability {
  const hasSub = serviceHasSubscription(service);
  const hasCfg = serviceHasConfigLinks(service);
  const subscription = hasSub && app.supportsSubscription;
  const configs = hasCfg && app.supportsIndividualConfigs;
  const qr = app.supportsQr && (subscription || configs);
  return { subscription, configs, qr, anyAvailable: subscription || configs };
}

// --- input validation --------------------------------------------------------
export type GuideFieldError =
  | "PLATFORM"
  | "DISPLAY_NAME"
  | "ICON"
  | "PRIMARY_URL"
  | "ALT_URL"
  | "INSTRUCTIONS"
  | "TROUBLESHOOTING"
  | "SORT_ORDER"
  | "NO_METHOD";

export interface GuideAppInput {
  platform: string;
  displayName: string;
  iconEmoji: string;
  primaryDownloadUrl: string;
  alternateDownloadUrl: string | null;
  supportsSubscription: boolean;
  supportsQr: boolean;
  supportsIndividualConfigs: boolean;
  instructions: string;
  troubleshooting: string;
  sortOrder: number;
}

export interface NormalizedGuideAppInput extends GuideAppInput {
  platform: GuidePlatform;
  primaryDownloadUrl: string;
  alternateDownloadUrl: string | null;
}

/** Validates a full guide-app record (used by create). Returns typed field errors
 * only — never echoes the raw URL or instruction body. */
export function validateGuideAppInput(
  input: GuideAppInput,
): { ok: true; value: NormalizedGuideAppInput } | { ok: false; errors: GuideFieldError[] } {
  const errors: GuideFieldError[] = [];
  if (!isGuidePlatform(input.platform)) {
    errors.push("PLATFORM");
  }
  const name = input.displayName.trim();
  if (name.length < GUIDE_DISPLAY_NAME_MIN || name.length > GUIDE_DISPLAY_NAME_MAX) {
    errors.push("DISPLAY_NAME");
  }
  const icon = input.iconEmoji.trim();
  if (icon.length === 0 || icon.length > GUIDE_ICON_EMOJI_MAX) {
    errors.push("ICON");
  }
  const primary = validateHttpsDownloadUrl(input.primaryDownloadUrl);
  if (!primary.ok) {
    errors.push("PRIMARY_URL");
  }
  let altUrl: string | null = null;
  if (input.alternateDownloadUrl !== null && input.alternateDownloadUrl.trim() !== "") {
    const alt = validateHttpsDownloadUrl(input.alternateDownloadUrl);
    if (!alt.ok) {
      errors.push("ALT_URL");
    } else {
      altUrl = alt.url;
    }
  }
  const instructions = input.instructions.trim();
  if (instructions.length < GUIDE_INSTRUCTIONS_MIN || instructions.length > GUIDE_INSTRUCTIONS_MAX) {
    errors.push("INSTRUCTIONS");
  }
  const troubleshooting = input.troubleshooting.trim();
  if (troubleshooting.length > GUIDE_TROUBLESHOOTING_MAX) {
    errors.push("TROUBLESHOOTING");
  }
  if (
    !Number.isInteger(input.sortOrder) ||
    input.sortOrder < GUIDE_SORT_ORDER_MIN ||
    input.sortOrder > GUIDE_SORT_ORDER_MAX
  ) {
    errors.push("SORT_ORDER");
  }
  if (!input.supportsSubscription && !input.supportsQr && !input.supportsIndividualConfigs) {
    errors.push("NO_METHOD");
  }
  if (errors.length > 0 || !primary.ok || !isGuidePlatform(input.platform)) {
    return { ok: false, errors: errors.length > 0 ? errors : ["PRIMARY_URL"] };
  }
  return {
    ok: true,
    value: {
      ...input,
      platform: input.platform,
      displayName: name,
      iconEmoji: icon,
      primaryDownloadUrl: primary.url,
      alternateDownloadUrl: altUrl,
      instructions,
      troubleshooting,
    },
  };
}

/** Reasons an app is NOT eligible to be ACTIVE (used by readiness + the enable
 * gate). Empty array = the app is fully valid. Reason codes only, no content. */
export function guideAppInvalidReasons(app: ConnectionGuideApp): GuideFieldError[] {
  const result = validateGuideAppInput({
    platform: app.platform,
    displayName: app.displayName,
    iconEmoji: app.iconEmoji,
    primaryDownloadUrl: app.primaryDownloadUrl,
    alternateDownloadUrl: app.alternateDownloadUrl,
    supportsSubscription: app.supportsSubscription,
    supportsQr: app.supportsQr,
    supportsIndividualConfigs: app.supportsIndividualConfigs,
    instructions: app.instructions,
    troubleshooting: app.troubleshooting,
    sortOrder: app.sortOrder,
  });
  return result.ok ? [] : result.errors;
}

// --- readiness gate ----------------------------------------------------------
export interface GuideReadiness {
  ready: boolean;
  masterEnabled: boolean;
  totalCount: number;
  activeCount: number;
  archivedCount: number;
  invalidActiveCount: number;
  activePlatformCount: number;
  /** Safe display names + reason codes of active-but-invalid apps. */
  invalidApps: Array<{ slug: string; displayName: string; reasons: GuideFieldError[] }>;
  duplicateSlugs: string[];
  lastUpdatedAt: Date | null;
}

/**
 * Evaluates whether the system MAY be enabled. Requires >=1 active app, every
 * active app fully valid, and no duplicate active slug. Reads fresh (uncached).
 */
export async function evaluateGuideReadiness(): Promise<GuideReadiness> {
  const masterEnabled = await isConnectionGuidesEnabled();
  const all = await prisma.connectionGuideApp.findMany({ where: { archivedAt: null } });
  const archivedCount = await prisma.connectionGuideApp.count({ where: { archivedAt: { not: null } } });
  const active = all.filter((a) => a.isActive);
  const invalidApps = active
    .map((a) => ({ slug: a.slug, displayName: a.displayName, reasons: guideAppInvalidReasons(a) }))
    .filter((x) => x.reasons.length > 0);
  const seen = new Set<string>();
  const duplicateSlugs: string[] = [];
  for (const a of active) {
    if (seen.has(a.slug)) {
      duplicateSlugs.push(a.slug);
    }
    seen.add(a.slug);
  }
  const activePlatforms = new Set(active.filter((a) => a.isActive).map((a) => a.platform));
  const lastUpdatedAt = all.reduce<Date | null>(
    (acc, a) => (acc === null || a.updatedAt > acc ? a.updatedAt : acc),
    null,
  );
  const ready = active.length > 0 && invalidApps.length === 0 && duplicateSlugs.length === 0;
  return {
    ready,
    masterEnabled,
    totalCount: all.length,
    activeCount: active.length,
    archivedCount,
    invalidActiveCount: invalidApps.length,
    activePlatformCount: activePlatforms.size,
    invalidApps,
    duplicateSlugs,
    lastUpdatedAt,
  };
}

// --- admin reads -------------------------------------------------------------
/** All non-archived apps for a platform (admin list, fresh, includes inactive). */
export async function listGuideAppsForPlatformAdmin(
  platform: GuidePlatform,
): Promise<ConnectionGuideApp[]> {
  return prisma.connectionGuideApp.findMany({
    where: { platform, archivedAt: null },
    orderBy: [{ sortOrder: "asc" }, { displayName: "asc" }],
  });
}

/** Per-platform active/total counts for the admin landing. */
export async function guideAdminPlatformCounts(): Promise<
  Record<GuidePlatform, { total: number; active: number }>
> {
  const rows = await prisma.connectionGuideApp.findMany({
    where: { archivedAt: null },
    select: { platform: true, isActive: true },
  });
  const out = {} as Record<GuidePlatform, { total: number; active: number }>;
  for (const p of GUIDE_PLATFORMS) {
    out[p] = { total: 0, active: 0 };
  }
  for (const r of rows) {
    if (isGuidePlatform(r.platform)) {
      out[r.platform].total += 1;
      if (r.isActive) {
        out[r.platform].active += 1;
      }
    }
  }
  return out;
}

/** A single non-archived app by 8-char short id (admin), ambiguity-safe. */
export async function getGuideAppByShortIdAdmin(shortId: string): Promise<ConnectionGuideApp | null> {
  if (!/^[0-9a-f-]{4,36}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.connectionGuideApp.findMany({
    where: { id: { startsWith: shortId } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

// --- admin mutations (allowlisted fields only; each invalidates the cache) ----
async function nextSortOrder(platform: GuidePlatform): Promise<number> {
  const top = await prisma.connectionGuideApp.findFirst({
    where: { platform, archivedAt: null },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  return Math.min(GUIDE_SORT_ORDER_MAX, (top?.sortOrder ?? -1) + 1);
}

/** Builds a stable, unique slug from the display name (never changes on edit).
 * Reserves room for the numeric disambiguation suffix so a max-length base can
 * never truncate the suffix away (which would loop forever colliding). */
async function uniqueSlug(displayName: string): Promise<string> {
  const base = slugifyGuideName(displayName);
  for (let i = 0; i < 500; i += 1) {
    const suffix = i === 0 ? "" : `-${i + 1}`;
    const trimmedBase = base.slice(0, GUIDE_SLUG_MAX - suffix.length).replace(/-+$/g, "");
    const candidate = `${trimmedBase}${suffix}`;
    if (isValidGuideSlug(candidate)) {
      const clash = await prisma.connectionGuideApp.findUnique({ where: { slug: candidate } });
      if (clash === null) {
        return candidate;
      }
    }
  }
  // Extremely unlikely fallback: a time-based suffix, still bounded to the format.
  const suffix = `-${Date.now().toString(36)}`;
  return `${base.slice(0, GUIDE_SLUG_MAX - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

export async function createGuideApp(
  value: NormalizedGuideAppInput,
  adminId: string,
): Promise<ConnectionGuideApp> {
  const slug = await uniqueSlug(value.displayName);
  const sortOrder = value.sortOrder > 0 ? value.sortOrder : await nextSortOrder(value.platform);
  const app = await prisma.connectionGuideApp.create({
    data: {
      slug,
      platform: value.platform,
      displayName: value.displayName,
      iconEmoji: value.iconEmoji,
      primaryDownloadUrl: value.primaryDownloadUrl,
      alternateDownloadUrl: value.alternateDownloadUrl,
      supportsSubscription: value.supportsSubscription,
      supportsQr: value.supportsQr,
      supportsIndividualConfigs: value.supportsIndividualConfigs,
      instructions: value.instructions,
      troubleshooting: value.troubleshooting,
      sortOrder,
      isActive: false,
      updatedByAdminId: adminId,
    },
  });
  invalidateGuideCache();
  return app;
}

/** Updates ONLY the allowlisted editable fields (never slug/id/timestamps). */
export async function updateGuideAppFields(
  id: string,
  fields: Partial<
    Pick<
      ConnectionGuideApp,
      | "displayName"
      | "iconEmoji"
      | "primaryDownloadUrl"
      | "alternateDownloadUrl"
      | "supportsSubscription"
      | "supportsQr"
      | "supportsIndividualConfigs"
      | "instructions"
      | "troubleshooting"
      | "sortOrder"
      | "platform"
    >
  >,
  adminId: string,
): Promise<ConnectionGuideApp> {
  const app = await prisma.connectionGuideApp.update({
    where: { id },
    data: { ...fields, updatedByAdminId: adminId },
  });
  invalidateGuideCache();
  return app;
}

export async function setGuideAppActive(
  id: string,
  isActive: boolean,
  adminId: string,
): Promise<ConnectionGuideApp> {
  const app = await prisma.connectionGuideApp.update({
    where: { id },
    data: { isActive, updatedByAdminId: adminId },
  });
  invalidateGuideCache();
  return app;
}

/** Soft archive: hides from lists and deactivates, but the audited row survives. */
export async function archiveGuideApp(id: string, adminId: string): Promise<ConnectionGuideApp> {
  const app = await prisma.connectionGuideApp.update({
    where: { id },
    data: { isActive: false, archivedAt: new Date(), updatedByAdminId: adminId },
  });
  invalidateGuideCache();
  return app;
}

/** Moves an app one position up/down within its platform's display order.
 *
 * The displayed order is `(sortOrder ASC, displayName ASC)`, so a raw
 * strict-inequality swap on `sortOrder` alone breaks when two apps share a
 * `sortOrder` (it skips the true neighbor and swaps with one further away, or —
 * swapping equal values — appears to do nothing). Instead we load the ordered
 * list, find the app's index, swap it with the adjacent index, then renumber the
 * whole platform to a gap-free `0..n-1` sequence so the order becomes
 * deterministic regardless of any prior duplicate/gappy values. */
export async function moveGuideApp(
  id: string,
  direction: "up" | "down",
  adminId: string,
): Promise<boolean> {
  const app = await prisma.connectionGuideApp.findUnique({ where: { id } });
  if (app === null || app.archivedAt !== null || !isGuidePlatform(app.platform)) {
    return false;
  }
  const list = await prisma.connectionGuideApp.findMany({
    where: { platform: app.platform, archivedAt: null },
    // Same primary/secondary keys the admin+user lists use, plus a deterministic
    // id tiebreak so equal (sortOrder, displayName) pairs still order stably.
    orderBy: [{ sortOrder: "asc" }, { displayName: "asc" }, { id: "asc" }],
  });
  const idx = list.findIndex((a) => a.id === app.id);
  const target = direction === "up" ? idx - 1 : idx + 1;
  if (idx === -1 || target < 0 || target >= list.length) {
    return false;
  }
  const reordered = [...list];
  [reordered[idx], reordered[target]] = [reordered[target], reordered[idx]];
  const updates = reordered
    .map((a, i) => ({ a, i }))
    .filter(({ a, i }) => a.sortOrder !== i)
    .map(({ a, i }) =>
      prisma.connectionGuideApp.update({
        where: { id: a.id },
        data: { sortOrder: i, updatedByAdminId: adminId },
      }),
    );
  if (updates.length === 0) {
    return false;
  }
  await prisma.$transaction(updates);
  invalidateGuideCache();
  return true;
}

// --- master switch mutation --------------------------------------------------
export type GuideEnableOutcome =
  | { ok: true }
  | { ok: false; reason: "NOT_READY"; readiness: GuideReadiness };

/** Enables the system ONLY when the readiness gate passes. */
export async function enableConnectionGuides(): Promise<GuideEnableOutcome> {
  const readiness = await evaluateGuideReadiness();
  if (!readiness.ready) {
    return { ok: false, reason: "NOT_READY", readiness };
  }
  await setSetting(CONNECTION_GUIDES_ENABLED_KEY, "true", "BOOLEAN");
  return { ok: true };
}

/** Disables the system. Always available; never deletes configuration. */
export async function disableConnectionGuides(): Promise<void> {
  await setSetting(CONNECTION_GUIDES_ENABLED_KEY, "false", "BOOLEAN");
}
