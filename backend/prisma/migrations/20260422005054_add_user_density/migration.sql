-- CreateEnum
CREATE TYPE "Density" AS ENUM ('SMALL', 'MEDIUM', 'LARGE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "density" "Density" NOT NULL DEFAULT 'MEDIUM';
