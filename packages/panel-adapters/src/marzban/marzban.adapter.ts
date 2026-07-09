import type { PanelAdapter } from "../core/panel-adapter.interface.js";
import type {
  CreateServiceAccountInput,
  CreateServiceAccountResult,
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
}
