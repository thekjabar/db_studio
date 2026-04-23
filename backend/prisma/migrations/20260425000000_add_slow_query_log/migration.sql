-- CreateTable
CREATE TABLE "SlowQueryLog" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT,
    "shapeHash" TEXT NOT NULL,
    "normalizedSql" TEXT NOT NULL,
    "exampleSql" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "rowCount" INTEGER,
    "rowsAffected" INTEGER,
    "errored" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlowQueryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlowQueryLog_connectionId_createdAt_idx" ON "SlowQueryLog"("connectionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SlowQueryLog_connectionId_shapeHash_idx" ON "SlowQueryLog"("connectionId", "shapeHash");

-- CreateIndex
CREATE INDEX "SlowQueryLog_connectionId_durationMs_idx" ON "SlowQueryLog"("connectionId", "durationMs" DESC);

-- AddForeignKey
ALTER TABLE "SlowQueryLog" ADD CONSTRAINT "SlowQueryLog_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlowQueryLog" ADD CONSTRAINT "SlowQueryLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
