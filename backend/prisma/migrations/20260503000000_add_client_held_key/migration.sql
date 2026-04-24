-- AlterTable
ALTER TABLE "Connection" ADD COLUMN "clientHeldKey" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Connection" ADD COLUMN "clientKeyKdfSalt" TEXT;
