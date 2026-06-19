ALTER TABLE "CompanyCapitalFlowEntry" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "CompanyCapitalFlowEntry_idempotencyKey_key" ON "CompanyCapitalFlowEntry"("idempotencyKey");
