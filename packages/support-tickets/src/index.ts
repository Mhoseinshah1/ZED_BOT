// =============================================================================
// @zedbot/support-tickets — the support-ticket domain, without a transport.
//
// The bot adapts a Telegram update into these commands; the API adapts a JSON
// body into the same ones. Neither owns the rules. Nothing in this package
// imports grammY, Fastify, a keyboard or a Persian string: it decides outcomes
// and returns stable codes, and each transport renders those its own way.
// =============================================================================

export * from "./contract.js";
export * from "./tickets.js";
