/** Reads an env var and throws a clear error when it is missing or empty. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. Add it to /opt/zedbot/app/.env and restart (zedbot restart).`,
    );
  }
  return value.trim();
}

/** Reads an env var, falling back to a default when missing or empty. */
export function optionalEnv(name: string, fallback = ""): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return value.trim();
}

/** Reads an integer env var; throws when set to something non-numeric. */
export function intEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got a non-numeric value.`);
  }
  return value;
}

/** Reads a boolean env var ("true"/"1"/"yes" are truthy, case-insensitive). */
export function boolEnv(name: string, fallback: boolean): boolean {
  const raw = optionalEnv(name).toLowerCase();
  if (raw === "") {
    return fallback;
  }
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Parses a comma-separated list of Telegram user IDs (as used by
 * ADMIN_TELEGRAM_IDS). Invalid entries are skipped.
 */
export function parseTelegramIds(raw: string | undefined): bigint[] {
  if (raw === undefined) {
    return [];
  }
  const ids: bigint[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (/^\d+$/.test(trimmed)) {
      ids.push(BigInt(trimmed));
    }
  }
  return ids;
}

export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
}

/**
 * Builds Redis connection options from REDIS_URL when set, otherwise from
 * REDIS_HOST / REDIS_PORT / REDIS_PASSWORD. Returns null when nothing is
 * configured.
 */
export function getRedisOptions(): RedisConnectionOptions | null {
  const url = optionalEnv("REDIS_URL");
  if (url !== "") {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.hostname,
        port: parsed.port === "" ? 6379 : Number.parseInt(parsed.port, 10),
        password: parsed.password === "" ? undefined : decodeURIComponent(parsed.password),
      };
    } catch {
      throw new Error("REDIS_URL is set but is not a valid URL.");
    }
  }
  const host = optionalEnv("REDIS_HOST");
  if (host === "") {
    return null;
  }
  const password = optionalEnv("REDIS_PASSWORD");
  return {
    host,
    port: intEnv("REDIS_PORT", 6379),
    password: password === "" ? undefined : password,
  };
}
