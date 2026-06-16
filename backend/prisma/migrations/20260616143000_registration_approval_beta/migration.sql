CREATE TYPE "UserApprovalStatus" AS ENUM ('PENDING', 'CORRECTION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED');
CREATE TYPE "RegistrationEvidenceStatus" AS ENUM ('ACTIVE', 'REPLACED', 'REJECTED');
CREATE TYPE "RegistrationEvidenceType" AS ENUM ('SUNCITY_ACCOUNT_SCREENSHOT');
CREATE TYPE "ProfileChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "ProfileChangeField" AS ENUM ('CHARACTER_NAME', 'DISCORD', 'GAME_PHONE');

ALTER TABLE "User"
  ADD COLUMN "approvalStatus" "UserApprovalStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "approvalReason" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "lastSubmittedAt" TIMESTAMP(3);

UPDATE "User"
SET "approvalStatus" = 'APPROVED',
    "approvedAt" = COALESCE("approvedAt", "createdAt"),
    "reviewedAt" = COALESCE("reviewedAt", "createdAt"),
    "lastSubmittedAt" = COALESCE("lastSubmittedAt", "createdAt")
WHERE "approvalStatus" = 'APPROVED';

ALTER TABLE "User" ADD CONSTRAINT "User_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RegistrationEvidence" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "RegistrationEvidenceType" NOT NULL DEFAULT 'SUNCITY_ACCOUNT_SCREENSHOT',
  "storageKey" TEXT NOT NULL,
  "originalFileName" TEXT,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "content" BYTEA NOT NULL,
  "status" "RegistrationEvidenceStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "replacedAt" TIMESTAMP(3),
  CONSTRAINT "RegistrationEvidence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RegistrationEvidence_storageKey_key" ON "RegistrationEvidence"("storageKey");
CREATE INDEX "RegistrationEvidence_userId_status_idx" ON "RegistrationEvidence"("userId", "status");
ALTER TABLE "RegistrationEvidence" ADD CONSTRAINT "RegistrationEvidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProfileChangeRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "field" "ProfileChangeField" NOT NULL,
  "currentValue" TEXT NOT NULL,
  "requestedValue" TEXT NOT NULL,
  "status" "ProfileChangeStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfileChangeRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProfileChangeRequest_userId_status_idx" ON "ProfileChangeRequest"("userId", "status");
ALTER TABLE "ProfileChangeRequest" ADD CONSTRAINT "ProfileChangeRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProfileChangeRequest" ADD CONSTRAINT "ProfileChangeRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "UserPermission" (
  "userId" TEXT NOT NULL,
  "permissionId" TEXT NOT NULL,
  "grantedById" TEXT,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserPermission_pkey" PRIMARY KEY ("userId", "permissionId")
);
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "User" ALTER COLUMN "approvalStatus" SET DEFAULT 'PENDING';
