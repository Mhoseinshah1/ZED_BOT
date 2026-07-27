import { errorMessage } from "@zedbot/shared";

/**
 * A short, scrubbed marker for why a notification send failed.
 *
 * Telegram error text can carry a chat id, a username or an echo of the message
 * — none of which belongs in a table an operator screenshots or pastes into a
 * ticket. The stored value is a code; the detail stays in the log, where
 * redaction already applies.
 *
 * It lives in its own module because both the immediate send (in the ticket
 * service) and the sweep (in the notification service) classify failures, and
 * the sweep already imports the ticket service — so putting it in either would
 * make the import cycle.
 */
export function supportNotificationErrorCode(err: unknown): string {
  const text = errorMessage(err).toLowerCase();
  if (text.includes("429") || text.includes("too many requests")) return "rate-limited";
  if (text.includes("403") || text.includes("blocked") || text.includes("forbidden")) {
    return "blocked-by-admin";
  }
  if (text.includes("chat not found")) return "chat-missing";
  if (text.includes("timeout") || text.includes("etimedout")) return "timeout";
  return "send-failed";
}
