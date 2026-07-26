import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import { applyTelegramTheme } from "./telegram";

// Theme first, so the first paint is already in Telegram's colours rather than
// flashing the light-mode default at someone using a dark client.
applyTelegramTheme();

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
