// Compatibility seam: the distributed lock is transport-independent and is
// owned by @zedbot/service-renewal. Existing Bot imports intentionally remain
// stable while the API/worker can use the same implementation.
export {
  acquireServiceLock,
  checkAndArmCooldown,
  clearCooldown,
  isLockBackendAvailable,
  RECONCILE_LOCK_WAIT_MS,
  resetServiceLockClientForTests,
  SERVICE_LOCK_BUSY_TEXT,
  SERVICE_LOCK_LOST_TEXT,
  SERVICE_LOCK_TTL_MS,
  SERVICE_LOCK_UNAVAILABLE_TEXT,
  SERVICE_LOCK_WAIT_MS,
  serviceDiagnosticsCooldownKey,
  serviceOperationLockKey,
  serviceProvisioningLockKey,
  type CooldownGate,
  type ServiceLock,
  type ServiceLockAcquisition,
} from "@zedbot/service-renewal";
