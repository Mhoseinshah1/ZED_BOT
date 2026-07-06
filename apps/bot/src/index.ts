// Placeholder bot service. The real Telegram bot (menus, sales flows, admin
// commands) will be implemented in later iterations.

console.log("ZED_BOT bot service started");
console.log("Placeholder service - Telegram bot features will be added in a later step.");

const HEARTBEAT_INTERVAL_MS = 60_000;

// Keeps the placeholder process alive until the real bot loop lands.
const heartbeat = setInterval(() => {}, HEARTBEAT_INTERVAL_MS);

const shutdown = (signal: string): void => {
  console.log(`ZED_BOT bot service received ${signal}, shutting down`);
  clearInterval(heartbeat);
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
