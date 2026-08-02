import { OrderStatus, prisma } from "@zedbot/database";
import {
  createLogger,
  errorMessage,
  getRedisOptions,
  MINIAPP_COMMERCE_JOB_NAMES,
  MINIAPP_COMMERCE_QUEUE_NAME,
} from "@zedbot/shared";
import { Worker, type Job } from "bullmq";
import { executePaidCommerceOrder } from "@zedbot/service-renewal";

import type { DeliverySendApi } from "./other-product-delivery.service.js";

const log = createLogger("bot:miniapp-consumer");

export interface MiniAppCommerceConsumer { stop: () => Promise<void> }

async function fulfillOrder(_api: DeliverySendApi, orderId: string): Promise<string> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
  if (order === null) return "order-missing";
  if (order.status !== OrderStatus.PAID) return "already-converged";
  const result = await executePaidCommerceOrder(order.id);
  if (!result.ok && result.classification === "UNCERTAIN_RECONCILIATION_REQUIRED") {
    throw new Error(result.code);
  }
  return result.classification.toLowerCase();
}

/** Durable, idempotent wallet-order follow-up. The shared executors own the
 * panel mutation; this Bot worker owns only Telegram delivery/notification. */
export function startMiniAppCommerceConsumer(api: DeliverySendApi): MiniAppCommerceConsumer | null {
  const options = getRedisOptions();
  if (options === null) {
    log.warn("redis not configured; miniapp commerce consumer not started");
    return null;
  }
  const worker = new Worker(
    MINIAPP_COMMERCE_QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== MINIAPP_COMMERCE_JOB_NAMES.FULFILL_ORDER) throw new Error("unknown miniapp commerce job");
      const orderId = typeof (job.data as Record<string, unknown>).orderId === "string"
        ? (job.data as Record<string, string>).orderId
        : "";
      return { outcome: await fulfillOrder(api, orderId) };
    },
    { connection: { host: options.host, port: options.port, password: options.password, maxRetriesPerRequest: null }, concurrency: 2 },
  );
  worker.on("failed", (_job, err) => log.warn("miniapp commerce job failed", { error: errorMessage(err) }));
  return { stop: async () => worker.close() };
}
