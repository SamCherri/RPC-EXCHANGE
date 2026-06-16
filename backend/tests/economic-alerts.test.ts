import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

if (process.env.NODE_ENV === 'production') throw new Error('Testes não podem rodar em produção.');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([
  import('../src/app.js'),
  import('../src/lib/prisma.js'),
]);

const app = buildApp();
const PASSWORD = 'Admin@123';

async function resetDb() {
  await prisma.$transaction([
    prisma.rpcLimitOrder.deleteMany(),
    prisma.rpcExchangeTrade.deleteMany(),
    prisma.trade.deleteMany(),
    prisma.marketOrder.deleteMany(),
    prisma.withdrawalRequest.deleteMany(),
    prisma.wallet.deleteMany(),
    prisma.userRole.deleteMany(),
    prisma.role.deleteMany(),
    prisma.user.deleteMany(),
    prisma.platformAccount.deleteMany(),
  ]);
}

async function mkRole(key: string) { return prisma.role.create({ data: { key, name: key } }); }
async function mkUser(email: string) {
  return prisma.user.create({ data: { email, discord: email.replace(/[^a-z0-9]/gi, '_').toLowerCase(), gamePhone: `TEST-${email.replace(/[^a-z0-9]/gi, '_').slice(0, 24)}`, name: email, passwordHash: await bcrypt.hash(PASSWORD, 10), wallet: { create: {} } } });
}

async function auth(userId: string, roles: string[]) { return app.jwt.sign({ sub: userId, roles }); }

async function setupAdmin() {
  const adminRole = await mkRole('ADMIN');
  const admin = await mkUser('admin-alerts@test.local');
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
  return { admin, token: await auth(admin.id, ['ADMIN']) };
}

test.before(async () => { await app.ready(); await resetDb(); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('bloqueia usuário sem permissão com 403', async () => {
  await resetDb();
  const userRole = await mkRole('USER');
  const user = await mkUser('user-no-admin@test.local');
  await prisma.userRole.create({ data: { userId: user.id, roleId: userRole.id } });
  const token = await auth(user.id, ['USER']);

  const response = await app.inject({ method: 'GET', url: '/api/admin/economic-alerts', headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 403);
});

test('retorna base saudável sem alertas', async () => {
  await resetDb();
  const { token } = await setupAdmin();
  const response = await app.inject({ method: 'GET', url: '/api/admin/economic-alerts', headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.summary.total, 0);
  assert.deepEqual(body.alerts, []);
});

test('detecta wallet negativa e platform account negativa', async () => {
  await resetDb();
  const { token } = await setupAdmin();
  const u = await mkUser('negative-wallet@test.local');
  await prisma.wallet.update({ where: { userId: u.id }, data: { fiatLockedBalance: -1 } });
  await prisma.platformAccount.create({ data: { balance: -5 } });

  const response = await app.inject({ method: 'GET', url: '/api/admin/economic-alerts', headers: { authorization: `Bearer ${token}` } });
  const body = response.json();
  const codes = body.alerts.map((a: { code: string }) => a.code);
  assert.ok(codes.includes('NEGATIVE_WALLET_BALANCE'));
  assert.ok(codes.includes('NEGATIVE_PLATFORM_ACCOUNT'));
});

test('detecta saque pendente sem saldo pendente', async () => {
  await resetDb();
  const { token } = await setupAdmin();
  const u = await mkUser('withdrawal-gap@test.local');
  await prisma.withdrawalRequest.create({ data: { code: 'WD-001', userId: u.id, amount: 100, status: 'PENDING' } });

  const response = await app.inject({ method: 'GET', url: '/api/admin/economic-alerts', headers: { authorization: `Bearer ${token}` } });
  const codes = response.json().alerts.map((a: { code: string }) => a.code);
  assert.ok(codes.includes('WITHDRAWAL_WITHOUT_PENDING_BALANCE'));
});

test('detecta ordem OPEN RPC sem lock e trade RPC inconsistente', async () => {
  await resetDb();
  const { token } = await setupAdmin();
  const u = await mkUser('rpc-order@test.local');

  await prisma.rpcLimitOrder.create({ data: { userId: u.id, side: 'BUY_RPC', status: 'OPEN', limitPrice: 2, fiatAmount: 100, rpcAmount: 50, lockedFiatAmount: 0 } });
  await prisma.rpcExchangeTrade.create({ data: { userId: u.id, side: 'BUY_RPC', fiatAmount: 100, rpcAmount: 25, unitPrice: 1, priceBefore: 1, priceAfter: 1.1 } });

  const response = await app.inject({ method: 'GET', url: '/api/admin/economic-alerts', headers: { authorization: `Bearer ${token}` } });
  const codes = response.json().alerts.map((a: { code: string }) => a.code);
  assert.ok(codes.includes('OPEN_ORDER_WITHOUT_LOCK'));
  assert.ok(codes.includes('INCONSISTENT_RPC_TRADE_UNIT_PRICE'));
});
