/** Minimal per-user session state. Complex conversations arrive in later phases. */
export interface SessionData {
  currentFlow: string | null;
  lastMenu: string | null;
  temp: Record<string, unknown>;
}

export function initialSession(): SessionData {
  return { currentFlow: null, lastMenu: null, temp: {} };
}
