export { prisma, connectDatabase, disconnectDatabase } from "./client.js";

// Re-export the full generated client surface (model types, enums, Prisma
// namespace) so consumers never import from @prisma/client directly.
export * from "@prisma/client";
export {
  INITIAL_BUTTON_TEXTS,
  INITIAL_MESSAGE_TEMPLATES,
  type ButtonTextSeed,
  type MessageTemplateSeed,
} from "./seed-data.js";
