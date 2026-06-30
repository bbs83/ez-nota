-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "partialRefundAt" TIMESTAMP(3),
ADD COLUMN     "protocoloCancelamento" TEXT;
