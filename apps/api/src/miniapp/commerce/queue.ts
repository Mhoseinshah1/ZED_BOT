// =============================================================================
// Follow-up queue producer (miniapp §11/§18).
//
// Mini-App-initiated settlements enqueue ONE durable follow-up job the bot
// consumes to fulfil a wallet-paid order. Enqueueing is deliberately
// BEST-EFFORT: the settlement has already
// committed, the downstream executors are idempotent, and the bot's sweeps
// remain the recovery path — so a Redis outage degrades follow-up latency,
// never correctness, and never fails the user's request.
// =============================================================================
import {
  createLogger,
  errorMessage,
  getRedisOptions,
  MINIAPP_COMMERCE_JOB_NAMES,
  MINIAPP_COMMERCE_QUEUE_NAME,
  type MiniAppCommerceJobName,
} from "@zedbot/shared";
import { Queue } from "bullmq";

const logger = createLogger("api");

let queue: Queue | null | undefined;

function commerceQueue(): Queue | null {
  if (queue !== undefined) {
    return queue;
  }
  const options = getRedisOptions();
  if (options === null) {
    logger.warn(
      "redis not configured; miniapp commerce follow-up jobs fall back to the bot sweeps",
    );
    queue = null;
    return queue;
  }
  queue = new Queue(MINIAPP_COMMERCE_QUEUE_NAME, {
    connection: {
      host: options.host,
      port: options.port,
      password: options.password,
      maxRetriesPerRequest: null,
    },
  });
  return queue;
}

export type CommerceFollowUp =
  { name: typeof MINIAPP_COMMERCE_JOB_NAMES.FULFILL_ORDER; orderId: string };

/** Fire-and-forget; never throws into a settlement response. */
export async function enqueueCommerceFollowUp(job: CommerceFollowUp): Promise<void> {
  try {
    const target = commerceQueue();
    if (target === null) {
      return;
    }
    const { name, ...data } = job;
    await target.add(name as MiniAppCommerceJobName, data, {
      // A panel timeout may mean the remote mutation landed. Never let BullMQ
      // blindly execute that mutation again; the reconciliation sweep reads
      // panel truth and is the only safe follow-up for uncertain outcomes.
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  } catch (err) {
    // The sweeps own recovery; this is only a latency loss.
    logger.warn("miniapp commerce follow-up enqueue failed", { error: errorMessage(err) });
  }
}

/** Test/shutdown hook. */
export async function closeCommerceQueue(): Promise<void> {
  if (queue !== undefined && queue !== null) {
    await queue.close();
  }
  queue = undefined;
}
