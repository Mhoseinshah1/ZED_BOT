// =============================================================================
// The shutdown sequence, as a function instead of a closure in the entrypoint.
//
// It lives here for one reason: ORDER IS THE WHOLE CONTRACT, and order inside
// `index.ts` could only ever be asserted by reading the file as text. A test
// that greps for `stop()` appearing before `disconnectDatabase()` proves the
// two calls are written in that order — not that the first one FINISHED before
// the second one started, which is the property that actually matters. A
// stopped loop with a sweep still running is a sweep racing the disconnect.
//
// So the steps are injected and the sequence is executable. A test drives it
// with a sweep that has not resolved yet and watches what does NOT happen.
//
// EVERY STEP IS CONTAINED. Previously one try/catch wrapped the whole body, so
// a consumer that threw on stop skipped the database disconnect entirely — the
// last step is the one most worth reaching. Now a failing step is logged and
// the sequence continues, because there is no failure during teardown that is
// improved by leaving connections open.
// =============================================================================

/** The steps, in the only order they may run. */
export const SHUTDOWN_STEPS = [
  // 1. No NEW notification tick may begin. A tick starting now would claim
  //    rows that nothing in this process will settle.
  "stop-support-notification-ticks",
  // 2. Wait out the tick already running. It holds claims in SENDING; cutting
  //    its connection strands them until the next process's stale sweep.
  "drain-support-notifications",
  // 3. The ops log needs the database, so it goes before the disconnect.
  "write-stopping-log",
  // 4. Telegram and the queue consumers.
  "stop-bot",
  "stop-consumers",
  // 5. Last: nothing above can still need a connection.
  "disconnect-database",
] as const;

export type ShutdownStep = (typeof SHUTDOWN_STEPS)[number];

export interface ShutdownSteps {
  /** Synchronous on purpose: preventing new ticks must not itself await. */
  stopSupportNotificationTicks: () => void;
  drainSupportNotifications: () => Promise<void>;
  writeStoppingLog: () => Promise<void>;
  stopBot: () => Promise<void>;
  stopConsumers: () => Promise<void>;
  disconnectDatabase: () => Promise<void>;
}

export interface ShutdownReport {
  /** Steps that ran to completion, in the order they finished. */
  completed: ShutdownStep[];
  /** Steps that threw. Shutdown continued past every one of them. */
  failed: ShutdownStep[];
}

/**
 * Run the teardown in order, awaiting each step before starting the next.
 *
 * Never throws: the caller's next move is `process.exit`, and an exception
 * here would skip it.
 */
export async function runShutdownSequence(
  steps: ShutdownSteps,
  onStepError: (step: ShutdownStep, err: unknown) => void = () => {},
): Promise<ShutdownReport> {
  const runners: Record<ShutdownStep, () => void | Promise<void>> = {
    "stop-support-notification-ticks": steps.stopSupportNotificationTicks,
    "drain-support-notifications": steps.drainSupportNotifications,
    "write-stopping-log": steps.writeStoppingLog,
    "stop-bot": steps.stopBot,
    "stop-consumers": steps.stopConsumers,
    "disconnect-database": steps.disconnectDatabase,
  };

  const completed: ShutdownStep[] = [];
  const failed: ShutdownStep[] = [];
  for (const step of SHUTDOWN_STEPS) {
    try {
      // Awaited even for the synchronous step: `await undefined` is harmless,
      // and it makes "the next step does not start until this one is done"
      // true of every entry rather than most of them.
      await runners[step]();
      completed.push(step);
    } catch (err) {
      failed.push(step);
      onStepError(step, err);
    }
  }
  return { completed, failed };
}
