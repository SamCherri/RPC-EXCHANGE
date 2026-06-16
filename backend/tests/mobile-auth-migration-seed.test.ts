import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('migration converte admin existente e gera telefone legado único sem usar 000-000 em massa', async () => {
  const migration = await readFile(new URL('../prisma/migrations/20260616120000_discord_mobile_profile/migration.sql', import.meta.url), 'utf8');

  assert.match(migration, /WITH existing_admin AS/);
  assert.match(migration, /LOWER\("email"\) IN \('admin@rpc\.exchange\.local', 'admin@bolsavirtual\.local'\)/);
  assert.match(migration, /"discord" = 'admin'/);
  assert.match(migration, /"gamePhone" = '000-000'/);
  assert.match(migration, /'LEGACY-' \|\| SUBSTRING\("id", 1, 12\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "User_gamePhone_key" ON "User"\("gamePhone"\)/);
});

test('seed reutiliza admin, demo e corretor por discord/e-mail e garante wallet sem duplicar usuário', async () => {
  const seed = await readFile(new URL('../prisma/seed.ts', import.meta.url), 'utf8');

  assert.match(seed, /async function upsertSeedUser/);
  assert.match(seed, /legacyEmails: \[adminEmailLegacy\]/);
  assert.match(seed, /discord: 'admin'/);
  assert.match(seed, /gamePhone: '000-000'/);
  assert.match(seed, /preservePassword: true/);
  assert.match(seed, /where: \{ userId: user\.id \}/);
  assert.match(seed, /legacyEmails: \[demoEmailLegacy\]/);
  assert.match(seed, /legacyEmails: \['corretor@bolsavirtual\.local'\]/);
});
