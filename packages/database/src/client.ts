import { PrismaClient } from "@prisma/client";

// One PrismaClient per process. The globalThis cache also protects dev-mode
// hot reloads (tsx watch) from leaking connection pools.
const globalForPrisma = globalThis as typeof globalThis & { __zedbotPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__zedbotPrisma ?? new PrismaClient();
globalForPrisma.__zedbotPrisma = prisma;

/** Opens the database connection eagerly (Prisma otherwise connects lazily). */
export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
}

/** Closes the database connection pool. Call during graceful shutdown. */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
