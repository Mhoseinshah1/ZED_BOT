export { prisma, connectDatabase, disconnectDatabase } from "./client.js";

// Re-export the full generated client surface (model types, enums, Prisma
// namespace) so consumers never import from @prisma/client directly.
export * from "@prisma/client";
