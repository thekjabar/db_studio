-- User signup approval workflow. New self-signups land at `pending`
-- and need an operator to flip them to `approved` before they can
-- log in. Existing accounts are grandfathered to `approved` so
-- nobody loses access at the migration boundary.

-- 1. Enum -----------------------------------------------------------

CREATE TYPE "UserApprovalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- 2. New columns on User -------------------------------------------
-- approvalStatus must NOT NULL; default it pending so column add is
-- safe, then backfill existing rows below.

ALTER TABLE "User"
  ADD COLUMN "approvalStatus"        "UserApprovalStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "approvalNote"          TEXT,
  ADD COLUMN "approvedAt"            TIMESTAMP(3),
  ADD COLUMN "rejectedAt"            TIMESTAMP(3),
  ADD COLUMN "approvedByOperatorId"  TEXT;

-- 3. Backfill — every pre-existing user is treated as already approved.
-- They got in before the workflow existed and shouldn't be locked out.
-- We stamp approvedAt to createdAt so audit history is internally
-- consistent.
UPDATE "User"
SET "approvalStatus" = 'approved',
    "approvedAt"     = "createdAt"
WHERE "approvalStatus" = 'pending';

-- 4. Index — operators filter by status on every page load, so a
-- partial index on (status, createdAt) keeps the Pending tab snappy.
CREATE INDEX "User_approvalStatus_createdAt_idx"
  ON "User"("approvalStatus", "createdAt" DESC);

-- 5. Audit enum — record the new "user tried to log in but is
-- pending/rejected" actions alongside the existing LOGIN_SUSPENDED.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LOGIN_PENDING';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LOGIN_REJECTED';
