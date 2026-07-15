-- Billing plans + Wayl payment attempts. Purely additive and fully idempotent
-- (guarded CREATE TYPE / IF NOT EXISTS / guarded FK) so it is safe to run on a
-- database whether or not any part already exists.

-- CreateEnum (PlanTier) — guarded (CREATE TYPE has no IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PlanTier') THEN
    CREATE TYPE "PlanTier" AS ENUM ('FREE', 'PRO', 'TEAM');
  END IF;
END $$;

-- CreateEnum (PaymentAttemptStatus) — guarded.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentAttemptStatus') THEN
    CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');
  END IF;
END $$;

-- AlterTable (Subscription): add the plan tier, default FREE for existing rows.
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "plan" "PlanTier" NOT NULL DEFAULT 'FREE';

-- CreateTable (PlanConfig)
CREATE TABLE IF NOT EXISTS "PlanConfig" (
    "tier" "PlanTier" NOT NULL,
    "name" TEXT NOT NULL,
    "seatPriceIqd" INTEGER NOT NULL DEFAULT 0,
    "maxConnections" INTEGER NOT NULL DEFAULT 3,
    "aiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dailyAiCalls" INTEGER NOT NULL DEFAULT 0,
    "maxScheduledQueries" INTEGER NOT NULL DEFAULT 2,
    "maxWebhooksPerConnection" INTEGER NOT NULL DEFAULT 1,
    "maxSeats" INTEGER,
    "updatedByOperatorId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanConfig_pkey" PRIMARY KEY ("tier")
);

-- CreateTable (PaymentAttempt)
CREATE TABLE IF NOT EXISTS "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "referenceId" TEXT NOT NULL,
    "providerRef" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'wayl',
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "plan" "PlanTier" NOT NULL,
    "seats" INTEGER NOT NULL,
    "amountIqd" INTEGER NOT NULL,
    "months" INTEGER NOT NULL DEFAULT 1,
    "rawResponse" JSONB,
    "failureReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentAttempt_referenceId_key" ON "PaymentAttempt"("referenceId");
CREATE INDEX IF NOT EXISTS "PaymentAttempt_workspaceId_idx" ON "PaymentAttempt"("workspaceId");
CREATE INDEX IF NOT EXISTS "PaymentAttempt_providerRef_idx" ON "PaymentAttempt"("providerRef");

-- AddForeignKey (PaymentAttempt.workspaceId -> Workspace). Guarded.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentAttempt_workspaceId_fkey') THEN
    ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
