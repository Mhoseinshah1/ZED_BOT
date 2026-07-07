export { prisma, connectDatabase, disconnectDatabase } from "./client.js";

// Re-export the generated enums and model types so consumers never import
// from @prisma/client directly.
export { AdminRole, SettingType, ActorType, Prisma } from "@prisma/client";
export type { User, Admin, Setting, AuditLog, PrismaClient } from "@prisma/client";
