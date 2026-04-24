-- CreateTable
CREATE TABLE "Dashboard" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "connectionId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "shareToken" TEXT,
    "refreshSec" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dashboard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dashboard_shareToken_key" ON "Dashboard"("shareToken");
CREATE INDEX "Dashboard_connectionId_idx" ON "Dashboard"("connectionId");
CREATE INDEX "Dashboard_ownerId_idx" ON "Dashboard"("ownerId");

-- AddForeignKey
ALTER TABLE "Dashboard" ADD CONSTRAINT "Dashboard_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Dashboard" ADD CONSTRAINT "Dashboard_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "DashboardTile" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "savedQueryId" TEXT NOT NULL,
    "chartOverride" JSONB,
    "title" TEXT,
    "x" INTEGER NOT NULL DEFAULT 0,
    "y" INTEGER NOT NULL DEFAULT 0,
    "w" INTEGER NOT NULL DEFAULT 6,
    "h" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DashboardTile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DashboardTile_dashboardId_idx" ON "DashboardTile"("dashboardId");
CREATE INDEX "DashboardTile_savedQueryId_idx" ON "DashboardTile"("savedQueryId");

-- AddForeignKey
ALTER TABLE "DashboardTile" ADD CONSTRAINT "DashboardTile_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DashboardTile" ADD CONSTRAINT "DashboardTile_savedQueryId_fkey" FOREIGN KEY ("savedQueryId") REFERENCES "SavedQuery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
