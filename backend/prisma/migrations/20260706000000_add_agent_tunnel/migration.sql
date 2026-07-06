-- Idempotent: a previously-reverted "network agents" feature already left an
-- `agentId` column on Connection (migration 20260622000000_network_agents applied
-- to some databases but its code was reverted). Guard every add so this migration
-- succeeds whether or not that leftover is present.

-- AlterTable (Connection)
ALTER TABLE "Connection" ADD COLUMN IF NOT EXISTS "agentId" TEXT;
ALTER TABLE "Connection" ADD COLUMN IF NOT EXISTS "viaAgent" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable (Agent)
CREATE TABLE IF NOT EXISTS "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "refreshHash" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Agent_ownerId_idx" ON "Agent"("ownerId");

-- AddForeignKey (Agent -> User). Guarded: skip if it already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Agent_ownerId_fkey'
  ) THEN
    ALTER TABLE "Agent" ADD CONSTRAINT "Agent_ownerId_fkey"
      FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (Connection.agentId -> Agent). The leftover network_agents
-- migration created `agentId` WITHOUT this FK (it pointed at a different table),
-- so only add ours if no FK on agentId exists yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Connection_agentId_fkey'
  ) THEN
    ALTER TABLE "Connection" ADD CONSTRAINT "Connection_agentId_fkey"
      FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
