import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { resetTestDatabase } from './helpers/reset-test-db.js';

if (process.env.NODE_ENV === 'production') throw new Error('Testes não podem rodar em produção.');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();
const PASSWORD = 'Admin@123';
const permissions = ['RPC_MARKET_TRADE', 'COMPANY_MARKET_TRADE', 'PROJECT_CREATE', 'WITHDRAWAL_REQUEST', 'BROKER_TRANSFER', 'FIAT_DEPOSIT_REQUEST'] as const;
const pngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const jpegData = '/9j/4AAQSkZJRgABAQAAAQABAAD/2w==';
const webpData = 'UklGRiAAAABXRUJQVlA4ICAAAAAwAQCdASoBAAEAAQAcJaQAA3AA/vuUAAA=';

async function mkUser(email: string, roles: string[] = ['USER'], approved = true) {
  const user = await prisma.user.create({
    data: {
      email,
      name: email.split('@')[0],
      discordId: email.split('@')[0],
      approvalStatus: approved ? 'APPROVED' : 'PENDING',
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      wallet: { create: {} },
    },
  });
  for (const key of roles) {
    const role = await prisma.role.upsert({ where: { key }, update: {}, create: { key, name: key } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  if (approved) {
    await prisma.userFinancialPermission.createMany({
      data: permissions.map((permission) => ({ userId: user.id, permission, grantedById: user.id, reason: 'fixture' })),
      skipDuplicates: true,
    });
  }
  return user;
}

async function token(userId: string, roles: string[]) {
  return app.jwt.sign({ sub: userId, roles });
}

async function resetDb() {
  await resetTestDatabase(prisma);
}

test.before(async () => {
  await app.ready();
  await resetDb();
});

test.after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('usuário cria depósito PLATFORM sem crédito automático, vê só os próprios, acessa print próprio e cancela PENDING', async () => {
  await resetDb();
  const user = await mkUser('dep-user@test.local');
  const other = await mkUser('dep-other@test.local');
  const userToken = await token(user.id, ['USER']);
  const otherToken = await token(other.id, ['USER']);
  await prisma.wallet.update({ where: { userId: user.id }, data: { fiatAvailableBalance: 10 } });

  const resp = await app.inject({
    method: 'POST',
    url: '/api/deposits',
    headers: { authorization: `Bearer ${userToken}`, 'idempotency-key': 'platform-proof-1' },
    payload: { amount: 123.45, method: 'PLATFORM', userNote: 'teste', screenshot: { mimeType: 'image/png', fileName: 'print.png', data: pngData } },
  });
  assert.equal(resp.statusCode, 201, resp.body);
  const body = JSON.parse(resp.body);
  assert.equal(body.status, 'PENDING');
  assert.equal(body.hasScreenshot, true);
  assert.equal(body.screenshotData, undefined);
  assert.equal(body.screenshotChecksum, undefined);
  assert.equal(body.idempotencyKey, undefined);
  assert.equal(body.requestHash, undefined);

  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
  assert.equal(String(wallet.fiatAvailableBalance), '10');

  const mine = await app.inject({ method: 'GET', url: '/api/deposits/me', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(mine.statusCode, 200, mine.body);
  assert.equal(JSON.parse(mine.body).deposits.length, 1);
  assert.equal(JSON.parse(mine.body).deposits[0].screenshotData, undefined);
  assert.equal(JSON.parse(mine.body).deposits[0].screenshotChecksum, undefined);
  assert.equal(JSON.parse(mine.body).deposits[0].idempotencyKey, undefined);
  assert.equal(JSON.parse(mine.body).deposits[0].requestHash, undefined);

  const otherMine = await app.inject({ method: 'GET', url: '/api/deposits/me', headers: { authorization: `Bearer ${otherToken}` } });
  assert.equal(JSON.parse(otherMine.body).deposits.length, 0);

  const screenshot = await app.inject({ method: 'GET', url: `/api/deposits/${body.id}/screenshot`, headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(screenshot.statusCode, 200, screenshot.body);
  assert.equal(screenshot.headers['content-type'], 'image/png');
  assert.equal(screenshot.headers['x-content-type-options'], 'nosniff');

  const otherScreenshot = await app.inject({ method: 'GET', url: `/api/deposits/${body.id}/screenshot`, headers: { authorization: `Bearer ${otherToken}` } });
  assert.equal(otherScreenshot.statusCode, 404);

  const cancel = await app.inject({ method: 'POST', url: `/api/deposits/${body.id}/cancel`, headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(JSON.parse(cancel.body).status, 'CANCELED');
});

test('usuário cria depósitos com screenshots JPEG/WEBP e rejeita screenshot inválido, MIME falso e arquivo acima do limite', async () => {
  await resetDb();
  const user = await mkUser('proofs@test.local');
  const userToken = await token(user.id, ['USER']);

  const jpeg = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}`, 'idempotency-key': 'jpeg-proof-1' }, payload: { amount: 1, method: 'PLATFORM', screenshot: { mimeType: 'image/jpeg', fileName: 'a.jpg', data: jpegData } } });
  assert.equal(jpeg.statusCode, 201, jpeg.body);
  const webp = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}`, 'idempotency-key': 'webp-proof-1' }, payload: { amount: 1, method: 'PLATFORM', screenshot: { mimeType: 'image/webp', fileName: 'a.webp', data: webpData } } });
  assert.equal(webp.statusCode, 201, webp.body);
  const invalidBase64 = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}` }, payload: { amount: 1, method: 'PLATFORM', screenshot: { mimeType: 'image/png', fileName: 'bad.png', data: 'not-base64' } } });
  assert.equal(invalidBase64.statusCode, 400);
  const fakeMime = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}` }, payload: { amount: 1, method: 'PLATFORM', screenshot: { mimeType: 'image/png', fileName: 'bad.png', data: jpegData } } });
  assert.equal(fakeMime.statusCode, 400);
  const tooLarge = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}` }, payload: { amount: 1, method: 'PLATFORM', screenshot: { mimeType: 'image/png', fileName: 'large.png', data: 'A'.repeat(2_800_000) } } });
  assert.equal(tooLarge.statusCode, 400);

  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
  assert.equal(String(wallet.fiatAvailableBalance), '0');
});

test('idempotência retorna mesmo depósito para mesma chave/payload e 409 para payload diferente', async () => {
  await resetDb();
  const user = await mkUser('idem@test.local');
  const userToken = await token(user.id, ['USER']);
  const payload = { amount: 30, method: 'PLATFORM', userNote: 'idem' };

  const first = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}`, 'idempotency-key': 'idem-key-0001' }, payload });
  assert.equal(first.statusCode, 201, first.body);
  const second = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}`, 'idempotency-key': 'idem-key-0001' }, payload });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(JSON.parse(second.body).id, JSON.parse(first.body).id);
  assert.equal(await prisma.depositRequest.count({ where: { userId: user.id } }), 1);

  const conflict = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}`, 'idempotency-key': 'idem-key-0001' }, payload: { amount: 31, method: 'PLATFORM', userNote: 'idem' } });
  assert.equal(conflict.statusCode, 409, conflict.body);

  const [parallelA, parallelB] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}`, 'idempotency-key': 'idem-key-parallel' }, payload: { amount: 40, method: 'PLATFORM', userNote: 'parallel' } }),
    app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}`, 'idempotency-key': 'idem-key-parallel' }, payload: { amount: 40, method: 'PLATFORM', userNote: 'parallel' } }),
  ]);
  assert.ok([200, 201].includes(parallelA.statusCode), parallelA.body);
  assert.ok([200, 201].includes(parallelB.statusCode), parallelB.body);
  assert.equal(JSON.parse(parallelA.body).id, JSON.parse(parallelB.body).id);
  assert.equal(await prisma.depositRequest.count({ where: { userId: user.id, idempotencyKey: 'idem-key-parallel' } }), 1);
});

