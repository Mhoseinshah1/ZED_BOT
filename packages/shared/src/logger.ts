type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function write(service: string, level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    service,
    message,
    ...(meta !== undefined && Object.keys(meta).length > 0 ? { meta } : {}),
  });
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

/** Minimal JSON-lines logger. Never log secrets (tokens, passwords). */
export function createLogger(service: string): Logger {
  return {
    debug: (message, meta) => write(service, "debug", message, meta),
    info: (message, meta) => write(service, "info", message, meta),
    warn: (message, meta) => write(service, "warn", message, meta),
    error: (message, meta) => write(service, "error", message, meta),
  };
}

/** Formats an unknown error for logging without dumping full objects. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
