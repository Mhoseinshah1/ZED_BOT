// Placeholder worker service. Background jobs (subscription expiry checks,
// notifications, panel synchronization) will be implemented in later
// iterations.

console.log("ZED_BOT worker service started");
console.log("Placeholder service - background jobs will be added in a later step.");

const HEARTBEAT_INTERVAL_MS = 60_000;

// Keeps the placeholder process alive until real job processing lands.
const heartbeat = setInterval(() => {}, HEARTBEAT_INTERVAL_MS);

const shutdown = (signal: string): void => {
  console.log(`ZED_BOT worker service received ${signal}, shutting down`);
  clearInterval(heartbeat);
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
