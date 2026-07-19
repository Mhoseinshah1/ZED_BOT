import {
  STARS_SUBSCRIPTION_EXECUTE_JOB_NAMES,
  STARS_SUBSCRIPTION_EXECUTE_QUEUE_NAME,
  createLogger,
  errorMessage,
  getRedisOptions,
} from "@zedbot/shared";
import { Worker, type Job } from "bullmq";

import type { DeliverySendApi } from "./other-product-delivery.service.js";
import {
  reconcileStarsChargeById,
  settleRecoveredStarsCharge,
} from "./stars-subscription-settlement.service.js";
import {
  refundStarsSubscriptionCharge,
  type StarsBotApi,
} from "./stars-subscription-refund.service.js";

// =============================================================================
// Telegram Stars subscription EXECUTE consumer (Phase 2.1). The worker OWNS
// discovery/scheduling but produces money-touching work onto
// `stars-subscription-execute`; this bot-side Worker performs it with the bot's
// grammY Api + the existing settlement/refund services (the worker cannot import
// the bot). Every job is idempotent on the Telegram charge id, so a duplicate
// delivery, a retry or a restart converges — never a double renewal or refund.
//
// Redis unconfigured → the consumer does not start (the feature is dormant by
// default anyway). Concurrency > 1 is safe: the unique charge id + CAS transitions
// serialise the same charge. Shutdown closes the Worker so in-flight work finishes.
// =============================================================================

const log = createLogger("bot:stars-sub-consumer");

export interface StarsSubscriptionConsumer {
  stop: () => Promise<void>;
}

function stringField(data: unknown, key: string): string {
  if (typeof data === "object" && data !== null && typeof (data as Record<string, unknown>)[key] === "string") {
    return (data as Record<string, string>)[key];
  }
  return "";
}

function numberField(data: unknown, key: string): number {
  if (typeof data === "object" && data !== null && typeof (data as Record<string, unknown>)[key] === "number") {
    return (data as Record<string, number>)[key];
  }
  return NaN;
}

function boolField(data: unknown, key: string): boolean {
  return typeof data === "object" && data !== null && (data as Record<string, unknown>)[key] === true;
}

/** Starts the execute consumer. Returns null when Redis is not configured. */
export function startStarsSubscriptionConsumer(api: DeliverySendApi): StarsSubscriptionConsumer | null {
  const options = getRedisOptions();
  if (options === null) {
    log.warn("redis not configured; stars subscription execute consumer not started");
    return null;
  }
  const connection = {
    host: options.host,
    port: options.port,
    password: options.password,
    maxRetriesPerRequest: null,
  };

  const worker = new Worker(
    STARS_SUBSCRIPTION_EXECUTE_QUEUE_NAME,
    async (job: Job): Promise<Record<string, unknown>> => {
      if (job.name === STARS_SUBSCRIPTION_EXECUTE_JOB_NAMES.SETTLE_RECOVERED_CHARGE) {
        const subscriptionId = stringField(job.data, "subscriptionId");
        const telegramPaymentChargeId = stringField(job.data, "telegramPaymentChargeId");
        const starsAmount = numberField(job.data, "starsAmount");
        const telegramTransactionAtSec = numberField(job.data, "telegramTransactionAtSec");
        if (subscriptionId === "" || telegramPaymentChargeId === "" || Number.isNaN(starsAmount)) {
          return { skipped: "bad-job-data" };
        }
        const result = await settleRecoveredStarsCharge(api, {
          subscriptionId,
          telegramPaymentChargeId,
          starsAmount,
          telegramTransactionAtSec: Number.isNaN(telegramTransactionAtSec)
            ? Math.floor(Date.now() / 1000)
            : telegramTransactionAtSec,
          isFirstRecurring: boolField(job.data, "isFirstRecurring"),
        });
        if (result.kind === "refund-required") {
          await refundStarsSubscriptionCharge(api as unknown as StarsBotApi, result.chargeId);
        }
        return result as unknown as Record<string, unknown>;
      }
      if (job.name === STARS_SUBSCRIPTION_EXECUTE_JOB_NAMES.RETRY_REFUND) {
        const chargeId = stringField(job.data, "chargeId");
        if (chargeId === "") return { skipped: "no-charge-id" };
        const outcome = await refundStarsSubscriptionCharge(api as unknown as StarsBotApi, chargeId);
        return outcome as unknown as Record<string, unknown>;
      }
      if (job.name === STARS_SUBSCRIPTION_EXECUTE_JOB_NAMES.RECONCILE_CHARGE) {
        const chargeId = stringField(job.data, "chargeId");
        if (chargeId === "") return { skipped: "no-charge-id" };
        const result = await reconcileStarsChargeById(api, chargeId);
        if (result.kind === "refund-required") {
          await refundStarsSubscriptionCharge(api as unknown as StarsBotApi, result.chargeId);
        }
        return result as unknown as Record<string, unknown>;
      }
      throw new Error(`unknown job: ${job.name}`);
    },
    { connection, concurrency: 3 },
  );

  worker.on("ready", () => log.info("stars subscription execute consumer ready"));
  worker.on("failed", (job, err) => {
    log.error("stars subscription execute job failed", {
      jobName: job?.name,
      attemptsMade: job?.attemptsMade,
      error: errorMessage(err),
    });
  });
  worker.on("error", (err) => log.warn("stars subscription execute consumer redis error", { error: errorMessage(err) }));

  return {
    stop: async (): Promise<void> => {
      await worker.close().catch(() => undefined);
    },
  };
}
