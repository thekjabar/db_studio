-- CreateTable
CREATE TABLE "SharedQuery" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "sqlText" TEXT NOT NULL,
    "title" TEXT,
    "connectionId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "rowLimit" INTEGER NOT NULL DEFAULT 1000,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedQuery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SharedQuery_token_key" ON "SharedQuery"("token");
CREATE INDEX "SharedQuery_connectionId_idx" ON "SharedQuery"("connectionId");
CREATE INDEX "SharedQuery_createdById_idx" ON "SharedQuery"("createdById");

-- AddForeignKey
ALTER TABLE "SharedQuery" ADD CONSTRAINT "SharedQuery_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SharedQuery" ADD CONSTRAINT "SharedQuery_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
