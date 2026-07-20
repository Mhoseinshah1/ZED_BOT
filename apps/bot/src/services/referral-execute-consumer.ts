import {
  REFERRAL_EXECUTE_HEARTBEAT_INTERVAL_MS,
  REFERRAL_EXECUTE_HEARTBEAT_KEY,
  REFERRAL_EXECUTE_HEARTBEAT_TTL_SECONDS,
  REFERRAL_EXECUTE_QUEUE_NAME,
  REFERRAL_JOB_NAMES,
  createLogger,
  errorMessage,
  getRedisOptions,
  referralCorrelationHash,
} from "@zedbot/shared";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";

import {
  creditReferralCommissionForOrder,
  recoverReferralCommissionDebt,
  reverseReferralCommissionForOrder,
} from "./referral-commission.service.js";

// =============================================================================
// Referral commission EXECUTE consumer (financial-safety phase) — the wallet
// mutations run HERE in the bot process, co-located with the wallet ledger (the
// worker cannot import the bot). The worker discovers work (missed credits,
// refunded orders, outstanding debts) and the live order-completion hook enqueues
// per-order credits; both land on `referral-commissions-execute` and this Worker
// runs the idempotent engine. Every job is idempotent (unique orderId / row-locked
// recovery), so a duplicate delivery, a retry or a restart converges — never a
// double credit and never an over-collected debt.
//
// Redis unconfigured → the consumer does not start (the whole feature is dormant
// by default anyway). Concurrency > 1 is safe: the credit claims the unique
// orderId and the reversal/recovery serialise on the row lock.
// =============================================================================

const log = createLogger("bot:referral-consumer");

export interface ReferralExecuteConsumer {
  stop: () => Promise<void>;
}

/** Starts the referral execute consumer. Returns null when Redis is not configured. */
export function startReferralExecuteConsumer(): ReferralExecuteConsumer | null {
  const options = getRedisOptions();
  if (options === null) {
    log.warn("redis not configured; referral commission execute consumer not started");
    return null;
  }
  const connection = {
    host: options.host,
    port: options.port,
    password: options.password,
    maxRetriesPerRequest: null,
  };

  const worker = new Worker(
    REFERRAL_EXECUTE_QUEUE_NAME,
    async (job: Job): Promise<Record<string, unknown>> => {
      const data = job.data as { orderId?: unknown; commissionId?: unknown };
      if (job.name === REFERRAL_JOB_NAMES.CREDIT_REFERRAL_COMMISSION) {
        const orderId = typeof data.orderId === "string" ? data.orderId : "";
        if (orderId === "") {
          return { skipped: "no-order-id" };
        }
        return (await creditReferralCommissionForOrder(orderId)) as unknown as Record<string, unknown>;
      }
      if (job.name === REFERRAL_JOB_NAMES.REVERSE_REFERRAL_COMMISSION) {
        const orderId = typeof data.orderId === "string" ? data.orderId : "";
        if (orderId === "") {
          return { skipped: "no-order-id" };
        }
        return (await reverseReferralCommissionForOrder(orderId)) as unknown as Record<string, unknown>;
      }
      if (job.name === REFERRAL_JOB_NAMES.RECOVER_REFERRAL_COMMISSION) {
        const commissionId = typeof data.commissionId === "string" ? data.commissionId : "";
        if (commissionId === "") {
          return { skipped: "no-commission-id" };
        }
        return (await recoverReferralCommissionDebt(commissionId)) as unknown as Record<string, unknown>;
      }
      throw new Error(`unknown job: ${job.name}`);
    },
    { connection, concurrency: 3 },
  );

  worker.on("ready", () => {
    log.info("referral commission execute consumer ready");
  });
  worker.on("failed", (job, err) => {
    // The BullMQ job id embeds the order/commission id (e.g. `ref-credit-<orderId>`),
    // so log a NON-REVERSIBLE correlation token instead of the raw id.
    log.error("referral execute job failed", {
      corr: job?.id ? referralCorrelationHash(job.id) : undefined,
      jobName: job?.name,
      attemptsMade: job?.attemptsMade,
      error: errorMessage(err),
    });
  });
  worker.on("error", (err) => {
    log.warn("referral execute consumer redis error", { error: errorMessage(err) });
  });

  // Liveness heartbeat: a dedicated client refreshes a TTL key so the activation
  // integrity gate can prove THIS consumer (the process that moves the wallet money)
  // is alive before the OWNER enables payouts. Counts/timestamps only — no ids.
  const heartbeatRedis = new Redis({
    host: options.host,
    port: options.port,
    password: options.password,
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  heartbeatRedis.on("error", (err) => log.debug("referral execute heartbeat redis error", { error: errorMessage(err) }));
  const writeHeartbeat = async (): Promise<void> => {
    try {
      await heartbeatRedis.set(
        REFERRAL_EXECUTE_HEARTBEAT_KEY,
        new Date().toISOString(),
        "EX",
        REFERRAL_EXECUTE_HEARTBEAT_TTL_SECONDS,
      );
    } catch (err) {
      log.debug("referral execute heartbeat write failed", { error: errorMessage(err) });
    }
  };
  void writeHeartbeat();
  const heartbeatTimer = setInterval(() => void writeHeartbeat(), REFERRAL_EXECUTE_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  return {
    stop: async (): Promise<void> => {
      clearInterval(heartbeatTimer);
      await worker.close().catch(() => undefined);
      await heartbeatRedis.quit().catch(() => undefined);
    },
  };
}
