// =============================================================================
// @zedbot/service-renewal — the transport-independent renewal domain.
//
// Imported by BOTH the Telegram Bot and the Mini App API so there is exactly
// one renewal authority. Nothing in this package renders, and nothing in it
// knows which transport called it.
// =============================================================================

export {
  isRenewalIdempotencyKey,
  isRenewalOptionPublicId,
  MINIAPP_WALLET_RENEWAL_ENABLED_DEFAULT,
  MINIAPP_WALLET_RENEWAL_ENABLED_KEY,
  RENEWAL_CONFIRM_BODY_LIMIT_BYTES,
  RENEWAL_IDEMPOTENCY_KEY_MAX_LENGTH,
  RENEWAL_IDEMPOTENCY_KEY_PATTERN,
  RENEWAL_OPTION_PUBLIC_ID_LENGTH,
  RENEWAL_OPTION_PUBLIC_ID_PATTERN,
  RENEWAL_ORIGINS,
  RENEWAL_QUOTE_TTL_SECONDS,
  RENEWAL_RESULT_CODES,
  RENEWAL_SETTLED_CODES,
  renewalCodeIsSettled,
  renewalOptionPublicId,
  type RenewalOrigin,
  type RenewalResultCode,
} from "./contract.js";

export {
  isMiniAppWalletRenewalEnabled,
  setMiniAppWalletRenewalEnabled,
} from "./rollout.js";

export {
  classifyXuiRemoteModel,
  panelCapabilities,
  panelHasCredentials,
  panelOperationAvailable,
  panelSupportsOperation,
  panelTypesSupporting,
  resolveXuiAuthMode,
  resolveXuiVariant,
  serviceSupportsGlobalLifecycle,
  SUPPORTED_XUI_AUTH_MODES,
  SUPPORTED_XUI_VARIANTS,
  type XuiRemoteModel,
} from "./panel-capability.js";
