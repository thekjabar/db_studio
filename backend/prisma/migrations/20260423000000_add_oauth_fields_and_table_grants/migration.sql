-- AlterTable: User — make passwordHash nullable, add OAuth fields
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "oauthProvider" TEXT;
ALTER TABLE "User" ADD COLUMN "oauthId" TEXT;

-- CreateIndex: unique (oauthProvider, oauthId)
CREATE UNIQUE INDEX "User_oauthProvider_oauthId_key" ON "User"("oauthProvider", "oauthId");

-- CreateTable: TableGrant
CREATE TABLE "TableGrant" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "schemaName" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TableGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TableGrant_connectionId_userId_idx" ON "TableGrant"("connectionId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TableGrant_connectionId_userId_schemaName_tableName_key" ON "TableGrant"("connectionId", "userId", "schemaName", "tableName");

-- AddForeignKey
ALTER TABLE "TableGrant" ADD CONSTRAINT "TableGrant_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableGrant" ADD CONSTRAINT "TableGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
