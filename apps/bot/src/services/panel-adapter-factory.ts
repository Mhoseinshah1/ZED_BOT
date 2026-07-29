// Panel-adapter construction now lives in @zedbot/service-renewal so the Mini
// App API reaches panels through the same factory and secrets are decrypted in
// exactly one place. Re-exported here so every existing bot import is unchanged.
export {
  buildAdapterForPanel,
  normalizeSubscriptionBase,
  resolveXuiAuthMode,
  resolveXuiVariant,
  SUPPORTED_XUI_AUTH_MODES,
  SUPPORTED_XUI_VARIANTS,
} from "@zedbot/service-renewal";
