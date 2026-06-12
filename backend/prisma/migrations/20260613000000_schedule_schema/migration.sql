-- Add optional schema scoping to scheduled queries
ALTER TABLE "ScheduledQuery" ADD COLUMN "schemaName" TEXT;
