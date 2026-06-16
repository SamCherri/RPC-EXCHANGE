-- Migração segura para trocar o identificador funcional de e-mail para Discord.
-- Mantém e-mail e bankAccountNumber como legado/compatibilidade, mas tira e-mail/Conta RP do cadastro e perfil.
ALTER TABLE "User" ADD COLUMN "discord" TEXT;
ALTER TABLE "User" ADD COLUMN "gamePhone" TEXT;

-- Reserva o identificador público e telefone fixo para o administrador já existente.
-- Em produção esta conta já pode existir com e-mail atual ou legado e deve ser reaproveitada pelo seed.
WITH existing_admin AS (
  SELECT "id"
  FROM "User"
  WHERE LOWER("email") IN ('admin@rpc.exchange.local', 'admin@bolsavirtual.local')
  ORDER BY CASE LOWER("email") WHEN 'admin@rpc.exchange.local' THEN 0 ELSE 1 END
  LIMIT 1
)
UPDATE "User"
SET
  "discord" = 'admin',
  "gamePhone" = '000-000',
  "name" = 'Administrador',
  "characterName" = 'Admin_RPC'
WHERE "id" IN (SELECT "id" FROM existing_admin);

-- Gera Discord conhecido internamente e único para contas legadas comuns.
UPDATE "User"
SET "discord" = COALESCE(NULLIF(TRIM("discord"), ''), LOWER(SPLIT_PART("email", '@', 1)) || '_' || SUBSTRING("id", 1, 8))
WHERE "discord" IS NULL OR TRIM("discord") = '';

-- Gera telefones legados únicos. Não usa 000-000 para várias contas; esse valor fica reservado ao admin.
UPDATE "User"
SET "gamePhone" = 'LEGACY-' || SUBSTRING("id", 1, 12)
WHERE ("gamePhone" IS NULL OR TRIM("gamePhone") = '')
  AND LOWER(COALESCE("email", '')) NOT IN ('admin@rpc.exchange.local', 'admin@bolsavirtual.local');

ALTER TABLE "User" ALTER COLUMN "discord" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "gamePhone" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;

CREATE UNIQUE INDEX "User_discord_key" ON "User"("discord");
CREATE UNIQUE INDEX "User_gamePhone_key" ON "User"("gamePhone");
