-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN "requireReview" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "QueryReviewRequest" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "sqlText" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "reason" TEXT,
    "reviewComment" TEXT,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "executedRowsAffected" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueryReviewRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QueryReviewRequest_connectionId_status_createdAt_idx"
  ON "QueryReviewRequest"("connectionId", "status", "createdAt" DESC);
CREATE INDEX "QueryReviewRequest_requesterId_createdAt_idx"
  ON "QueryReviewRequest"("requesterId", "createdAt" DESC);

ALTER TABLE "QueryReviewRequest"
  ADD CONSTRAINT "QueryReviewRequest_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QueryReviewRequest"
  ADD CONSTRAINT "QueryReviewRequest_requesterId_fkey"
  FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QueryReviewRequest"
  ADD CONSTRAINT "QueryReviewRequest_reviewerId_fkey"
  FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
