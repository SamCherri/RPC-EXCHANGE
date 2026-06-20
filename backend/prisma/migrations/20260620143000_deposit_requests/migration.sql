-- CreateEnum
CREATE TYPE "DepositMethod" AS ENUM ('PLATFORM', 'BROKER');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELED');

-- AlterEnum
ALTER TYPE "FinancialPermissionKey" ADD VALUE 'FIAT_DEPOSIT_REQUEST';

-- CreateTable
CREATE TABLE "DepositRequest" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "method" "DepositMethod" NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "brokerUserId" TEXT,
    "userNote" TEXT,
    "adminNote" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "screenshotMimeType" TEXT,
    "screenshotFileName" TEXT,
    "screenshotData" TEXT,
    "screenshotChecksum" TEXT,
    "screenshotSize" INTEGER,
    "reviewedById" TEXT,
    "completedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processingAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),

    CONSTRAINT "DepositRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DepositRequest_code_key" ON "DepositRequest"("code");
CREATE UNIQUE INDEX "DepositRequest_userId_idempotencyKey_key" ON "DepositRequest"("userId", "idempotencyKey");
CREATE INDEX "DepositRequest_userId_idx" ON "DepositRequest"("userId");
CREATE INDEX "DepositRequest_brokerUserId_idx" ON "DepositRequest"("brokerUserId");
CREATE INDEX "DepositRequest_status_idx" ON "DepositRequest"("status");
CREATE INDEX "DepositRequest_method_idx" ON "DepositRequest"("method");
CREATE INDEX "DepositRequest_code_idx" ON "DepositRequest"("code");
CREATE INDEX "DepositRequest_createdAt_idx" ON "DepositRequest"("createdAt");

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_brokerUserId_fkey" FOREIGN KEY ("brokerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
