-- CreateTable
CREATE TABLE "SchemaDoc" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "schemaName" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT NOT NULL DEFAULT '',
    "description" TEXT,
    "tags" TEXT,
    "ownerEmail" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchemaDoc_pkey" PRIMARY KEY ("id")
);

-- columnName is NOT NULL ('' for table-level) so the composite unique is
-- standard-shape and works with Prisma's findUnique without NULL semantics.
CREATE UNIQUE INDEX "SchemaDoc_connectionId_schemaName_tableName_columnName_key"
  ON "SchemaDoc"("connectionId", "schemaName", "tableName", "columnName");
CREATE INDEX "SchemaDoc_connectionId_schemaName_tableName_idx"
  ON "SchemaDoc"("connectionId", "schemaName", "tableName");

ALTER TABLE "SchemaDoc"
  ADD CONSTRAINT "SchemaDoc_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SchemaDoc"
  ADD CONSTRAINT "SchemaDoc_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
