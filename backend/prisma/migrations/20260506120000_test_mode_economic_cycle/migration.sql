-- CreateEnum
CREATE TYPE "TestModeSimulationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "TestModeSimulationRun" (
    "id" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "status" "TestModeSimulationStatus" NOT NULL DEFAULT 'RUNNING',
    "initialStateJson" TEXT NOT NULL,
    "resultJson" TEXT,
    "warningsJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "TestModeSimulationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TestModeSimulationStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "issuesJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TestModeSimulationStep_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TestModeSimulationStep_runId_stepNumber_key" ON "TestModeSimulationStep"("runId", "stepNumber");
CREATE INDEX "TestModeSimulationRun_createdByUserId_idx" ON "TestModeSimulationRun"("createdByUserId");
CREATE INDEX "TestModeSimulationRun_scenario_idx" ON "TestModeSimulationRun"("scenario");
CREATE INDEX "TestModeSimulationRun_status_idx" ON "TestModeSimulationRun"("status");
CREATE INDEX "TestModeSimulationRun_createdAt_idx" ON "TestModeSimulationRun"("createdAt");
CREATE INDEX "TestModeSimulationStep_runId_idx" ON "TestModeSimulationStep"("runId");

ALTER TABLE "TestModeSimulationRun" ADD CONSTRAINT "TestModeSimulationRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TestModeSimulationStep" ADD CONSTRAINT "TestModeSimulationStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TestModeSimulationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
