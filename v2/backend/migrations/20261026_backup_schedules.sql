-- Automatic backups: a per-connection schedule, and a row per run.
--
-- Applied by hand on 2026-10-26 (this deployment has no migration runner any
-- more — Prisma's lived in the Node backend). Written to be re-runnable so it
-- can be applied again anywhere without checking first.
--
-- Dumps are pushed to S3-compatible storage the user configures per
-- connection; the credentials are encrypted with the same envelope as a
-- connection's own credentials, so this table never holds a readable secret.

CREATE TABLE IF NOT EXISTS "BackupSchedule" (
  "id"             text PRIMARY KEY,
  "connectionId"   text NOT NULL REFERENCES "Connection"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "ownerId"        text NOT NULL REFERENCES "User"("id")       ON UPDATE CASCADE ON DELETE CASCADE,
  "cron"           text NOT NULL,
  "timezone"       text,
  "schemaName"     text,
  -- 'plain' or 'custom' (pg_dump --format); MySQL is always plain.
  "format"         text NOT NULL DEFAULT 'custom',
  "schemaOnly"     boolean NOT NULL DEFAULT false,
  -- How many dumps to keep. Older ones are deleted from the bucket after a
  -- successful run; 0 keeps everything.
  "keepLast"       integer NOT NULL DEFAULT 7,
  "enabled"        boolean NOT NULL DEFAULT true,
  -- S3-compatible target. endpoint is empty for AWS itself.
  "bucket"         text NOT NULL,
  "prefix"         text NOT NULL DEFAULT '',
  "endpoint"       text NOT NULL DEFAULT '',
  "region"         text NOT NULL DEFAULT 'auto',
  "credentialsCt"  text NOT NULL,
  "lastRunAt"      timestamp(3),
  "lastStatus"     text,
  "lastError"      text,
  "lastSizeBytes"  bigint,
  "nextRunAt"      timestamp(3),
  "createdAt"      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "BackupSchedule_connectionId_idx" ON "BackupSchedule" ("connectionId");
CREATE INDEX IF NOT EXISTS "BackupSchedule_due_idx" ON "BackupSchedule" ("enabled", "nextRunAt");

CREATE TABLE IF NOT EXISTS "BackupRun" (
  "id"          text PRIMARY KEY,
  "scheduleId"  text NOT NULL REFERENCES "BackupSchedule"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "startedAt"   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"  timestamp(3),
  "status"      text NOT NULL,
  "sizeBytes"   bigint,
  "durationMs"  integer,
  "objectKey"   text,
  "errorMessage" text
);

CREATE INDEX IF NOT EXISTS "BackupRun_scheduleId_startedAt_idx"
  ON "BackupRun" ("scheduleId", "startedAt" DESC);
