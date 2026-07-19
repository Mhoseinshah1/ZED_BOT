import {
  AUTO_RENEWAL_EXECUTE_QUEUE_NAME,
  AUTO_RENEWAL_JOB_NAMES,
  createLogger,
  errorMessage,
  getRedisOptions,
} from "@zedbot/shared";
import { Worker, type Job } from "bullmq";

import { executeAutoRenewalAttempt } from "./auto-renewal.service.js";
import type { DeliverySendApi } from "./other-product-delivery.service.js";

// =============================================================================
// Wallet auto-renewal EXECUTE consumer (Phase 1) — the bot process's ONLY
// BullMQ consumer. The worker discovers due mandates and PRODUCES one durable
// EXECUTE job per expiry cycle onto `service-auto-renewal-execute`; this Worker
// runs the wallet charge + in-place renewal here in the bot, co-located with the
// fulfillment dispatcher and the shared wallet settlement (the worker cannot
// import the bot). Every job is idempotent on the mandate+cycle key, so a
// duplicate delivery, a retry or a restart converges — never a double charge.
//
// Redis unconfigured → the consumer simply does not start (the whole feature is
// dormant by default anyway). Concurrency > 1 is safe: distinct services take
// distinct per-service renewal locks and the CAS attempt claim serialises the
// same attempt. Shutdown closes the Worker so an in-flight charge finishes.
// =============================================================================

const log = createLogger("bot:war-consumer");

export interface AutoRenewalConsumer {
  stop: () => Promise<void>;
}

/**
 * Starts the EXECUTE consumer. `api` is the bot's Telegram send surface (used
 * for the best-effort pre/post notices). Returns null when Redis is not
 * configured; a null return keeps the bot fully functional (feature dormant).
 */
export function startAutoRenewalConsumer(api: DeliverySendApi): AutoRenewalConsumer | null {
  const options = getRedisOptions();
  if (options === null) {
    log.warn("redis not configured; wallet auto-renewal execute consumer not started");
    return null;
  }
  // BullMQ requires maxRetriesPerRequest: null on its connections.
  const connection = {
    host: options.host,
    port: options.port,
    password: options.password,
    maxRetriesPerRequest: null,
  };

  const worker = new Worker(
    AUTO_RENEWAL_EXECUTE_QUEUE_NAME,
    async (job: Job): Promise<Record<string, unknown>> => {
      if (job.name !== AUTO_RENEWAL_JOB_NAMES.EXECUTE_WALLET_AUTO_RENEWAL) {
        throw new Error(`unknown job: ${job.name}`);
      }
      const attemptId =
        typeof job.data?.attemptId === "string" ? (job.data.attemptId as string) : "";
      if (attemptId === "") {
        return { skipped: "no-attempt-id" };
      }
      const result = await executeAutoRenewalAttempt(api, attemptId);
      return result as unknown as Record<string, unknown>;
    },
    { connection, concurrency: 3 },
  );

  worker.on("ready", () => {
    log.info("wallet auto-renewal execute consumer ready");
  });
  worker.on("failed", (job, err) => {
    log.error("auto-renewal execute job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error: errorMessage(err),
    });
  });
  worker.on("error", (err) => {
    log.warn("auto-renewal execute consumer redis error", { error: errorMessage(err) });
  });

  return {
    stop: async (): Promise<void> => {
      await worker.close().catch(() => undefined);
    },
  };
}
