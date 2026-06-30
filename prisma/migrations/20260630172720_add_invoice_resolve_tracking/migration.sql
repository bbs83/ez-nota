-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "lastResolveAt" TIMESTAMP(3),
ADD COLUMN     "resolveAttempts" INTEGER NOT NULL DEFAULT 0;
