-- AlterTable: ScheduledQuery alert fields
ALTER TABLE "ScheduledQuery" ADD COLUMN "slackWebhook" TEXT;
ALTER TABLE "ScheduledQuery" ADD COLUMN "alertCondition" JSONB;
ALTER TABLE "ScheduledQuery" ADD COLUMN "alertCooldownMin" INTEGER;
ALTER TABLE "ScheduledQuery" ADD COLUMN "lastAlertedAt" TIMESTAMP(3);

-- AlterTable: ScheduledQueryRun alert outcome
ALTER TABLE "ScheduledQueryRun" ADD COLUMN "alertTriggered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ScheduledQueryRun" ADD COLUMN "alertSummary" TEXT;
