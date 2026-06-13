-- Snippets + slow-query alert config
CREATE TABLE "Snippet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT,
    "name" TEXT NOT NULL,
    "sqlText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Snippet_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Snippet_userId_idx" ON "Snippet"("userId");
CREATE INDEX "Snippet_connectionId_idx" ON "Snippet"("connectionId");
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Connection" ADD COLUMN "slowQueryAlertMs" INTEGER;
ALTER TABLE "Connection" ADD COLUMN "slowQueryAlertEmail" TEXT;
