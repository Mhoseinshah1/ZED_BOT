import type { PanelType } from "@zedbot/database";

/** In-progress "add panel" wizard state. */
export interface PanelAddState {
  step: "name" | "baseUrl" | "username" | "password" | "token";
  type: PanelType;
  name?: string;
  baseUrl?: string;
  username?: string;
}

/** Minimal per-user session state. Complex conversations arrive later. */
export interface SessionData {
  currentFlow: string | null;
  lastMenu: string | null;
  temp: {
    panelAdd?: PanelAddState;
    // Panel id being edited via a text-input step.
    editingPanelId?: string;
    // Field short-key being edited (from panel-fields registry).
    editingField?: string;
    // For credential edits ("password" | "token").
    editingCredential?: "password" | "token";
    [key: string]: unknown;
  };
}

export function initialSession(): SessionData {
  return { currentFlow: null, lastMenu: null, temp: {} };
}
