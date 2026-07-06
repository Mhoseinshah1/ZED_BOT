import { createServer } from "node:http";

// Placeholder API service. Real endpoints will be added in later iterations;
// only the health check used by Docker and `zedbot doctor` lives here.

const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);
const host = "0.0.0.0";

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "api" }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
});

server.listen(port, host, () => {
  console.log(`ZED_BOT api service started on http://${host}:${port}`);
});

const shutdown = (signal: string): void => {
  console.log(`ZED_BOT api service received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  // Fallback in case in-flight connections keep the server open.
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
