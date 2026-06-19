import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { resetTestDatabase } from './helpers/reset-test-db.js';

if (process.env.NODE_ENV === 'production') throw new Error('Testes não podem rodar em produção.');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([
  import('../src/app.js'),
  import('../src/lib/prisma.js'),
]);

const app = buildApp();

async function resetDb() {
  await resetTestDatabase(prisma);
}

async function mkRole(key: string, name = key) {
  return prisma.role.upsert({ where: { key }, update: { name }, create: { key, name } });
}

async function mkUser(email: string, roles: string[], discordId = email.split('@')[0]) {
  const user = await prisma.user.create({
    data: { email, discordId, name: email.split('@')[0], approvalStatus: 'APPROVED', passwordHash: await bcrypt.hash('Admin@123', 10), wallet: { create: {} } },
  });
  for (const roleKey of roles) {
    const role = await mkRole(roleKey);
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  return user;
}

async function token(userId: string, roles: string[]) {
  return app.jwt.sign({ sub: userId, roles });
}

test.before(async () => {
  await app.ready();
  await resetDb();
});

test.after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('role DEVELOPER oficial existe e cadastro público não promove primeiro usuário', async () => {
  await resetDb();
  await mkRole('USER', 'Usuário comum');
  const developerRole = await mkRole('DEVELOPER', 'Desenvolvedor');
  assert.equal(developerRole.key, 'DEVELOPER');

  const created = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Jogador Publico', characterName: 'Personagem Publico', discordId: 'primeiro-publico', characterPhone: '555-1000', screenshot: { mimeType: 'image/png', fileName: 'cadastro.png', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' }, password: '12345678', passwordConfirmation: '12345678' } });
  assert.equal(created.statusCode, 201, created.body);
  const publicUser = await prisma.user.findFirstOrThrow({ where: { discordId: 'primeiro-publico' }, include: { roles: { include: { role: true } } } });
  assert.deepEqual(publicUser.roles.map((item) => item.role.key), ['USER']);
});

test('painel admin bloqueia concessão de DEVELOPER para ADMIN, COIN_CHIEF_ADMIN e SUPER_ADMIN', async () => {
  await resetDb();
  const target = await mkUser('target@test.local', ['USER']);
  const admin = await mkUser('admin@test.local', ['USER', 'ADMIN']);
  const chief = await mkUser('chief@test.local', ['USER', 'COIN_CHIEF_ADMIN']);
  const superAdmin = await mkUser('super@test.local', ['USER', 'SUPER_ADMIN']);

  for (const [actor, roles] of [[admin, ['ADMIN']], [chief, ['COIN_CHIEF_ADMIN']], [superAdmin, ['SUPER_ADMIN']]] as const) {
    const res = await app.inject({ method: 'PATCH', url: `/api/admin/users/${target.id}/roles`, headers: { authorization: `Bearer ${await token(actor.id, roles)}` }, payload: { roles: ['USER', 'DEVELOPER'] } });
    assert.equal(res.statusCode, 403, res.body);
  }
});

test('não permite remover o último DEVELOPER nem o último SUPER_ADMIN', async () => {
  await resetDb();
  const owner = await mkUser('owner@test.local', ['USER', 'ADMIN', 'SUPER_ADMIN', 'COIN_CHIEF_ADMIN', 'DEVELOPER']);
  const developerToken = await token(owner.id, ['DEVELOPER', 'SUPER_ADMIN', 'ADMIN', 'COIN_CHIEF_ADMIN']);

  const removeDeveloper = await app.inject({ method: 'PATCH', url: `/api/admin/users/${owner.id}/roles`, headers: { authorization: `Bearer ${developerToken}` }, payload: { roles: ['USER', 'ADMIN', 'SUPER_ADMIN', 'COIN_CHIEF_ADMIN'] } });
  assert.equal(removeDeveloper.statusCode, 400, removeDeveloper.body);

  const removeSuperAdmin = await app.inject({ method: 'PATCH', url: `/api/admin/users/${owner.id}/roles`, headers: { authorization: `Bearer ${developerToken}` }, payload: { roles: ['USER', 'ADMIN', 'COIN_CHIEF_ADMIN'] } });
  assert.equal(removeSuperAdmin.statusCode, 400, removeSuperAdmin.body);
});

test('DEVELOPER acessa admin, /auth/me e ações equivalentes a SUPER_ADMIN/controle de moeda', async () => {
  await resetDb();
  const owner = await mkUser('owner-access@test.local', ['USER', 'ADMIN', 'SUPER_ADMIN', 'COIN_CHIEF_ADMIN', 'DEVELOPER']);
  const tk = await token(owner.id, ['DEVELOPER']);

  const users = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { authorization: `Bearer ${tk}` } });
  assert.equal(users.statusCode, 200, users.body);

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${tk}` } });
  assert.equal(me.statusCode, 200, me.body);
  assert.ok(me.json().user.roles.includes('DEVELOPER'));

  const financial = await app.inject({ method: 'PATCH', url: `/api/admin/users/${owner.id}/financial-permissions`, headers: { authorization: `Bearer ${tk}` }, payload: { permissions: ['RPC_MARKET_TRADE'], reason: 'Teste developer' } });
  assert.equal(financial.statusCode, 200, financial.body);
});
