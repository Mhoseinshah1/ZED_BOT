// =============================================================================
// @zedbot/service-renewal — the transport-independent renewal domain.
//
// Imported by BOTH the Telegram Bot and the Mini App API so there is exactly
// one renewal authority. Nothing in this package renders, and nothing in it
// knows which transport called it.
// =============================================================================

export {
  COMMERCE_RESULT_CODES,
  COMMERCE_SETTLED_CODES,
  commerceCodeIsSettled,
  isCommerceResultCode,
  isRenewalIdempotencyKey,
  isRenewalOptionPublicId,
  isServiceOperation,
  MINIAPP_COMMERCE_BROWSE_ENABLED_KEY,
  MINIAPP_COMMERCE_CHECKOUT_ENABLED_KEY,
  MINIAPP_COMMERCE_ROLLOUT_KEYS,
  MINIAPP_WALLET_ADDONS_ENABLED_KEY,
  MINIAPP_WALLET_PURCHASE_ENABLED_KEY,
  MINIAPP_WALLET_RENEWAL_ENABLED_DEFAULT,
  MINIAPP_WALLET_RENEWAL_ENABLED_KEY,
  RENEWAL_CONFIRM_BODY_LIMIT_BYTES,
  RENEWAL_IDEMPOTENCY_KEY_MAX_LENGTH,
  RENEWAL_IDEMPOTENCY_KEY_PATTERN,
  RENEWAL_OPTION_PUBLIC_ID_LENGTH,
  RENEWAL_OPTION_PUBLIC_ID_PATTERN,
  RENEWAL_ORIGINS,
  RENEWAL_QUOTE_TTL_SECONDS,
  SERVICE_OPERATIONS,
  renewalOptionPublicId,
  type CommerceResultCode,
  type MiniAppCommerceRolloutKey,
  type RenewalOrigin,
  type ServiceOperation,
} from "./contract.js";

export {
  isMiniAppRolloutEnabled,
  isMiniAppWalletRenewalEnabled,
  MINIAPP_COMMERCE_ROLLOUT_DEFAULT,
  readMiniAppRolloutState,
  setMiniAppRolloutEnabled,
  setMiniAppWalletRenewalEnabled,
} from "./rollout.js";

export {
  groupMatches,
  isPanelSellable,
  isProductStructurallySellable,
  isProductVisible,
  panelConfigProblem,
  parsePanelInboundIds,
  resolveProductInboundIds,
  type PanelConfigProblem,
  type ProductInboundResolution,
  type ProductWithRelations,
} from "./catalog.js";

export {
  extraTimePackages,
  extraVolumePackages,
  isExtraTimePackageValid,
  isExtraVolumePackageValid,
  isOperationOptionValid,
  isOptionPublicId,
  isRenewalPlanValid,
  listServiceOperationOptions,
  OPTION_PUBLIC_ID_LENGTH,
  OPTION_PUBLIC_ID_PATTERN,
  operationCapability,
  operationProductsForPanel,
  operationRolloutKey,
  optionPublicId,
  renewalPlansForPanel,
  resolveServiceOperationOption,
  serviceEligibleForOperation,
  toOptionDto,
  type OperationTargetDto,
  type OptionListArgs,
  type OptionListResult,
  type OptionResolution,
  type OptionResolveArgs,
  type ServiceOperationOptionDto,
} from "./options.js";

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

export {
  OPERABLE_SERVICE_STATUSES,
  resolveOwnedService,
  resolveOwnedServiceForUser,
  servicePublicId,
  type OwnedService,
} from "./resolve-service.js";
