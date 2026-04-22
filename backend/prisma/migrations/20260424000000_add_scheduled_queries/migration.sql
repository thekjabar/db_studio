-- CreateEnum
CREATE TYPE "ScheduledRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "ScheduledQuery" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT,
    "sqlText" TEXT NOT NULL,
    "emailTo" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" "ScheduledRunStatus",
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledQuery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledQuery_ownerId_idx" ON "ScheduledQuery"("ownerId");

-- CreateIndex
CREATE INDEX "ScheduledQuery_connectionId_idx" ON "ScheduledQuery"("connectionId");

-- AddForeignKey
ALTER TABLE "ScheduledQuery" ADD CONSTRAINT "ScheduledQuery_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledQuery" ADD CONSTRAINT "ScheduledQuery_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ScheduledQueryRun" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "ScheduledRunStatus" NOT NULL,
    "rowCount" INTEGER,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "resultPreview" JSONB,
    "emailDelivered" BOOLEAN NOT NULL DEFAULT false,
    "emailError" TEXT,

    CONSTRAINT "ScheduledQueryRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledQueryRun_scheduleId_startedAt_idx" ON "ScheduledQueryRun"("scheduleId", "startedAt" DESC);

-- AddForeignKey
ALTER TABLE "ScheduledQueryRun" ADD CONSTRAINT "ScheduledQueryRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ScheduledQuery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