test('admin processa, conclui e rejeita depósitos PLATFORM com Transaction/AdminLog e bloqueia usuário comum/próprio depósito/BROKER', async () => {
  await resetDb();
  const user = await mkUser('player@test.local');
  const admin = await mkUser('admin@test.local', ['ADMIN']);
  const broker = await mkUser('admin-broker@test.local', ['VIRTUAL_BROKER']);
  await prisma.brokerAccount.create({ data: { userId: broker.id, available: 100, receivedTotal: 100 } });
  await prisma.treasuryAccount.create({ data: { balance: 100 } });
  const adminToken = await token(admin.id, ['ADMIN']);
  const userToken = await token(user.id, ['USER']);

  const create = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}` }, payload: { amount: 50, method: 'PLATFORM', screenshot: { mimeType: 'image/png', fileName: 'admin-view.png', data: pngData } } });
  const id = JSON.parse(create.body).id;
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/deposits', headers: { authorization: `Bearer ${userToken}` } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/deposits', headers: { authorization: `Bearer ${adminToken}` } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/admin/deposits/${id}/screenshot`, headers: { authorization: `Bearer ${adminToken}` } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/deposits/${id}/mark-processing`, headers: { authorization: `Bearer ${adminToken}` }, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/deposits/${id}/cancel`, headers: { authorization: `Bearer ${userToken}` } })).statusCode, 400);

  const complete = await app.inject({ method: 'POST', url: `/api/admin/deposits/${id}/complete`, headers: { authorization: `Bearer ${adminToken}` }, payload: { adminNote: 'ok' } });
  assert.equal(complete.statusCode, 200, complete.body);
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
  assert.equal(String(wallet.fiatAvailableBalance), '50');
  const treasuryAfterPlatform = await prisma.treasuryAccount.findFirstOrThrow();
  assert.equal(String(treasuryAfterPlatform.balance), '50');
  assert.equal(await prisma.transaction.count({ where: { walletId: wallet.id, type: 'FIAT_DEPOSIT_COMPLETED' } }), 1);
  assert.equal(await prisma.adminLog.count({ where: { action: 'FIAT_DEPOSIT_COMPLETED' } }), 1);
  assert.equal(await prisma.coinTransfer.count({ where: { receiverId: user.id, type: 'ADJUSTMENT' } }), 1);

  const rejectCreate = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}` }, payload: { amount: 10, method: 'PLATFORM' } });
  const rejectId = JSON.parse(rejectCreate.body).id;
  const reject = await app.inject({ method: 'POST', url: `/api/admin/deposits/${rejectId}/reject`, headers: { authorization: `Bearer ${adminToken}` }, payload: { adminNote: 'não' } });
  assert.equal(reject.statusCode, 200, reject.body);
  assert.equal((await app.inject({ method: 'POST', url: `/api/deposits/${rejectId}/cancel`, headers: { authorization: `Bearer ${userToken}` } })).statusCode, 400);
  const walletAfterReject = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
  assert.equal(String(walletAfterReject.fiatAvailableBalance), '50');

  const ownCreate = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${adminToken}` }, payload: { amount: 5, method: 'PLATFORM' } });
  const ownComplete = await app.inject({ method: 'POST', url: `/api/admin/deposits/${JSON.parse(ownCreate.body).id}/complete`, headers: { authorization: `Bearer ${adminToken}` }, payload: {} });
  assert.equal(ownComplete.statusCode, 400);

  const brokerDeposit = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}` }, payload: { amount: 20, method: 'BROKER', brokerUserId: broker.id } });
  const brokerDepositId = JSON.parse(brokerDeposit.body).id;
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/deposits/${brokerDepositId}/complete`, headers: { authorization: `Bearer ${adminToken}` }, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/deposits/${brokerDepositId}/reject`, headers: { authorization: `Bearer ${adminToken}` }, payload: {} })).statusCode, 200);
});

test('corretor só processa depósito BROKER atribuído, vê print, exige saldo e não conclui para si mesmo ou em duplicidade', async () => {
  await resetDb();
  const user = await mkUser('broker-player@test.local');
  const broker = await mkUser('broker@test.local', ['VIRTUAL_BROKER']);
  const otherBroker = await mkUser('other-broker@test.local', ['VIRTUAL_BROKER']);
  await prisma.brokerAccount.create({ data: { userId: broker.id, available: 100, receivedTotal: 100 } });
  await prisma.brokerAccount.create({ data: { userId: otherBroker.id, available: 100, receivedTotal: 100 } });
  const userToken = await token(user.id, ['USER']);
  const brokerToken = await token(broker.id, ['VIRTUAL_BROKER']);
  const otherBrokerToken = await token(otherBroker.id, ['VIRTUAL_BROKER']);

  const create = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}` }, payload: { amount: 80, method: 'BROKER', brokerUserId: broker.id, screenshot: { mimeType: 'image/png', fileName: 'broker.png', data: pngData } } });
  assert.equal(create.statusCode, 201, create.body);
  const id = JSON.parse(create.body).id;
  assert.equal(JSON.parse((await app.inject({ method: 'GET', url: '/api/broker/deposits', headers: { authorization: `Bearer ${brokerToken}` } })).body).deposits.length, 1);
  assert.equal(JSON.parse((await app.inject({ method: 'GET', url: '/api/broker/deposits', headers: { authorization: `Bearer ${otherBrokerToken}` } })).body).deposits.length, 0);
  assert.equal((await app.inject({ method: 'GET', url: `/api/broker/deposits/${id}/screenshot`, headers: { authorization: `Bearer ${brokerToken}` } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/broker/deposits/${id}/screenshot`, headers: { authorization: `Bearer ${otherBrokerToken}` } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/broker/deposits/${id}/complete`, headers: { authorization: `Bearer ${otherBrokerToken}` }, payload: {} })).statusCode, 400);

  const proc = await app.inject({ method: 'POST', url: `/api/broker/deposits/${id}/mark-processing`, headers: { authorization: `Bearer ${brokerToken}` }, payload: {} });
  assert.equal(proc.statusCode, 200, proc.body);
  const complete = await app.inject({ method: 'POST', url: `/api/broker/deposits/${id}/complete`, headers: { authorization: `Bearer ${brokerToken}` }, payload: {} });
  assert.equal(complete.statusCode, 200, complete.body);
  const brokerAccount = await prisma.brokerAccount.findUniqueOrThrow({ where: { userId: broker.id } });
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
  assert.equal(String(brokerAccount.available), '20');
  assert.equal(String(wallet.fiatAvailableBalance), '80');
  assert.equal(await prisma.transaction.count({ where: { walletId: wallet.id, type: 'BROKER_FIAT_TRANSFER_IN' } }), 1);
  assert.equal(await prisma.adminLog.count({ where: { action: 'BROKER_DEPOSIT_COMPLETED' } }), 1);
  assert.equal((await app.inject({ method: 'POST', url: `/api/broker/deposits/${id}/complete`, headers: { authorization: `Bearer ${brokerToken}` }, payload: {} })).statusCode, 400);

  const self = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${brokerToken}` }, payload: { amount: 5, method: 'BROKER', brokerUserId: broker.id } });
  assert.equal(self.statusCode, 400);
});

test('valida login, permissão financeira, valor positivo, limite pendente e saldo insuficiente do corretor', async () => {
  await resetDb();
  const user = await mkUser('limits@test.local');
  const noPerm = await mkUser('noperm@test.local');
  await prisma.userFinancialPermission.deleteMany({ where: { userId: noPerm.id, permission: 'FIAT_DEPOSIT_REQUEST' } });
  const broker = await mkUser('poor-broker@test.local', ['VIRTUAL_BROKER']);
  await prisma.brokerAccount.create({ data: { userId: broker.id, available: 1, receivedTotal: 1 } });
  const userToken = await token(user.id, ['USER']);
  const noPermToken = await token(noPerm.id, ['USER']);
  const brokerToken = await token(broker.id, ['VIRTUAL_BROKER']);

  assert.equal((await app.inject({ method: 'POST', url: '/api/deposits', payload: { amount: 1, method: 'PLATFORM' } })).statusCode, 401);
  const noPermResp = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${noPermToken}` }, payload: { amount: 1, method: 'PLATFORM' } });
  assert.equal(noPermResp.statusCode, 400);
  assert.match(noPermResp.body, /Permissão financeira/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}` }, payload: { amount: 0, method: 'PLATFORM' } })).statusCode, 400);

  for (let i = 0; i < 3; i++) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}` }, payload: { amount: 1, method: 'PLATFORM' } })).statusCode, 201);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${userToken}` }, payload: { amount: 1, method: 'PLATFORM' } })).statusCode, 400);

  const user2 = await mkUser('insufficient@test.local');
  const user2Token = await token(user2.id, ['USER']);
  const dep = await app.inject({ method: 'POST', url: '/api/deposits', headers: { authorization: `Bearer ${user2Token}` }, payload: { amount: 10, method: 'BROKER', brokerUserId: broker.id } });
  const complete = await app.inject({ method: 'POST', url: `/api/broker/deposits/${JSON.parse(dep.body).id}/complete`, headers: { authorization: `Bearer ${brokerToken}` }, payload: {} });
  assert.equal(complete.statusCode, 400);
});
