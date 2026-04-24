-- Operator trust boundary: separate table, separate JWT secret, separate
-- sessions. Never joined to User.
CREATE TABLE "Operator" (
    "id"            TEXT NOT NULL,
    "email"         TEXT NOT NULL,
    "passwordHash"  TEXT NOT NULL,
    "displayName"   TEXT,
    "isSuper"       BOOLEAN NOT NULL DEFAULT false,
    "disabledAt"    TIMESTAMP(3),
    "lastLoginAt"   TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Operator_email_key" ON "Operator"("email");
CREATE INDEX "Operator_email_idx" ON "Operator"("email");

CREATE TABLE "OperatorRefreshToken" (
    "id"          TEXT NOT NULL,
    "operatorId"  TEXT NOT NULL,
    "tokenHash"   TEXT NOT NULL,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "revokedAt"   TIMESTAMP(3),
    "userAgent"   TEXT,
    "ip"          TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OperatorRefreshToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OperatorRefreshToken_tokenHash_key" ON "OperatorRefreshToken"("tokenHash");
CREATE INDEX "OperatorRefreshToken_operatorId_idx" ON "OperatorRefreshToken"("operatorId");
CREATE INDEX "OperatorRefreshToken_expiresAt_idx" ON "OperatorRefreshToken"("expiresAt");
ALTER TABLE "OperatorRefreshToken"
    ADD CONSTRAINT "OperatorRefreshToken_operatorId_fkey"
    FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE;

-- Append-only audit trail. Restrict on operator delete so audit history
-- can't be erased by removing an operator — you must explicitly archive
-- audit rows first.
CREATE TABLE "OperatorAuditLog" (
    "id"          TEXT NOT NULL,
    "operatorId"  TEXT NOT NULL,
    "action"      TEXT NOT NULL,
    "targetType"  TEXT,
    "targetId"    TEXT,
    "reason"      TEXT,
    "metadata"    JSONB,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OperatorAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OperatorAuditLog_operatorId_idx" ON "OperatorAuditLog"("operatorId");
CREATE INDEX "OperatorAuditLog_createdAt_idx" ON "OperatorAuditLog"("createdAt");
CREATE INDEX "OperatorAuditLog_action_idx" ON "OperatorAuditLog"("action");
ALTER TABLE "OperatorAuditLog"
    ADD CONSTRAINT "OperatorAuditLog_operatorId_fkey"
    FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT;

-- User account-lifecycle columns for operator suspension.
ALTER TABLE "User" ADD COLUMN "suspendedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "suspendedReason" TEXT;

-- Global pricing singleton (id="singleton"). Read-mostly. Every change
-- writes an OperatorAuditLog row.
CREATE TABLE "BillingSettings" (
    "id"                    TEXT NOT NULL,
    "pricePerSeatCents"     INTEGER NOT NULL DEFAULT 1000,
    "currency"              TEXT NOT NULL DEFAULT 'USD',
    "dailyFreeAiCalls"      INTEGER NOT NULL DEFAULT 10,
    "aiTopUpCallsPerPack"   INTEGER NOT NULL DEFAULT 10,
    "aiTopUpPriceCents"     INTEGER NOT NULL DEFAULT 100,
    "updatedByOperatorId"   TEXT,
    "updatedAt"             TIMESTAMP(3) NOT NULL,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingSettings_pkey" PRIMARY KEY ("id")
);
INSERT INTO "BillingSettings" ("id", "updatedAt") VALUES ('singleton', CURRENT_TIMESTAMP);

CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- One subscription per workspace. Seat count derives from WorkspaceMember
-- at read time so it can never drift from the actual team size.
CREATE TABLE "Subscription" (
    "id"                   TEXT NOT NULL,
    "workspaceId"          TEXT NOT NULL,
    "status"               "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "periodStart"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodEnd"            TIMESTAMP(3) NOT NULL,
    "manualOverrideNote"   TEXT,
    "aiTopUpPacks"         INTEGER NOT NULL DEFAULT 0,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Subscription_workspaceId_key" ON "Subscription"("workspaceId");
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");
CREATE INDEX "Subscription_periodEnd_idx" ON "Subscription"("periodEnd");
ALTER TABLE "Subscription"
    ADD CONSTRAINT "Subscription_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE;

-- Per-user per-day call counter. String `day` (YYYY-MM-DD UTC) so the
-- unique constraint is timezone-stable. Pruning is a nightly job on
-- rows older than N months.
CREATE TABLE "AiUsageDay" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "day"        TEXT NOT NULL,
    "callsUsed"  INTEGER NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiUsageDay_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiUsageDay_userId_day_key" ON "AiUsageDay"("userId", "day");
CREATE INDEX "AiUsageDay_day_idx" ON "AiUsageDay"("day");
ALTER TABLE "AiUsageDay"
    ADD CONSTRAINT "AiUsageDay_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
