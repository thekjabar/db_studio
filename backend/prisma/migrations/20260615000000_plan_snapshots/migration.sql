-- Plan regression detection: per-shape EXPLAIN snapshots over time.
CREATE TABLE "PlanSnapshot" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT,
    "shapeHash" TEXT NOT NULL,
    "normalizedSql" TEXT NOT NULL,
    "exampleSql" TEXT NOT NULL,
    "planHash" TEXT NOT NULL,
    "planSummary" TEXT NOT NULL,
    "totalCost" DOUBLE PRECISION,
    "totalTimeMs" DOUBLE PRECISION,
    "scans" JSONB NOT NULL,
    "nodes" JSONB NOT NULL,
    "regressed" BOOLEAN NOT NULL DEFAULT false,
    "regressionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PlanSnapshot_connectionId_shapeHash_createdAt_idx" ON "PlanSnapshot"("connectionId", "shapeHash", "createdAt" DESC);
CREATE INDEX "PlanSnapshot_connectionId_regressed_createdAt_idx" ON "PlanSnapshot"("connectionId", "regressed", "createdAt" DESC);
ALTER TABLE "PlanSnapshot" ADD CONSTRAINT "PlanSnapshot_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanSnapshot" ADD CONSTRAINT "PlanSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
