-- CreateTable
CREATE TABLE "ColumnMask" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "schemaName" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ColumnMask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ColumnMask_connectionId_userId_schemaName_tableName_columnN_key" ON "ColumnMask"("connectionId", "userId", "schemaName", "tableName", "columnName");

-- CreateIndex
CREATE INDEX "ColumnMask_connectionId_userId_schemaName_tableName_idx" ON "ColumnMask"("connectionId", "userId", "schemaName", "tableName");

-- AddForeignKey
ALTER TABLE "ColumnMask" ADD CONSTRAINT "ColumnMask_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColumnMask" ADD CONSTRAINT "ColumnMask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
