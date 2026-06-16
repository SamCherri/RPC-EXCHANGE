CREATE TYPE "RegistrationApprovalStatus" AS ENUM ('PENDING', 'NEEDS_CORRECTION', 'APPROVED', 'REJECTED');
CREATE TYPE "FinancialPermissionKey" AS ENUM ('RPC_MARKET_TRADE', 'COMPANY_MARKET_TRADE', 'PROJECT_CREATE', 'WITHDRAWAL_REQUEST', 'BROKER_TRANSFER');

ALTER TABLE "User" ADD COLUMN "discordId" TEXT;
ALTER TABLE "User" ADD COLUMN "characterPhone" TEXT;
ALTER TABLE "User" ADD COLUMN "approvalStatus" "RegistrationApprovalStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "User" ADD COLUMN "approvalNote" TEXT;
ALTER TABLE "User" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "approvedById" TEXT;
CREATE UNIQUE INDEX "User_discordId_key" ON "User"("discordId");
ALTER TABLE "User" ADD CONSTRAINT "User_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RegistrationProof" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "fileName" TEXT,
  "data" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RegistrationProof_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RegistrationProof_userId_key" ON "RegistrationProof"("userId");
ALTER TABLE "RegistrationProof" ADD CONSTRAINT "RegistrationProof_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "UserFinancialPermission" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "permission" "FinancialPermissionKey" NOT NULL,
  "grantedById" TEXT NOT NULL,
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "reason" TEXT NOT NULL,
  CONSTRAINT "UserFinancialPermission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserFinancialPermission_userId_permission_key" ON "UserFinancialPermission"("userId", "permission");
CREATE INDEX "UserFinancialPermission_permission_idx" ON "UserFinancialPermission"("permission");
CREATE INDEX "UserFinancialPermission_revokedAt_idx" ON "UserFinancialPermission"("revokedAt");
ALTER TABLE "UserFinancialPermission" ADD CONSTRAINT "UserFinancialPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserFinancialPermission" ADD CONSTRAINT "UserFinancialPermission_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "User" SET "approvalStatus" = 'APPROVED', "approvedAt" = "createdAt" WHERE "approvalStatus" = 'PENDING';
