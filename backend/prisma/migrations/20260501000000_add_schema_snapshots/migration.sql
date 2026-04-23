-- CreateTable
CREATE TABLE "SchemaSnapshot" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dbSchema" TEXT,
    "payload" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchemaSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SchemaSnapshot_connectionId_createdAt_idx" ON "SchemaSnapshot"("connectionId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "SchemaSnapshot" ADD CONSTRAINT "SchemaSnapshot_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemaSnapshot" ADD CONSTRAINT "SchemaSnapshot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
