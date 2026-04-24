-- CreateTable
CREATE TABLE "RowFilter" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "schemaName" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RowFilter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RowFilter_connectionId_userId_schemaName_tableName_key"
  ON "RowFilter"("connectionId", "userId", "schemaName", "tableName");
CREATE INDEX "RowFilter_connectionId_schemaName_tableName_idx"
  ON "RowFilter"("connectionId", "schemaName", "tableName");
CREATE INDEX "RowFilter_userId_idx" ON "RowFilter"("userId");

ALTER TABLE "RowFilter"
  ADD CONSTRAINT "RowFilter_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RowFilter"
  ADD CONSTRAINT "RowFilter_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
