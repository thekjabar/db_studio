-- Pending invitations for people who don't have an account yet.
CREATE TABLE IF NOT EXISTS "ConnectionInvite" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "invitedById" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "acceptedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConnectionInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConnectionInvite_token_key" ON "ConnectionInvite"("token");
CREATE INDEX IF NOT EXISTS "ConnectionInvite_email_idx" ON "ConnectionInvite"("email");
CREATE INDEX IF NOT EXISTS "ConnectionInvite_connectionId_idx" ON "ConnectionInvite"("connectionId");
CREATE UNIQUE INDEX IF NOT EXISTS "ConnectionInvite_connectionId_email_key" ON "ConnectionInvite"("connectionId", "email");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ConnectionInvite_connectionId_fkey'
  ) THEN
    ALTER TABLE "ConnectionInvite"
      ADD CONSTRAINT "ConnectionInvite_connectionId_fkey"
      FOREIGN KEY ("connectionId") REFERENCES "Connection"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
