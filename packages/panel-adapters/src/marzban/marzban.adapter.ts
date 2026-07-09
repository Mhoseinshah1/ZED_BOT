import type { PanelAdapter } from "../core/panel-adapter.interface.js";
import type {
  CreateServiceAccountInput,
  CreateServiceAccountResult,
  GetServiceAccountInput,
  GetServiceAccountResult,
  NormalizedAccountStatus,
  PanelHealthResult,
} from "../core/panel.types.js";
import { MarzbanClient } from "./marzban.client.js";
import type { MarzbanUser } from "./marzban.types.js";

const RESET_STRATEGIES = new Set(["no_reset", "day", "week", "month", "year"]);

/** Per-user secrets that must NOT be copied from a template user's proxies. */
const PER_USER_PROXY_SECRETS = new Set(["id", "password"]);

function resolveResetStrategy(input: CreateServiceAccountInput): string {
  const explicit = input.dataLimitResetStrategy?.toLowerCase();
  if (explicit !== undefined && RESET_STRATEGIES.has(explicit)) {
    return explicit;
  }
  const cycle = input.trafficResetCycle?.toLowerCase();
  if (cycle !== undefined && RESET_STRATEGIES.has(cycle)) {
    return cycle;
  }
  return "no_reset";
}

/** Absolutizes Marzban's (often relative) subscription_url. */
function resolveSubscriptionUrl(url: string | undefined, base: string): string | undefined {
  if (url === undefined || url === "") {
    return undefined;
  }
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `${base.replace(/\/+$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
}

const STATUS_MAP: Record<string, NormalizedAccountStatus> = {
  active: "active",
  disabled: "disabled",
  limited: "limited",
  expired: "expired",
};

/** Marzban status string -> normalized status ("unknown" keeps caller state). */
function normalizeStatus(status: string | undefined): NormalizedAccountStatus {
  return STATUS_MAP[status?.toLowerCase() ?? ""] ?? "unknown";
}

/** Defensive timestamp parse; undefined when missing or unparseable. */
function parseTimestamp(value: string | null | undefined): Date | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function nonNegativeBigInt(value: number): bigint {
  return BigInt(Math.max(0, Math.trunc(value)));
}

function toResult(user: MarzbanUser, subscriptionBase: string): CreateServiceAccountResult {
  const links = Array.isArray(user.links)
    ? user.links.filter((l): l is string => typeof l === "string" && l !== "")
    : [];
  return {
    ok: true,
    username: user.username,
    subscriptionUrl: resolveSubscriptionUrl(user.subscription_url, subscriptionBase),
    ...(links.length > 0 ? { configLinks: links } : {}),
  };
}

/**
 * Marzban panel adapter. Phase 4: connection testing. Phase 9: minimal user
 * creation via the documented POST /api/user endpoint, copying protocol/
 * inbound selection from a configured template user (per-user secrets like
 * proxy id/password are stripped so Marzban generates fresh ones).
 */
export class MarzbanAdapter implements PanelAdapter {
  readonly name = "marzban" as const;

  constructor(readonly client: MarzbanClient) {}

  async testConnection(): Promise<PanelHealthResult> {
    return this.client.authenticate();
  }

  async createServiceAccount(
    input: CreateServiceAccountInput,
  ): Promise<CreateServiceAccountResult> {
    const templateUsername = input.templateUsername?.trim() ?? "";
    if (templateUsername === "") {
      // Proxies/inbounds must come from operator configuration - never guessed.
      return { ok: false, errorMessage: "Marzban template/inbound settings are not configured." };
    }

    const auth = await this.client.getToken();
    if (!auth.ok || auth.token === undefined) {
      return { ok: false, errorMessage: `Marzban authentication failed: ${auth.message}` };
    }

    const template = await this.client.getUser(auth.token, templateUsername);
    if (!template.ok || template.user === undefined) {
      return {
        ok: false,
        errorMessage: `Marzban template user "${templateUsername}" is not readable: ${template.message}`,
      };
    }
    const templateProxies = template.user.proxies ?? {};
    const protocols = Object.keys(templateProxies);
    if (protocols.length === 0) {
      return {
        ok: false,
        errorMessage: `Marzban template user "${templateUsername}" has no proxies configured.`,
      };
    }
    // Copy protocol settings minus per-user secrets; Marzban generates new ones.
    const proxies: Record<string, Record<string, unknown>> = {};
    for (const protocol of protocols) {
      const settings = templateProxies[protocol] ?? {};
      proxies[protocol] = Object.fromEntries(
        Object.entries(settings).filter(([key]) => !PER_USER_PROXY_SECRETS.has(key)),
      );
    }

    const subscriptionBase =
      input.subscriptionBaseUrl !== null &&
      input.subscriptionBaseUrl !== undefined &&
      input.subscriptionBaseUrl !== ""
        ? input.subscriptionBaseUrl
        : this.client.credentials.baseUrl;

    const created = await this.client.createUser(auth.token, {
      username: input.username,
      proxies,
      inbounds: template.user.inbounds ?? {},
      data_limit: input.volumeBytes === null ? 0 : Number(input.volumeBytes),
      data_limit_reset_strategy: resolveResetStrategy(input),
      expire: input.expiresAt === null ? 0 : Math.floor(input.expiresAt.getTime() / 1000),
      status: "active",
      note: input.note ?? "",
    });
    if (created.ok && created.user !== undefined) {
      return toResult(created.user, subscriptionBase);
    }

    // 409 = username already exists. Usernames are deterministic per order,
    // so this means a previous attempt created the account but the caller
    // crashed before recording it - recover it instead of failing.
    if (created.status === 409) {
      const existing = await this.client.getUser(auth.token, input.username);
      if (existing.ok && existing.user !== undefined) {
        return toResult(existing.user, subscriptionBase);
      }
    }

    return { ok: false, errorMessage: `Marzban create user failed: ${created.message}` };
  }

  /** Read-only sync via the documented GET /api/user/{username} endpoint. */
  async getServiceAccount(input: GetServiceAccountInput): Promise<GetServiceAccountResult> {
    const auth = await this.client.getToken();
    if (!auth.ok || auth.token === undefined) {
      return { ok: false, errorMessage: `Marzban authentication failed: ${auth.message}` };
    }
    const fetched = await this.client.getUser(auth.token, input.username);
    if (!fetched.ok || fetched.user === undefined) {
      if (fetched.status === 404) {
        return { ok: false, errorMessage: "Panel account not found." };
      }
      return { ok: false, errorMessage: `Marzban read user failed: ${fetched.message}` };
    }
    const user = fetched.user;

    const subscriptionBase =
      input.subscriptionBaseUrl !== null &&
      input.subscriptionBaseUrl !== undefined &&
      input.subscriptionBaseUrl !== ""
        ? input.subscriptionBaseUrl
        : this.client.credentials.baseUrl;

    // Every optional field is mapped defensively - missing panel fields are
    // OMITTED, never coerced to zero.
    const result: GetServiceAccountResult = {
      ok: true,
      username: user.username,
      status: normalizeStatus(user.status),
    };
    if (typeof user.used_traffic === "number") {
      result.usedBytes = nonNegativeBigInt(user.used_traffic);
    }
    if (user.data_limit !== undefined) {
      // 0/null = unlimited (explicit), >0 = the limit in bytes.
      result.totalBytes =
        typeof user.data_limit === "number" && user.data_limit > 0
          ? nonNegativeBigInt(user.data_limit)
          : null;
      if (result.totalBytes === null) {
        result.remainingBytes = null;
      } else {
        const used = result.usedBytes ?? 0n;
        result.remainingBytes = result.totalBytes > used ? result.totalBytes - used : 0n;
      }
    }
    if (user.expire !== undefined) {
      // 0/null = never expires (explicit).
      result.expiresAt =
        typeof user.expire === "number" && user.expire > 0 ? new Date(user.expire * 1000) : null;
    }
    const subscriptionUrl = resolveSubscriptionUrl(user.subscription_url, subscriptionBase);
    if (subscriptionUrl !== undefined) {
      result.subscriptionUrl = subscriptionUrl;
    }
    if (Array.isArray(user.links)) {
      const links = user.links.filter((l): l is string => typeof l === "string" && l !== "");
      if (links.length > 0) {
        result.configLinks = links;
      }
    }
    const lastConnected =
      parseTimestamp(user.online_at) ??
      parseTimestamp(user.last_online) ??
      parseTimestamp(user.last_connected_at);
    if (lastConnected !== undefined) {
      result.lastConnectedAt = lastConnected;
    }
    return result;
  }
}
