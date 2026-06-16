-- Migração segura para trocar o identificador funcional de e-mail para Discord.
-- Mantém e-mail e bankAccountNumber como legado/compatibilidade, mas tira o e-mail do fluxo de login.
ALTER TABLE "User" ADD COLUMN "discord" TEXT;
ALTER TABLE "User" ADD COLUMN "gamePhone" TEXT;

UPDATE "User"
SET "discord" = COALESCE(NULLIF(TRIM("discord"), ''), LOWER(SPLIT_PART("email", '@', 1)) || '_' || SUBSTRING("id", 1, 8))
WHERE "discord" IS NULL OR TRIM("discord") = '';

UPDATE "User"
SET "gamePhone" = COALESCE(NULLIF(TRIM("bankAccountNumber"), ''), '000-000')
WHERE "gamePhone" IS NULL OR TRIM("gamePhone") = '';

ALTER TABLE "User" ALTER COLUMN "discord" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "gamePhone" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;

CREATE UNIQUE INDEX "User_discord_key" ON "User"("discord");
