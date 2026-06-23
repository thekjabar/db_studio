-- Network agents: run inside the customer network, proxy DB access for
-- IP-allowlisted databases the cloud can't reach directly.
CREATE TABLE "WorkspaceAgent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenSha" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastSeenAt" TIMESTAMP(3),
    "agentVersion" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkspaceAgent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkspaceAgent_tokenSha_key" ON "WorkspaceAgent"("tokenSha");
CREATE INDEX "WorkspaceAgent_workspaceId_idx" ON "WorkspaceAgent"("workspaceId");
ALTER TABLE "WorkspaceAgent" ADD CONSTRAINT "WorkspaceAgent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Connection routing: direct vs agent.
ALTER TABLE "Connection" ADD COLUMN "connectVia" TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE "Connection" ADD COLUMN "agentId" TEXT;
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "WorkspaceAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
