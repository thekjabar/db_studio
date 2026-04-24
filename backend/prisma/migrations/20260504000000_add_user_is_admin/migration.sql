-- AlterTable
ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Promote the oldest user as admin so a new self-host has an admin account
-- out of the box. Safe on any DB that has at least one user; no-op otherwise.
UPDATE "User"
SET "isAdmin" = true
WHERE "id" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1);
