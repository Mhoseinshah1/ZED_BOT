-- Referral financial-safety hardening (additive): a new commission lifecycle
-- state for a refunded order whose credit could not be fully clawed back without
-- overdrawing the referrer's wallet. Isolated in its own migration because
-- PostgreSQL requires an enum value to be committed before it is used.
ALTER TYPE "ReferralCommissionStatus" ADD VALUE IF NOT EXISTS 'REVERSAL_PENDING';
