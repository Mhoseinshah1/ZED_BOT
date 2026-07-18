// The `{variable}` renderer now lives in @zedbot/shared so the worker's
// automated-notification delivery renders identically to the bot. This module
// re-exports it to keep every existing `../utils/template` import unchanged.
export {
  extractTemplateVariables,
  renderTemplate,
  renderTemplateOmitMissing,
} from "@zedbot/shared";
