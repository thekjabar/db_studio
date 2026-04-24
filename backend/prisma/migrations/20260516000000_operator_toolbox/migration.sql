-- Feedback inbox
CREATE TYPE "FeedbackCategory" AS ENUM ('BUG', 'FEATURE', 'QUESTION', 'OTHER');
CREATE TYPE "FeedbackStatus"   AS ENUM ('NEW', 'TRIAGED', 'ANSWERED', 'CLOSED');
CREATE TABLE "Feedback" (
    "id"                     TEXT NOT NULL,
    "userId"                 TEXT,
    "email"                  TEXT,
    "category"               "FeedbackCategory" NOT NULL DEFAULT 'OTHER',
    "message"                TEXT NOT NULL,
    "sourcePath"             TEXT,
    "status"                 "FeedbackStatus" NOT NULL DEFAULT 'NEW',
    "internalNotes"          TEXT,
    "replyText"              TEXT,
    "repliedAt"              TIMESTAMP(3),
    "repliedByOperatorId"    TEXT,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Feedback_status_idx"    ON "Feedback"("status");
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");
CREATE INDEX "Feedback_userId_idx"    ON "Feedback"("userId");
ALTER TABLE "Feedback"
  ADD CONSTRAINT "Feedback_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL;

-- Announcements
CREATE TYPE "AnnouncementSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
CREATE TABLE "Announcement" (
    "id"        TEXT NOT NULL,
    "title"     TEXT NOT NULL,
    "body"      TEXT NOT NULL,
    "severity"  "AnnouncementSeverity" NOT NULL DEFAULT 'INFO',
    "targeting" JSONB,
    "startsAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt"    TIMESTAMP(3),
    "createdByOperatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Announcement_startsAt_endsAt_idx" ON "Announcement"("startsAt", "endsAt");

CREATE TABLE "AnnouncementView" (
    "id"             TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "seenAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt"    TIMESTAMP(3),
    CONSTRAINT "AnnouncementView_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AnnouncementView_announcementId_userId_key" ON "AnnouncementView"("announcementId", "userId");
CREATE INDEX "AnnouncementView_userId_idx" ON "AnnouncementView"("userId");
ALTER TABLE "AnnouncementView"
  ADD CONSTRAINT "AnnouncementView_announcementId_fkey"
  FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE;
ALTER TABLE "AnnouncementView"
  ADD CONSTRAINT "AnnouncementView_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

-- Email templates
CREATE TABLE "EmailTemplate" (
    "name"                TEXT NOT NULL,
    "subject"             TEXT NOT NULL,
    "bodyHtml"            TEXT NOT NULL,
    "bodyText"            TEXT NOT NULL,
    "variables"           TEXT[] NOT NULL DEFAULT '{}',
    "updatedByOperatorId" TEXT,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("name")
);

-- Billing adjustments
CREATE TABLE "BillingAdjustment" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency"    TEXT NOT NULL DEFAULT 'USD',
    "reason"      TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd"   TIMESTAMP(3),
    "operatorId"  TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingAdjustment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BillingAdjustment_workspaceId_idx" ON "BillingAdjustment"("workspaceId");
CREATE INDEX "BillingAdjustment_createdAt_idx"   ON "BillingAdjustment"("createdAt");
ALTER TABLE "BillingAdjustment"
  ADD CONSTRAINT "BillingAdjustment_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE;

-- Invite codes + waitlist
CREATE TABLE "Waitlist" (
    "id"         TEXT NOT NULL,
    "email"      TEXT NOT NULL,
    "metadata"   JSONB,
    "invitedAt"  TIMESTAMP(3),
    "notes"      TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Waitlist_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Waitlist_email_key" ON "Waitlist"("email");

CREATE TABLE "InviteCode" (
    "code"                TEXT NOT NULL,
    "usesRemaining"       INTEGER NOT NULL DEFAULT 1,
    "maxUses"             INTEGER NOT NULL DEFAULT 1,
    "expiresAt"           TIMESTAMP(3),
    "assignedEmail"       TEXT,
    "note"                TEXT,
    "createdByOperatorId" TEXT NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "waitlistId"          TEXT,
    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("code")
);
CREATE UNIQUE INDEX "InviteCode_waitlistId_key" ON "InviteCode"("waitlistId");
ALTER TABLE "InviteCode"
  ADD CONSTRAINT "InviteCode_waitlistId_fkey"
  FOREIGN KEY ("waitlistId") REFERENCES "Waitlist"("id") ON DELETE SET NULL;

-- Abuse / IP block
CREATE TABLE "AbuseEvent" (
    "id"                 TEXT NOT NULL,
    "rule"               TEXT NOT NULL,
    "ip"                 TEXT,
    "userId"             TEXT,
    "path"               TEXT,
    "metadata"           JSONB,
    "ackedAt"            TIMESTAMP(3),
    "ackedByOperatorId"  TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AbuseEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AbuseEvent_rule_idx"      ON "AbuseEvent"("rule");
CREATE INDEX "AbuseEvent_createdAt_idx" ON "AbuseEvent"("createdAt");
CREATE INDEX "AbuseEvent_ip_idx"        ON "AbuseEvent"("ip");
CREATE INDEX "AbuseEvent_userId_idx"    ON "AbuseEvent"("userId");
ALTER TABLE "AbuseEvent"
  ADD CONSTRAINT "AbuseEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL;

CREATE TABLE "BlockedIp" (
    "ip"                  TEXT NOT NULL,
    "reason"              TEXT,
    "createdByOperatorId" TEXT NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BlockedIp_pkey" PRIMARY KEY ("ip")
);

-- Retention policies
CREATE TABLE "RetentionPolicy" (
    "resource"            TEXT NOT NULL,
    "keepDays"            INTEGER NOT NULL,
    "lastRunAt"           TIMESTAMP(3),
    "lastRunRowsDeleted"  INTEGER NOT NULL DEFAULT 0,
    "updatedByOperatorId" TEXT,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RetentionPolicy_pkey" PRIMARY KEY ("resource")
);

-- Feature flags
CREATE TABLE "FeatureFlag" (
    "key"                  TEXT NOT NULL,
    "description"          TEXT,
    "rolloutPercent"       INTEGER NOT NULL DEFAULT 0,
    "enabledUserIds"       TEXT[] NOT NULL DEFAULT '{}',
    "enabledWorkspaceIds"  TEXT[] NOT NULL DEFAULT '{}',
    "disabledUserIds"      TEXT[] NOT NULL DEFAULT '{}',
    "disabledWorkspaceIds" TEXT[] NOT NULL DEFAULT '{}',
    "updatedByOperatorId"  TEXT,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);
