import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { RPC_MARKET_MAX_OPEN_ORDERS_PER_USER } from '../src/config/anti-abuse-limits.js';
import { resetTestDatabase } from './helpers/reset-test-db.js';

if (process.env.NODE_ENV === 'production') throw new Error('Testes não podem rodar em produção.');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
if ((process.env.DATABASE_URL || '').includes('railway') && !process.env.TEST_DATABASE_URL) throw new Error('Recusado: sem TEST_DATABASE_URL isolado.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([
  import('../src/app.js'),
  import('../src/lib/prisma.js'),
]);

const app = buildApp();
const ADMIN_PASSWORD = 'Admin@123';

async function resetDb() {
  await resetTestDatabase(prisma);
}

async function mkUser(email: string, name = 'User') {
  const user = await prisma.user.create({ data: { email, name, approvalStatus: 'APPROVED', passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10), wallet: { create: {} } } });
  await grantTestFinancialPermissions(user.id);
  return user;
}

async function grantTestFinancialPermissions(userId: string) {
  await prisma.userFinancialPermission.createMany({ data: (['RPC_MARKET_TRADE', 'COMPANY_MARKET_TRADE', 'PROJECT_CREATE', 'WITHDRAWAL_REQUEST', 'BROKER_TRANSFER'] as const).map((permission) => ({ userId, permission, grantedById: userId, reason: 'Permissão financeira em fixture de teste' })), skipDuplicates: true });
}

async function mkRole(key: string) {
  return prisma.role.create({ data: { key, name: key } });
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

test('matching multi-fill mantém saldos, locks e taxa', async () => {
  await resetDb();

  const rUser = await mkRole('USER');
  const buyer = await mkUser('buyer@test.local', 'Buyer');
  const sellers = await Promise.all([mkUser('s1@test.local'), mkUser('s2@test.local'), mkUser('s3@test.local')]);

  for (const u of [buyer, ...sellers]) {
    await prisma.userRole.create({ data: { userId: u.id, roleId: rUser.id } });
  }

  await prisma.platformAccount.create({ data: {} });

  await prisma.wallet.update({ where: { userId: buyer.id }, data: { rpcAvailableBalance: 1000 } });
  const company = await prisma.company.create({
    data: {
      name: 'Comp',
      ticker: 'CMP1',
      description: 'd',
      sector: 's',
      founderUserId: buyer.id,
      status: 'ACTIVE',
      totalShares: 1000,
      circulatingShares: 300,
      ownerSharePercent: 40,
      publicOfferPercent: 60,
      ownerShares: 400,
      publicOfferShares: 600,
      availableOfferShares: 300,
      initialPrice: 10,
      currentPrice: 10,
      buyFeePercent: 1,
      sellFeePercent: 1,
      fictitiousMarketCap: 10000,
      approvedAt: new Date(),
      revenueAccount: { create: {} },
    },
  });

  for (const s of sellers) {
    await prisma.companyHolding.create({
      data: { userId: s.id, companyId: company.id, shares: 100, averageBuyPrice: 10, estimatedValue: 1000 },
    });
  }

  for (const s of sellers) {
    const tk = await token(s.id, ['USER']);
    const sellResp = await app.inject({
      method: 'POST',
      url: '/api/market/orders',
      headers: { authorization: `Bearer ${tk}` },
      payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 10, limitPrice: 10 },
    });
    assert.equal(sellResp.statusCode, 201, sellResp.body);
  }

  const buyerToken = await token(buyer.id, ['USER']);
  const buyResp = await app.inject({
    method: 'POST',
    url: '/api/market/orders',
    headers: { authorization: `Bearer ${buyerToken}` },
    payload: { companyId: company.id, type: 'BUY', mode: 'LIMIT', quantity: 30, limitPrice: 10 },
  });
  assert.equal(buyResp.statusCode, 201, buyResp.body);

  const trades = await prisma.trade.findMany({ where: { companyId: company.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(trades.length, 3);

  const buyOrder = await prisma.marketOrder.findFirstOrThrow({ where: { companyId: company.id, userId: buyer.id, type: 'BUY' } });
  assert.ok(['FILLED', 'PARTIALLY_FILLED'].includes(buyOrder.status));

  const sellerOrders = await prisma.marketOrder.findMany({ where: { companyId: company.id, type: 'SELL' } });
  assert.ok(sellerOrders.every((o) => o.status === 'FILLED'));

  const buyerHolding = await prisma.companyHolding.findUniqueOrThrow({ where: { userId_companyId: { userId: buyer.id, companyId: company.id } } });
  assert.equal(buyerHolding.shares, 30);

  const companyAfter = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(String(companyAfter.currentPrice), String(trades[trades.length - 1].unitPrice));

  const wallets = await prisma.wallet.findMany();
  assert.ok(wallets.every((w) => Number(w.rpcAvailableBalance) >= 0));
  assert.ok(wallets.every((w) => Number(w.rpcLockedBalance) >= 0));

  const allOrders = await prisma.marketOrder.findMany();
  assert.ok(allOrders.every((o) => Number(o.lockedCash) >= 0));
  assert.ok(allOrders.every((o) => Number(o.lockedShares) >= 0));

  const fees = await prisma.feeDistribution.findMany({ where: { companyId: company.id } });
  assert.ok(fees.length > 0);

  const platform = await prisma.platformAccount.findFirstOrThrow();
  const revenue = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  assert.ok(Number(platform.balance) > 0);
  assert.ok(Number(revenue.balance) > 0);
});

test('export csv exige admin e broker-report valida corretor', async () => {
  await resetDb();

  const rAdmin = await mkRole('ADMIN');
  const rUser = await mkRole('USER');
  const admin = await mkUser('admin@test.local');
  const user = await mkUser('user@test.local');

  await prisma.userRole.createMany({ data: [{ userId: admin.id, roleId: rAdmin.id }, { userId: user.id, roleId: rUser.id }] });

  const adminToken = await token(admin.id, ['ADMIN']);
  const userToken = await token(user.id, ['USER']);

  const ok = await app.inject({ method: 'GET', url: '/api/admin/reports/export/transactions', headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match(ok.headers['content-type'] || '', /text\/csv/);
  assert.match(ok.body, /type|id/i);

  const forbidden = await app.inject({ method: 'GET', url: '/api/admin/reports/export/transactions', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(forbidden.statusCode, 403, forbidden.body);

  const notBroker = await app.inject({ method: 'GET', url: `/api/admin/reports/export/broker-report?userId=${user.id}`, headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(notBroker.statusCode, 400, notBroker.body);
  assert.match(notBroker.body, /não é corretor/i);
});

test('compra inicial altera preço, cria operação e não cria trade', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const buyer = await mkUser('initialbuyer@test.local', 'Initial Buyer');
  await prisma.userRole.create({ data: { userId: buyer.id, roleId: rUser.id } });
  await prisma.platformAccount.create({ data: {} });
  await prisma.wallet.update({ where: { userId: buyer.id }, data: { rpcAvailableBalance: 5000 } });

  const company = await prisma.company.create({
    data: {
      name: 'Oferta Inicial', ticker: 'INIT1', description: 'desc', sector: 'setor', founderUserId: buyer.id, status: 'ACTIVE', totalShares: 1000,
      circulatingShares: 0, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 600,
      initialPrice: 10, currentPrice: 10, buyFeePercent: 2, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(),
      revenueAccount: { create: {} }, initialOffer: { create: { totalShares: 600, availableShares: 600 } },
    },
  });

  const buyerToken = await token(buyer.id, ['USER']);
  const response = await app.inject({
    method: 'POST',
    url: `/api/companies/${company.id}/buy-initial-offer`,
    headers: { authorization: `Bearer ${buyerToken}` },
    payload: { quantity: 50 },
  });

  assert.equal(response.statusCode, 201, response.body);
  const payload = response.json();
  assert.ok(payload.priceBefore);
  assert.ok(payload.priceAfter);
  assert.ok(Number(payload.priceAfter) > Number(payload.priceBefore));
  assert.equal(String(payload.currentPrice), String(payload.priceAfter));

  const companyAfter = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  const holding = await prisma.companyHolding.findUniqueOrThrow({ where: { userId_companyId: { userId: buyer.id, companyId: company.id } } });
  const op = await prisma.companyOperation.findFirst({ where: { companyId: company.id, userId: buyer.id, type: 'INITIAL_OFFER_BUY' } });
  const fees = await prisma.feeDistribution.findMany({ where: { companyId: company.id } });
  const platform = await prisma.platformAccount.findFirstOrThrow();
  const revenue = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  const tradesCount = await prisma.trade.count({ where: { companyId: company.id } });

  assert.ok(Number(companyAfter.currentPrice) > 10);
  assert.equal(holding.shares, 50);
  assert.ok(op);
  assert.ok(fees.length > 0);
  assert.ok(Number(platform.balance) > 0);
  assert.ok(Number(revenue.balance) > 0);
  assert.equal(tradesCount, 0);
});

test('tesouraria envia RPC para corretor e corretor envia para jogador', async () => {
  await resetDb();
  const rSuper = await mkRole('SUPER_ADMIN');
  const rBroker = await mkRole('VIRTUAL_BROKER');
  const rUser = await mkRole('USER');

  const admin = await mkUser('super@test.local', 'Super');
  const broker = await mkUser('broker@test.local', 'Broker');
  const player = await mkUser('player@test.local', 'Player');

  await prisma.userRole.createMany({ data: [
    { userId: admin.id, roleId: rSuper.id },
    { userId: broker.id, roleId: rBroker.id },
    { userId: player.id, roleId: rUser.id },
  ] });

  await prisma.treasuryAccount.create({ data: { balance: 0 } });

  const adminToken = await token(admin.id, ['SUPER_ADMIN']);
  const brokerToken = await token(broker.id, ['VIRTUAL_BROKER']);

  const issuance = await app.inject({ method: 'POST', url: '/api/admin/treasury/issuance', headers: { authorization: `Bearer ${adminToken}` }, payload: { amount: 1000, reason: 'emissão teste' } });
  assert.equal(issuance.statusCode, 201, issuance.body);

  const toBroker = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-broker', headers: { authorization: `Bearer ${adminToken}` }, payload: { brokerUserId: broker.id, amount: 400, reason: 'repasse corretor' } });
  assert.equal(toBroker.statusCode, 201, toBroker.body);

  const toPlayer = await app.inject({ method: 'POST', url: '/api/broker/transfer-to-user', headers: { authorization: `Bearer ${brokerToken}` }, payload: { userId: player.id, amount: 150, reason: 'repasse jogador' } });
  assert.equal(toPlayer.statusCode, 201, toPlayer.body);

  const treasury = await prisma.treasuryAccount.findFirstOrThrow();
  const brokerAccount = await prisma.brokerAccount.findUniqueOrThrow({ where: { userId: broker.id } });
  const playerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } });
  const transfers = await prisma.coinTransfer.findMany();
  const adminLogs = await prisma.adminLog.findMany();

  assert.equal(Number(treasury.balance), 600);
  assert.equal(Number(brokerAccount.available), 250);
  assert.equal(Number(playerWallet.fiatAvailableBalance), 150);
  assert.equal(Number(playerWallet.availableBalance), 0);
  assert.equal(Number(playerWallet.rpcAvailableBalance), 0);
  assert.ok(transfers.length >= 2);
  assert.ok(adminLogs.length >= 3);
  assert.ok(Number(treasury.balance) >= 0);
  assert.ok(Number(brokerAccount.available) >= 0);
  assert.ok(Number(playerWallet.fiatAvailableBalance) >= 0);
});

test('admin deposita R$ direto em jogador com débito atômico da tesouraria', async () => {
  await resetDb();
  const rSuper = await mkRole('SUPER_ADMIN');
  const rUser = await mkRole('USER');

  const admin = await mkUser('admin2@test.local');
  const player = await mkUser('player2@test.local');
  const commonUser = await mkUser('common@test.local');

  await prisma.userRole.createMany({ data: [
    { userId: admin.id, roleId: rSuper.id },
    { userId: player.id, roleId: rUser.id },
    { userId: commonUser.id, roleId: rUser.id },
  ] });

  await prisma.treasuryAccount.create({ data: { balance: 500 } });

  const adminToken = await token(admin.id, ['SUPER_ADMIN']);
  const userToken = await token(commonUser.id, ['USER']);

  const missingPassword = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-user', headers: { authorization: `Bearer ${adminToken}` }, payload: { userId: player.id, amount: 120, reason: 'ajuste adm sem senha' } });
  assert.equal(missingPassword.statusCode, 400, missingPassword.body);
  assert.match(missingPassword.body, /confirme sua senha para continuar/i);

  const invalidPassword = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-user', headers: { authorization: `Bearer ${adminToken}` }, payload: { userId: player.id, amount: 120, reason: 'ajuste adm senha inválida', adminPassword: 'senha-errada' } });
  assert.equal(invalidPassword.statusCode, 400, invalidPassword.body);
  assert.match(invalidPassword.body, /senha administrativa inválida/i);

  const ok = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-user', headers: { authorization: `Bearer ${adminToken}` }, payload: { userId: player.id, amount: 120, reason: 'ajuste adm', adminPassword: ADMIN_PASSWORD } });
  assert.equal(ok.statusCode, 201, ok.body);

  const treasury = await prisma.treasuryAccount.findFirstOrThrow();
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } });
  const tx = await prisma.transaction.findFirst({ where: { walletId: wallet.id, type: 'ADMIN_TREASURY_FIAT_TRANSFER_IN' } });
  const adjustment = await prisma.coinTransfer.findFirst({ where: { receiverId: player.id, type: 'ADJUSTMENT' } });
  const adminLog = await prisma.adminLog.findFirst({ where: { action: 'TREASURY_TRANSFER_TO_USER' } });

  assert.equal(Number(treasury.balance), 380);
  assert.equal(Number(wallet.fiatAvailableBalance), 120);
  assert.equal(Number(wallet.rpcAvailableBalance), 0);
  assert.equal(Number(wallet.availableBalance), 0);
  assert.ok(tx);
  assert.ok(adjustment);
  assert.ok(adminLog);

  const insufficient = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-user', headers: { authorization: `Bearer ${adminToken}` }, payload: { userId: player.id, amount: 999999, reason: 'sem saldo', adminPassword: ADMIN_PASSWORD } });
  assert.equal(insufficient.statusCode, 400, insufficient.body);
  assert.match(insufficient.body, /saldo.*insuficiente/i);

  const forbidden = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-user', headers: { authorization: `Bearer ${userToken}` }, payload: { userId: player.id, amount: 10, reason: 'forbidden' } });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  const walletAfterForbidden = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } });
  assert.equal(Number(walletAfterForbidden.fiatAvailableBalance), 120);
});

test('operações sensíveis bloqueiam referência ambígua e preservam id/email técnico', async () => {
  await resetDb();
  const rSuper = await mkRole('SUPER_ADMIN');
  const rBroker = await mkRole('VIRTUAL_BROKER');
  const rAdmin = await mkRole('ADMIN');
  const rUser = await mkRole('USER');

  const superAdmin = await mkUser('super-amb@test.local', 'Super Amb');
  const userA = await mkUser('player-amb-a@test.local', 'Player Amb');
  const userB = await mkUser('player-amb-b@test.local', 'Player Amb');
  const uniqueUser = await mkUser('player-unique@test.local', 'Player Unique');
  const brokerA = await mkUser('broker-amb-a@test.local', 'Broker Amb');
  const brokerB = await mkUser('broker-amb-b@test.local', 'Broker Amb');
  const brokerSender = await mkUser('broker-sender@test.local', 'Broker Sender');
  const adminA = await mkUser('admin-amb-a@test.local', 'Admin Amb');
  const adminB = await mkUser('admin-amb-b@test.local', 'Admin Amb');

  await prisma.userRole.createMany({ data: [
    { userId: superAdmin.id, roleId: rSuper.id },
    { userId: userA.id, roleId: rUser.id },
    { userId: userB.id, roleId: rUser.id },
    { userId: uniqueUser.id, roleId: rUser.id },
    { userId: brokerA.id, roleId: rBroker.id },
    { userId: brokerB.id, roleId: rBroker.id },
    { userId: brokerSender.id, roleId: rBroker.id },
    { userId: adminA.id, roleId: rAdmin.id },
    { userId: adminB.id, roleId: rAdmin.id },
  ] });

  await prisma.user.update({ where: { id: userA.id }, data: { characterName: 'Duplicado RP' } });
  await prisma.user.update({ where: { id: userB.id }, data: { characterName: 'Duplicado RP' } });
  await prisma.user.update({ where: { id: uniqueUser.id }, data: { bankAccountNumber: 'RP-UNICO-001' } });
  await prisma.user.update({ where: { id: brokerA.id }, data: { name: 'Corretor Duplicado' } });
  await prisma.user.update({ where: { id: brokerB.id }, data: { name: 'Corretor Duplicado' } });
  await prisma.user.update({ where: { id: adminA.id }, data: { name: 'Admin Duplicado' } });
  await prisma.user.update({ where: { id: adminB.id }, data: { name: 'Admin Duplicado' } });

  await prisma.treasuryAccount.create({ data: { balance: 1000 } });
  await prisma.platformAccount.create({ data: { balance: 900, totalReceivedFees: 900, totalWithdrawn: 0 } });
  await prisma.brokerAccount.create({ data: { userId: brokerSender.id, available: 500, receivedTotal: 500 } });

  const superToken = await token(superAdmin.id, ['SUPER_ADMIN']);
  const brokerToken = await token(brokerSender.id, ['VIRTUAL_BROKER']);

  const uniqueByRef = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-user', headers: { authorization: `Bearer ${superToken}` }, payload: { userRef: 'RP-UNICO-001', amount: 50, reason: 'depósito por ref única', adminPassword: ADMIN_PASSWORD } });
  assert.equal(uniqueByRef.statusCode, 201, uniqueByRef.body);

  const ambiguousUserRef = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-user', headers: { authorization: `Bearer ${superToken}` }, payload: { userRef: 'Duplicado RP', amount: 10, reason: 'deve bloquear', adminPassword: ADMIN_PASSWORD } });
  assert.equal(ambiguousUserRef.statusCode, 400, ambiguousUserRef.body);
  assert.match(ambiguousUserRef.body, /referência ambígua/i);

  const ambiguousBrokerRef = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-broker', headers: { authorization: `Bearer ${superToken}` }, payload: { brokerRef: 'Corretor Duplicado', amount: 20, reason: 'deve bloquear' } });
  assert.equal(ambiguousBrokerRef.statusCode, 400, ambiguousBrokerRef.body);
  assert.match(ambiguousBrokerRef.body, /referência ambígua/i);

  const ambiguousBrokerUserRef = await app.inject({ method: 'POST', url: '/api/broker/transfer-to-user', headers: { authorization: `Bearer ${brokerToken}` }, payload: { userRef: 'Duplicado RP', amount: 10, reason: 'deve bloquear' } });
  assert.equal(ambiguousBrokerUserRef.statusCode, 400, ambiguousBrokerUserRef.body);
  assert.match(ambiguousBrokerUserRef.body, /referência ambígua/i);

  const emailStillWorks = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-user', headers: { authorization: `Bearer ${superToken}` }, payload: { userEmail: 'player-unique@test.local', amount: 10, reason: 'email técnico', adminPassword: ADMIN_PASSWORD } });
  assert.equal(emailStillWorks.statusCode, 201, emailStillWorks.body);

  const idStillWorks = await app.inject({ method: 'POST', url: '/api/admin/platform-account/withdraw-to-admin', headers: { authorization: `Bearer ${superToken}` }, payload: { adminId: adminA.id, amount: 20, reason: 'saque admin por id', adminPassword: ADMIN_PASSWORD } });
  assert.equal(idStillWorks.statusCode, 201, idStillWorks.body);
});


test('fluxos financeiros resolvem destinatários por Discord normalizado', async () => {
  await resetDb();
  const rSuper = await mkRole('SUPER_ADMIN');
  const rAdmin = await mkRole('ADMIN');
  const rBroker = await mkRole('VIRTUAL_BROKER');
  const rUser = await mkRole('USER');

  const superAdmin = await mkUser('super-discord@test.local', 'Super Discord');
  const playerA = await mkUser('player-discord-a@test.local', 'Nome Repetido');
  const playerB = await mkUser('player-discord-b@test.local', 'Nome Repetido');
  const brokerSender = await mkUser('broker-sender-discord@test.local', 'Broker Sender Discord');
  const brokerTarget = await mkUser('broker-target-discord@test.local', 'Broker Target Discord');
  const adminTarget = await mkUser('admin-target-discord@test.local', 'Admin Target Discord');

  await prisma.userRole.createMany({ data: [
    { userId: superAdmin.id, roleId: rSuper.id },
    { userId: playerA.id, roleId: rUser.id },
    { userId: playerB.id, roleId: rUser.id },
    { userId: brokerSender.id, roleId: rBroker.id },
    { userId: brokerTarget.id, roleId: rBroker.id },
    { userId: adminTarget.id, roleId: rAdmin.id },
  ] });

  await prisma.user.update({ where: { id: playerA.id }, data: { discordId: 'player-alpha' } });
  await prisma.user.update({ where: { id: playerB.id }, data: { discordId: 'player-beta' } });
  await prisma.user.update({ where: { id: brokerSender.id }, data: { discordId: 'broker-sender' } });
  await prisma.user.update({ where: { id: brokerTarget.id }, data: { discordId: 'broker-target' } });
  await prisma.user.update({ where: { id: adminTarget.id }, data: { discordId: 'admin-target' } });

  await prisma.treasuryAccount.create({ data: { balance: 1000 } });
  await prisma.platformAccount.create({ data: { balance: 500, totalReceivedFees: 500, totalWithdrawn: 0 } });
  await prisma.brokerAccount.create({ data: { userId: brokerSender.id, available: 200, receivedTotal: 200 } });

  const superToken = await token(superAdmin.id, ['SUPER_ADMIN']);
  const brokerToken = await token(brokerSender.id, ['VIRTUAL_BROKER']);

  const ambiguousName = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-user', headers: { authorization: `Bearer ${superToken}` }, payload: { userRef: 'Nome Repetido', amount: 10, reason: 'nome ambíguo', adminPassword: ADMIN_PASSWORD } });
  assert.equal(ambiguousName.statusCode, 400, ambiguousName.body);
  assert.match(ambiguousName.body, /referência ambígua/i);

  const treasuryToPlayer = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-user', headers: { authorization: `Bearer ${superToken}` }, payload: { userRef: '@PLAYER-BETA', amount: 70, reason: 'depósito por discord', adminPassword: ADMIN_PASSWORD } });
  assert.equal(treasuryToPlayer.statusCode, 201, treasuryToPlayer.body);

  const playerAWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: playerA.id } });
  const playerBWalletAfterTreasury = await prisma.wallet.findUniqueOrThrow({ where: { userId: playerB.id } });
  assert.equal(Number(playerAWallet.fiatAvailableBalance), 0);
  assert.equal(Number(playerBWalletAfterTreasury.fiatAvailableBalance), 70);

  const treasuryToBroker = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-broker', headers: { authorization: `Bearer ${superToken}` }, payload: { brokerRef: 'BROKER-TARGET', amount: 80, reason: 'envio ao corretor por discord' } });
  assert.equal(treasuryToBroker.statusCode, 201, treasuryToBroker.body);
  const brokerTargetAccount = await prisma.brokerAccount.findUniqueOrThrow({ where: { userId: brokerTarget.id } });
  assert.equal(Number(brokerTargetAccount.available), 80);
  assert.equal(Number(brokerTargetAccount.receivedTotal), 80);

  const brokerToPlayer = await app.inject({ method: 'POST', url: '/api/broker/transfer-to-user', headers: { authorization: `Bearer ${brokerToken}` }, payload: { userRef: '@PLAYER-ALPHA', amount: 25, reason: 'corretor por discord' } });
  assert.equal(brokerToPlayer.statusCode, 201, brokerToPlayer.body);
  const playerAWalletAfterBroker = await prisma.wallet.findUniqueOrThrow({ where: { userId: playerA.id } });
  const brokerSenderAccount = await prisma.brokerAccount.findUniqueOrThrow({ where: { userId: brokerSender.id } });
  assert.equal(Number(playerAWalletAfterBroker.fiatAvailableBalance), 25);
  assert.equal(Number(brokerSenderAccount.available), 175);

  const platformWithdraw = await app.inject({ method: 'POST', url: '/api/admin/platform-account/withdraw-to-admin', headers: { authorization: `Bearer ${superToken}` }, payload: { adminRef: '@ADMIN-TARGET', amount: 40, reason: 'retirada por discord', adminPassword: ADMIN_PASSWORD } });
  assert.equal(platformWithdraw.statusCode, 201, platformWithdraw.body);
  const adminWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: adminTarget.id } });
  const platformAccount = await prisma.platformAccount.findFirstOrThrow();
  assert.equal(Number(adminWallet.fiatAvailableBalance), 40);
  assert.equal(Number(platformAccount.balance), 460);
  assert.equal(Number(platformAccount.totalWithdrawn), 40);

  const countsBeforeInvalid = {
    transactions: await prisma.transaction.count(),
    transfers: await prisma.coinTransfer.count(),
    logs: await prisma.adminLog.count(),
  };
  const treasuryBeforeInvalid = await prisma.treasuryAccount.findFirstOrThrow();
  const invalidDiscord = await app.inject({ method: 'POST', url: '/api/admin/treasury/transfer-to-user', headers: { authorization: `Bearer ${superToken}` }, payload: { userRef: '@discord-inexistente', amount: 99, reason: 'discord inexistente', adminPassword: ADMIN_PASSWORD } });
  assert.equal(invalidDiscord.statusCode, 400, invalidDiscord.body);
  assert.match(invalidDiscord.body, /usuário não encontrado/i);
  const treasuryAfterInvalid = await prisma.treasuryAccount.findFirstOrThrow();
  assert.equal(String(treasuryAfterInvalid.balance), String(treasuryBeforeInvalid.balance));
  assert.equal(await prisma.transaction.count(), countsBeforeInvalid.transactions);
  assert.equal(await prisma.coinTransfer.count(), countsBeforeInvalid.transfers);
  assert.equal(await prisma.adminLog.count(), countsBeforeInvalid.logs);

  const adjustmentTransfers = await prisma.coinTransfer.findMany({ where: { type: 'ADJUSTMENT' } });
  const brokerTransfers = await prisma.coinTransfer.findMany({ where: { type: 'TREASURY_TO_BROKER' } });
  const brokerUserTransfers = await prisma.coinTransfer.findMany({ where: { type: 'BROKER_TO_USER' } });
  const transactionTypes = await prisma.transaction.findMany({ select: { type: true } });
  const adminLogActions = await prisma.adminLog.findMany({ select: { action: true } });

  assert.equal(adjustmentTransfers.length, 1);
  assert.equal(brokerTransfers.length, 1);
  assert.equal(brokerUserTransfers.length, 1);
  assert.ok(transactionTypes.some((item) => item.type === 'ADMIN_TREASURY_FIAT_TRANSFER_IN'));
  assert.ok(transactionTypes.some((item) => item.type === 'BROKER_FIAT_TRANSFER_IN'));
  assert.ok(transactionTypes.some((item) => item.type === 'PLATFORM_PROFIT_WITHDRAWAL_IN'));
  assert.ok(adminLogActions.some((item) => item.action === 'TREASURY_TRANSFER_TO_USER'));
  assert.ok(adminLogActions.some((item) => item.action === 'TREASURY_TRANSFER_TO_BROKER'));
  assert.ok(adminLogActions.some((item) => item.action === 'BROKER_TRANSFER_TO_USER'));
  assert.ok(adminLogActions.some((item) => item.action === 'PLATFORM_PROFIT_WITHDRAWAL'));
});

test('super admin retira lucro da Exchange para carteira administrativa', async () => {
  await resetDb();
  const rSuper = await mkRole('SUPER_ADMIN');
  const rAdmin = await mkRole('ADMIN');
  const rUser = await mkRole('USER');
  const rBroker = await mkRole('VIRTUAL_BROKER');

  const superAdmin = await mkUser('super3@test.local');
  const adminTarget = await mkUser('admindest@test.local');
  const commonUser = await mkUser('user3@test.local');
  const broker = await mkUser('broker3@test.local');

  await prisma.userRole.createMany({ data: [
    { userId: superAdmin.id, roleId: rSuper.id },
    { userId: adminTarget.id, roleId: rAdmin.id },
    { userId: commonUser.id, roleId: rUser.id },
    { userId: broker.id, roleId: rBroker.id },
  ] });

  await prisma.platformAccount.create({ data: { balance: 1000, totalReceivedFees: 1000, totalWithdrawn: 0 } });

  const superToken = await token(superAdmin.id, ['SUPER_ADMIN']);
  const adminToken = await token(adminTarget.id, ['ADMIN']);
  const userToken = await token(commonUser.id, ['USER']);
  const brokerToken = await token(broker.id, ['VIRTUAL_BROKER']);

  const missingPassword = await app.inject({ method: 'POST', url: '/api/admin/platform-account/withdraw-to-admin', headers: { authorization: `Bearer ${superToken}` }, payload: { adminId: adminTarget.id, amount: 300, reason: 'retirada sem senha' } });
  assert.equal(missingPassword.statusCode, 400, missingPassword.body);
  assert.match(missingPassword.body, /confirme sua senha para continuar/i);

  const invalidPassword = await app.inject({ method: 'POST', url: '/api/admin/platform-account/withdraw-to-admin', headers: { authorization: `Bearer ${superToken}` }, payload: { adminId: adminTarget.id, amount: 300, reason: 'retirada senha inválida', adminPassword: 'senha-errada' } });
  assert.equal(invalidPassword.statusCode, 400, invalidPassword.body);
  assert.match(invalidPassword.body, /senha administrativa inválida/i);

  const ok = await app.inject({
    method: 'POST',
    url: '/api/admin/platform-account/withdraw-to-admin',
    headers: { authorization: `Bearer ${superToken}`, 'user-agent': 'rpc-exchange-test-agent', 'x-forwarded-for': '198.51.100.25' },
    payload: { adminId: adminTarget.id, amount: 300, reason: 'retirada lucro', adminPassword: ADMIN_PASSWORD },
  });
  assert.equal(ok.statusCode, 201, ok.body);

  const platform = await prisma.platformAccount.findFirstOrThrow();
  const adminWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: adminTarget.id } });
  const tx = await prisma.transaction.findFirst({ where: { walletId: adminWallet.id, type: 'PLATFORM_PROFIT_WITHDRAWAL_IN' } });
  const log = await prisma.adminLog.findFirst({ where: { action: 'PLATFORM_PROFIT_WITHDRAWAL' } });

  assert.equal(Number(platform.balance), 700);
  assert.equal(Number(platform.totalWithdrawn), 300);
  assert.equal(Number(adminWallet.fiatAvailableBalance), 300);
  assert.equal(Number(adminWallet.availableBalance), 0);
  assert.equal(Number(adminWallet.rpcAvailableBalance), 0);
  assert.ok(tx);
  assert.ok(log);
  assert.ok(log?.action);
  assert.ok(log?.entity);
  assert.match(log?.userAgent ?? '', /rpc-exchange-test-agent/i);
  assert.notEqual(log?.ip, undefined);

  const tooMuch = await app.inject({ method: 'POST', url: '/api/admin/platform-account/withdraw-to-admin', headers: { authorization: `Bearer ${superToken}` }, payload: { adminId: adminTarget.id, amount: 99999, reason: 'sem saldo', adminPassword: ADMIN_PASSWORD } });
  assert.equal(tooMuch.statusCode, 400, tooMuch.body);

  for (const tk of [adminToken, userToken, brokerToken]) {
    const forbidden = await app.inject({ method: 'POST', url: '/api/admin/platform-account/withdraw-to-admin', headers: { authorization: `Bearer ${tk}`, 'content-type': 'application/json' }, payload: { adminId: adminTarget.id, amount: 10, reason: 'forbidden' } });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
  }
});

test('projeto desligado bloqueia rotas públicas de mercado sem apagar histórico', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const user = await mkUser('marketuser@test.local');
  await prisma.userRole.create({ data: { userId: user.id, roleId: rUser.id } });
  await prisma.platformAccount.create({ data: {} });

  await prisma.wallet.update({ where: { userId: user.id }, data: { fiatAvailableBalance: 2000, rpcAvailableBalance: 2000 } });

  const company = await prisma.company.create({
    data: {
      name: 'Mercado Ativo', ticker: 'MRK1', description: 'desc', sector: 'setor', founderUserId: user.id, status: 'ACTIVE', totalShares: 1000,
      circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 600,
      initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(),
      revenueAccount: { create: {} }, initialOffer: { create: { totalShares: 600, availableShares: 600 } },
    },
  });

  const userToken = await token(user.id, ['USER']);

  const listActive = await app.inject({ method: 'GET', url: '/api/companies', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(listActive.statusCode, 200, listActive.body);
  assert.match(listActive.body, /MRK1/);

  const seedBuy = await app.inject({ method: 'POST', url: `/api/companies/${company.id}/buy-initial-offer`, headers: { authorization: `Bearer ${userToken}` }, payload: { quantity: 20 } });
  assert.equal(seedBuy.statusCode, 201, seedBuy.body);

  const orderBookActive = await app.inject({ method: 'GET', url: `/api/market/companies/${company.id}/order-book`, headers: { authorization: `Bearer ${userToken}` } });
  const tradesActive = await app.inject({ method: 'GET', url: `/api/market/companies/${company.id}/trades`, headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(orderBookActive.statusCode, 200, orderBookActive.body);
  assert.equal(tradesActive.statusCode, 200, tradesActive.body);

  await prisma.company.update({ where: { id: company.id }, data: { status: 'SUSPENDED' } });

  const listSuspended = await app.inject({ method: 'GET', url: '/api/companies', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(listSuspended.statusCode, 200, listSuspended.body);
  assert.ok(!listSuspended.body.includes('MRK1'));

  const blockedOrderBook = await app.inject({ method: 'GET', url: `/api/market/companies/${company.id}/order-book`, headers: { authorization: `Bearer ${userToken}` } });
  const blockedTrades = await app.inject({ method: 'GET', url: `/api/market/companies/${company.id}/trades`, headers: { authorization: `Bearer ${userToken}` } });
  const blockedOrder = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${userToken}` }, payload: { companyId: company.id, type: 'BUY', mode: 'LIMIT', quantity: 1, limitPrice: 10 } });
  const blockedBuyMarket = await app.inject({ method: 'POST', url: `/api/market/companies/${company.id}/buy-market`, headers: { authorization: `Bearer ${userToken}` }, payload: { quantity: 1, slippagePercent: 5 } });
  const blockedSellMarket = await app.inject({ method: 'POST', url: `/api/market/companies/${company.id}/sell-market`, headers: { authorization: `Bearer ${userToken}` }, payload: { quantity: 1, slippagePercent: 5 } });

  assert.equal(blockedOrderBook.statusCode, 400, blockedOrderBook.body);
  assert.equal(blockedTrades.statusCode, 400, blockedTrades.body);
  assert.equal(blockedOrder.statusCode, 400, blockedOrder.body);
  assert.equal(blockedBuyMarket.statusCode, 400, blockedBuyMarket.body);
  assert.equal(blockedSellMarket.statusCode, 400, blockedSellMarket.body);

  const operationsCount = await prisma.companyOperation.count({ where: { companyId: company.id, type: 'INITIAL_OFFER_BUY' } });
  assert.ok(operationsCount > 0);
  const ordersCount = await prisma.marketOrder.count({ where: { companyId: company.id } });
  const tradesCount = await prisma.trade.count({ where: { companyId: company.id } });
  assert.ok(ordersCount >= 0);
  assert.ok(tradesCount >= 0);
});


test('aporte institucional RPC é atômico, rastreável e limpo pelo resetDb', async () => {
  await resetDb();

  const rUser = await mkRole('USER');
  const founder = await mkUser('capital-founder@test.local');
  const other = await mkUser('capital-other@test.local');
  await prisma.userRole.createMany({ data: [
    { userId: founder.id, roleId: rUser.id },
    { userId: other.id, roleId: rUser.id },
  ] });

  await prisma.wallet.update({ where: { userId: founder.id }, data: { rpcAvailableBalance: 100 } });
  await prisma.wallet.update({ where: { userId: other.id }, data: { rpcAvailableBalance: 100 } });

  const company = await prisma.company.create({
    data: {
      name: 'Capital Audit', ticker: 'CAPA1', description: 'desc', sector: 'setor', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000,
      circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 600,
      initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(),
      revenueAccount: { create: {} },
    },
  });

  const founderToken = await token(founder.id, ['USER']);
  const otherToken = await token(other.id, ['USER']);

  const invalidByOwner = await app.inject({ method: 'POST', url: `/api/project-capital-flow/companies/${company.id}/contribute`, headers: { authorization: `Bearer ${founderToken}` }, payload: { amountRpc: 10, reason: 'curto' } });
  assert.equal(invalidByOwner.statusCode, 400, invalidByOwner.body);
  assert.equal(await prisma.companyCapitalFlowEntry.count({ where: { companyId: company.id } }), 0);
  assert.equal(await prisma.transaction.count({ where: { type: 'PROJECT_RPC_CONTRIBUTION' } }), 0);
  assert.equal(await prisma.adminLog.count({ where: { action: 'PROJECT_RPC_CONTRIBUTION' } }), 0);

  const forbiddenByNonFounder = await app.inject({ method: 'POST', url: `/api/project-capital-flow/companies/${company.id}/contribute`, headers: { authorization: `Bearer ${otherToken}` }, payload: { amountRpc: 10, reason: 'aporte institucional de teste' } });
  assert.equal(forbiddenByNonFounder.statusCode, 403, forbiddenByNonFounder.body);
  assert.equal(await prisma.companyCapitalFlowEntry.count({ where: { companyId: company.id } }), 0);

  const validContribution = await app.inject({ method: 'POST', url: `/api/project-capital-flow/companies/${company.id}/contribute`, headers: { authorization: `Bearer ${founderToken}` }, payload: { amountRpc: 40, reason: 'aporte institucional rastreavel de teste' } });
  assert.equal(validContribution.statusCode, 200, validContribution.body);

  const founderWalletAfter = await prisma.wallet.findUniqueOrThrow({ where: { userId: founder.id } });
  const revenueAfter = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  assert.equal(Number(founderWalletAfter.rpcAvailableBalance), 60);
  assert.equal(Number(revenueAfter.balance), 40);
  assert.equal(await prisma.companyCapitalFlowEntry.count({ where: { companyId: company.id } }), 1);
  assert.equal(await prisma.transaction.count({ where: { walletId: founderWalletAfter.id, type: 'PROJECT_RPC_CONTRIBUTION' } }), 1);
  assert.equal(await prisma.adminLog.count({ where: { action: 'PROJECT_RPC_CONTRIBUTION', entity: 'CompanyRevenueAccount' } }), 1);
  assert.equal(await prisma.trade.count({ where: { companyId: company.id } }), 0);
  assert.equal(await prisma.marketOrder.count({ where: { companyId: company.id } }), 0);

  await resetDb();
  assert.equal(await prisma.companyCapitalFlowEntry.count(), 0);
  assert.equal(await prisma.company.count(), 0);
  assert.equal(await prisma.transaction.count(), 0);
  assert.equal(await prisma.adminLog.count(), 0);
});


test('exclusão normal preserva aporte institucional e permite projeto sem histórico', async () => {
  await resetDb();

  const rAdmin = await mkRole('ADMIN');
  const rUser = await mkRole('USER');
  const admin = await mkUser('safe-delete-admin@test.local');
  const founder = await mkUser('safe-delete-founder@test.local');
  await prisma.userRole.createMany({ data: [
    { userId: admin.id, roleId: rAdmin.id },
    { userId: founder.id, roleId: rUser.id },
  ] });
  await prisma.wallet.update({ where: { userId: founder.id }, data: { rpcAvailableBalance: 100 } });

  const adminToken = await token(admin.id, ['ADMIN']);
  const founderToken = await token(founder.id, ['USER']);

  const companyWithContribution = await prisma.company.create({
    data: {
      name: 'Aporte Seguro', ticker: 'APSEG', description: 'desc', sector: 'setor', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000,
      circulatingShares: 0, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 600,
      initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(),
      revenueAccount: { create: {} }, initialOffer: { create: { totalShares: 600, availableShares: 600 } },
    },
  });

  const contribution = await app.inject({ method: 'POST', url: `/api/project-capital-flow/companies/${companyWithContribution.id}/contribute`, headers: { authorization: `Bearer ${founderToken}` }, payload: { amountRpc: 40, reason: 'aporte institucional preservado no historico' } });
  assert.equal(contribution.statusCode, 200, contribution.body);

  const revenueBeforeDelete = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: companyWithContribution.id } });
  const founderWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: founder.id } });
  assert.equal(Number(revenueBeforeDelete.balance), 40);
  assert.equal(await prisma.companyCapitalFlowEntry.count({ where: { companyId: companyWithContribution.id } }), 1);
  assert.equal(await prisma.transaction.count({ where: { walletId: founderWallet.id, type: 'PROJECT_RPC_CONTRIBUTION' } }), 1);
  assert.equal(await prisma.adminLog.count({ where: { action: 'PROJECT_RPC_CONTRIBUTION', entity: 'CompanyRevenueAccount' } }), 1);

  const blockedDelete = await app.inject({ method: 'DELETE', url: `/api/admin/tokens/${companyWithContribution.id}`, headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(blockedDelete.statusCode, 400, blockedDelete.body);
  assert.match(blockedDelete.body, /possui histórico e não pode ser excluído definitivamente/i);

  const revenueAfterBlockedDelete = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: companyWithContribution.id } });
  assert.equal(await prisma.company.count({ where: { id: companyWithContribution.id } }), 1);
  assert.equal(await prisma.companyCapitalFlowEntry.count({ where: { companyId: companyWithContribution.id } }), 1);
  assert.equal(await prisma.transaction.count({ where: { walletId: founderWallet.id, type: 'PROJECT_RPC_CONTRIBUTION' } }), 1);
  assert.equal(await prisma.adminLog.count({ where: { action: 'PROJECT_RPC_CONTRIBUTION', entity: 'CompanyRevenueAccount' } }), 1);
  assert.equal(Number(revenueAfterBlockedDelete.balance), Number(revenueBeforeDelete.balance));
  assert.equal(await prisma.adminLog.count({ where: { action: 'ADMIN_TOKEN_DELETED', entity: `Company:${companyWithContribution.id}` } }), 0);

  const companyWithoutHistory = await prisma.company.create({
    data: {
      name: 'Sem Historico', ticker: 'SEMH1', description: 'desc', sector: 'setor', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000,
      circulatingShares: 0, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 600,
      initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(),
      revenueAccount: { create: {} }, initialOffer: { create: { totalShares: 600, availableShares: 600 } },
    },
  });

  const allowedDelete = await app.inject({ method: 'DELETE', url: `/api/admin/tokens/${companyWithoutHistory.id}`, headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(allowedDelete.statusCode, 200, allowedDelete.body);
  assert.equal(await prisma.company.count({ where: { id: companyWithoutHistory.id } }), 0);
  assert.equal(await prisma.companyRevenueAccount.count({ where: { companyId: companyWithoutHistory.id } }), 0);
  assert.equal(await prisma.companyInitialOffer.count({ where: { companyId: companyWithoutHistory.id } }), 0);
  assert.equal(await prisma.adminLog.count({ where: { action: 'ADMIN_TOKEN_DELETED', entity: `Company:${companyWithoutHistory.id}` } }), 1);
});

test('force delete de projeto de teste só para SUPER_ADMIN e apaga histórico vinculado', async () => {
  await resetDb();

  const rSuper = await mkRole('SUPER_ADMIN');
  const rAdmin = await mkRole('ADMIN');
  const rChief = await mkRole('COIN_CHIEF_ADMIN');
  const rUser = await mkRole('USER');

  const superAdmin = await mkUser('super-force@test.local');
  const admin = await mkUser('admin-force@test.local');
  const chief = await mkUser('chief-force@test.local');
  const user = await mkUser('user-force@test.local');

  await prisma.userRole.createMany({ data: [
    { userId: superAdmin.id, roleId: rSuper.id },
    { userId: admin.id, roleId: rAdmin.id },
    { userId: chief.id, roleId: rChief.id },
    { userId: user.id, roleId: rUser.id },
  ] });

  const company = await prisma.company.create({
    data: {
      name: 'Projeto Teste', ticker: 'FORCE1', description: 'desc', sector: 'setor', founderUserId: user.id, status: 'CLOSED', totalShares: 1000,
      circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 500,
      initialPrice: 10, currentPrice: 12, buyFeePercent: 2, sellFeePercent: 1, fictitiousMarketCap: 12000, approvedAt: new Date(),
    },
  });

  await prisma.companyHolding.create({ data: { userId: user.id, companyId: company.id, shares: 10, averageBuyPrice: 10, estimatedValue: 120 } });
  await prisma.companyInitialOffer.create({ data: { companyId: company.id, totalShares: 600, availableShares: 500 } });
  await prisma.companyRevenueAccount.create({ data: { companyId: company.id, balance: 5, totalReceivedFees: 5 } });
  await prisma.companyBoostAccount.create({ data: { companyId: company.id } });
  await prisma.companyBoostInjection.create({
    data: {
      companyId: company.id,
      source: 'ADMIN_ADJUSTMENT',
      amountRpc: 3,
      priceBefore: 10,
      priceAfter: 12,
      marketCapBefore: 10000,
      marketCapAfter: 12000,
      reason: 'teste',
    },
  });
  const buyOrder = await prisma.marketOrder.create({ data: { userId: user.id, companyId: company.id, type: 'BUY', mode: 'LIMIT', quantity: 5, remainingQuantity: 0, limitPrice: 10, status: 'FILLED' } });
  const sellOrder = await prisma.marketOrder.create({ data: { userId: user.id, companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 5, remainingQuantity: 0, limitPrice: 10, status: 'FILLED' } });
  const op = await prisma.companyOperation.create({ data: { companyId: company.id, userId: user.id, type: 'MARKET_TRADE_EXECUTED', description: 'op' } });
  const trade = await prisma.trade.create({ data: { companyId: company.id, buyOrderId: buyOrder.id, sellOrderId: sellOrder.id, buyerId: user.id, sellerId: user.id, quantity: 5, unitPrice: 10, grossAmount: 50, buyFeeAmount: 1, sellFeeAmount: 1 } });
  await prisma.feeDistribution.create({
    data: {
      companyId: company.id,
      tradeId: trade.id,
      operationId: op.id,
      payerUserId: user.id,
      sourceType: 'MARKET_TRADE_TOTAL_FEE',
      totalFeeAmount: 2,
      platformAmount: 1,
      companyAmount: 1,
      platformSharePercent: 50,
      companySharePercent: 50,
    },
  });

  const userToken = await token(user.id, ['USER']);
  const adminToken = await token(admin.id, ['ADMIN']);
  const chiefToken = await token(chief.id, ['COIN_CHIEF_ADMIN']);
  const superToken = await token(superAdmin.id, ['SUPER_ADMIN']);

  for (const tk of [userToken, adminToken, chiefToken]) {
    const forbidden = await app.inject({ method: 'DELETE', url: `/api/admin/companies/${company.id}/force-delete`, headers: { authorization: `Bearer ${tk}`, 'content-type': 'application/json' }, payload: { reason: 'limpeza de teste completa', confirmation: 'EXCLUIR DEFINITIVAMENTE' } });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
  }

  const invalidConfirmation = await app.inject({ method: 'DELETE', url: `/api/admin/companies/${company.id}/force-delete`, headers: { authorization: `Bearer ${superToken}`, 'content-type': 'application/json' }, payload: { reason: 'limpeza de teste completa', confirmation: 'ERRADO' } });
  assert.equal(invalidConfirmation.statusCode, 400, invalidConfirmation.body);

  const forceDelete = await app.inject({ method: 'DELETE', url: `/api/admin/companies/${company.id}/force-delete`, headers: { authorization: `Bearer ${superToken}`, 'content-type': 'application/json' }, payload: { reason: 'limpeza de teste completa', confirmation: 'EXCLUIR DEFINITIVAMENTE' } });
  const forceDeletePayload = JSON.parse(forceDelete.body);
  assert.equal(forceDelete.statusCode, 200, forceDelete.body);
  assert.equal(forceDeletePayload.company?.id, company.id);
  assert.ok(forceDeletePayload.deletedCounts);

  const remainingAfterForceDelete = {
    companies: await prisma.company.count({ where: { id: company.id } }),
    holdings: await prisma.companyHolding.count({ where: { companyId: company.id } }),
    operations: await prisma.companyOperation.count({ where: { companyId: company.id } }),
    initialOffers: await prisma.companyInitialOffer.count({ where: { companyId: company.id } }),
    marketOrders: await prisma.marketOrder.count({ where: { companyId: company.id } }),
    trades: await prisma.trade.count({ where: { companyId: company.id } }),
    feeDistributions: await prisma.feeDistribution.count({ where: { companyId: company.id } }),
    capitalFlowEntries: await prisma.companyCapitalFlowEntry.count({ where: { companyId: company.id } }),
    revenueAccounts: await prisma.companyRevenueAccount.count({ where: { companyId: company.id } }),
    boostAccounts: await prisma.companyBoostAccount.count({ where: { companyId: company.id } }),
    boostInjections: await prisma.companyBoostInjection.count({ where: { companyId: company.id } }),
    forceDeleteLogs: await prisma.adminLog.count({ where: { action: 'COMPANY_FORCE_DELETED' } }),
  };


  assert.deepEqual(remainingAfterForceDelete, {
    companies: 0,
    holdings: 0,
    operations: 0,
    initialOffers: 0,
    marketOrders: 0,
    trades: 0,
    feeDistributions: 0,
    capitalFlowEntries: 0,
    revenueAccounts: 0,
    boostAccounts: 0,
    boostInjections: 0,
    forceDeleteLogs: 1,
  });
});



test('mercado RPC/R$ mantém singleton, cotação e integridade econômica', async () => {
  await resetDb();

  const rUser = await mkRole('USER');
  const user = await mkUser('rpcmarket@test.local', 'Rpc Trader');
  await prisma.userRole.create({ data: { userId: user.id, roleId: rUser.id } });
  await prisma.wallet.update({ where: { userId: user.id }, data: { fiatAvailableBalance: 1000, rpcAvailableBalance: 100 } });

  const firstState = await app.inject({ method: 'GET', url: '/api/rpc-market' });
  assert.equal(firstState.statusCode, 200);
  const secondState = await app.inject({ method: 'GET', url: '/api/rpc-market' });
  assert.equal(secondState.statusCode, 200);
  assert.equal(await prisma.rpcMarketState.count(), 1);

  const tk = await token(user.id, ['USER']);
  const walletBeforeQuote = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
  const quoteBuy = await app.inject({ method: 'GET', url: '/api/rpc-market/quote-buy?fiatAmount=100' });
  assert.equal(quoteBuy.statusCode, 200, quoteBuy.body);
  const quoteSell = await app.inject({ method: 'GET', url: '/api/rpc-market/quote-sell?rpcAmount=10' });
  assert.equal(quoteSell.statusCode, 200, quoteSell.body);
  const walletAfterQuote = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
  assert.equal(String(walletBeforeQuote.fiatAvailableBalance), String(walletAfterQuote.fiatAvailableBalance));
  assert.equal(String(walletBeforeQuote.rpcAvailableBalance), String(walletAfterQuote.rpcAvailableBalance));

  const buy = await app.inject({ method: 'POST', url: '/api/rpc-market/buy', headers: { authorization: `Bearer ${tk}` }, payload: { fiatAmount: 100 } });
  assert.equal(buy.statusCode, 200, buy.body);
  assert.equal(buy.json().feePercent, 1);
  assert.equal(Number(buy.json().grossFiatAmount), 100);
  assert.equal(await prisma.rpcMarketState.count(), 1);

  const sell = await app.inject({ method: 'POST', url: '/api/rpc-market/sell', headers: { authorization: `Bearer ${tk}` }, payload: { rpcAmount: 10 } });
  assert.equal(sell.statusCode, 200, sell.body);
  assert.equal(sell.json().feePercent, 1);
  assert.equal(await prisma.rpcMarketState.count(), 1);

  const walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
  assert.ok(Number(walletAfter.fiatAvailableBalance) > Number(walletBeforeQuote.fiatAvailableBalance) - 100);
  assert.ok(Number(walletAfter.rpcAvailableBalance) > Number(walletBeforeQuote.rpcAvailableBalance) - 10);
  assert.equal(Number(walletAfter.availableBalance), 0);

  const trades = await prisma.rpcExchangeTrade.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(trades.length, 2);
  for (const trade of trades) {
    const expected = Number(trade.fiatAmount) / Number(trade.rpcAmount);
    assert.equal(Number(trade.unitPrice).toFixed(8), expected.toFixed(8));
  }

  const platform = await prisma.platformAccount.findFirstOrThrow();
  assert.ok(Number(platform.balance) > 0);
  assert.ok(Number(platform.totalReceivedFees) > 0);
});

test('cadastro salva characterName e Discord e /auth/me retorna campos', async () => {
  await resetDb();
  await mkRole('USER');

  const register = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Player One', characterName: 'Kenshin', discordId: 'discord-register-1', characterPhone: '555-0001', screenshot: { mimeType: 'image/png', fileName: 'cadastro.png', data: 'data:image/png;base64,aW1hZ2VtLWRlLXRlc3Rl' }, password: '12345678' } });
  assert.equal(register.statusCode, 201, register.body);
  const payload = register.json();
  assert.equal(payload.characterName, 'Kenshin');

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { discordId: 'discord-register-1', password: '12345678' } });
  assert.equal(login.statusCode, 200, login.body);
  const tokenValue = login.json().token;

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${tokenValue}` } });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().user.characterName, 'Kenshin');

  const invalidCharacter = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Player Two', characterName: 'ab', discordId: 'discord-invalid-char', characterPhone: '555-0002', screenshot: { mimeType: 'image/png', fileName: 'cadastro.png', data: 'data:image/png;base64,aW1hZ2VtLWRlLXRlc3Rl' }, password: '12345678' } });
  assert.equal(invalidCharacter.statusCode, 400);

});

test('permissões e regras de liquidez RPC/R$ com AdminLog', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const rAdmin = await mkRole('ADMIN');
  const rChief = await mkRole('COIN_CHIEF_ADMIN');
  const rSuper = await mkRole('SUPER_ADMIN');

  const user = await mkUser('lq-user@test.local');
  const admin = await mkUser('lq-admin@test.local');
  const chief = await mkUser('lq-chief@test.local');
  const sup = await mkUser('lq-super@test.local');

  await prisma.userRole.createMany({ data: [
    { userId: user.id, roleId: rUser.id },
    { userId: admin.id, roleId: rAdmin.id },
    { userId: chief.id, roleId: rChief.id },
    { userId: sup.id, roleId: rSuper.id },
  ] });

  const userTk = await token(user.id, ['USER']);
  const adminTk = await token(admin.id, ['ADMIN']);
  const chiefTk = await token(chief.id, ['COIN_CHIEF_ADMIN']);
  const superTk = await token(sup.id, ['SUPER_ADMIN']);

  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/rpc-market/liquidity/inject', headers: { authorization: `Bearer ${userTk}` }, payload: { fiatAmount: 100, reason: 'motivo longo user' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/rpc-market/liquidity/inject', headers: { authorization: `Bearer ${adminTk}` }, payload: { fiatAmount: 100, reason: 'motivo longo admin' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/rpc-market/liquidity', headers: { authorization: `Bearer ${userTk}` } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/rpc-market/liquidity', headers: { authorization: `Bearer ${adminTk}` } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/rpc-market/liquidity', headers: { authorization: `Bearer ${chiefTk}` } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/rpc-market/liquidity', headers: { authorization: `Bearer ${superTk}` } })).statusCode, 200);

  const inject = await app.inject({ method: 'POST', url: '/api/admin/rpc-market/liquidity/inject', headers: { authorization: `Bearer ${chiefTk}` }, payload: { fiatAmount: 1000, rpcAmount: 500, reason: 'injeção de liquidez teste' } });
  assert.equal(inject.statusCode, 200, inject.body);

  const overWithdrawFiat = await app.inject({ method: 'POST', url: '/api/admin/rpc-market/liquidity/withdraw', headers: { authorization: `Bearer ${superTk}` }, payload: { fiatAmount: 999999999, reason: 'tentativa inválida de retirada' } });
  assert.equal(overWithdrawFiat.statusCode, 400);

  const overWithdrawRpc = await app.inject({ method: 'POST', url: '/api/admin/rpc-market/liquidity/withdraw', headers: { authorization: `Bearer ${superTk}` }, payload: { rpcAmount: 999999999, reason: 'tentativa inválida de retirada rpc' } });
  assert.equal(overWithdrawRpc.statusCode, 400);

  const withdraw = await app.inject({ method: 'POST', url: '/api/admin/rpc-market/liquidity/withdraw', headers: { authorization: `Bearer ${superTk}` }, payload: { rpcAmount: 100, reason: 'retirada válida de liquidez' } });
  assert.equal(withdraw.statusCode, 200, withdraw.body);

  const state = await prisma.rpcMarketState.findUniqueOrThrow({ where: { id: 'RPC_MARKET_MAIN' } });
  assert.equal(String(state.currentPrice), String(state.fiatReserve.div(state.rpcReserve).toDecimalPlaces(8)));

  const logs = await prisma.adminLog.findMany({ where: { action: { in: ['RPC_MARKET_LIQUIDITY_INJECT', 'RPC_MARKET_LIQUIDITY_WITHDRAW'] } } });
  assert.ok(logs.length >= 2);
  assert.ok(logs.every((log) => !!log.previous && !!log.current));
});

test('ordens limite RPC/R$ travam/cancelam saldos e processam elegíveis com segurança', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const rChief = await mkRole('COIN_CHIEF_ADMIN');
  const buyer = await mkUser('rpc-buyer@test.local');
  const seller = await mkUser('rpc-seller@test.local');
  const other = await mkUser('rpc-other@test.local');
  const chief = await mkUser('rpc-chief@test.local');
  await prisma.userRole.createMany({ data: [
    { userId: buyer.id, roleId: rUser.id },
    { userId: seller.id, roleId: rUser.id },
    { userId: other.id, roleId: rUser.id },
    { userId: chief.id, roleId: rChief.id },
  ] });

  await prisma.wallet.update({ where: { userId: buyer.id }, data: { fiatAvailableBalance: 1000 } });
  await prisma.wallet.update({ where: { userId: seller.id }, data: { rpcAvailableBalance: 300 } });

  const buyerTk = await token(buyer.id, ['USER']);
  const sellerTk = await token(seller.id, ['USER']);
  const otherTk = await token(other.id, ['USER']);
  const chiefTk = await token(chief.id, ['COIN_CHIEF_ADMIN']);

  const createBuy = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${buyerTk}` }, payload: { side: 'BUY_RPC', fiatAmount: 120, limitPrice: 2 } });
  assert.equal(createBuy.statusCode, 201, createBuy.body);
  const buyOrderId = createBuy.json().order.id as string;
  let buyerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
  let buyOrder = await prisma.rpcLimitOrder.findUniqueOrThrow({ where: { id: buyOrderId } });
  assert.equal(Number(buyerWallet.fiatAvailableBalance), 880);
  assert.equal(Number(buyerWallet.fiatLockedBalance), 120);
  assert.equal(buyOrder.status, 'OPEN');

  const cancelByOther = await app.inject({ method: 'POST', url: `/api/rpc-market/orders/${buyOrderId}/cancel`, headers: { authorization: `Bearer ${otherTk}` } });
  assert.equal(cancelByOther.statusCode, 400, cancelByOther.body);
  buyerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
  assert.equal(Number(buyerWallet.fiatAvailableBalance), 880);
  assert.equal(Number(buyerWallet.fiatLockedBalance), 120);

  const cancelBuy = await app.inject({ method: 'POST', url: `/api/rpc-market/orders/${buyOrderId}/cancel`, headers: { authorization: `Bearer ${buyerTk}` } });
  assert.equal(cancelBuy.statusCode, 200, cancelBuy.body);
  buyerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
  buyOrder = await prisma.rpcLimitOrder.findUniqueOrThrow({ where: { id: buyOrderId } });
  assert.equal(Number(buyerWallet.fiatAvailableBalance), 1000);
  assert.equal(Number(buyerWallet.fiatLockedBalance), 0);
  assert.equal(buyOrder.status, 'CANCELED');

  const createSell = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${sellerTk}` }, payload: { side: 'SELL_RPC', rpcAmount: 40, limitPrice: 0.5 } });
  assert.equal(createSell.statusCode, 201, createSell.body);
  const sellOrderId = createSell.json().order.id as string;
  let sellerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: seller.id } });
  let sellOrder = await prisma.rpcLimitOrder.findUniqueOrThrow({ where: { id: sellOrderId } });
  assert.equal(Number(sellerWallet.rpcAvailableBalance), 260);
  assert.equal(Number(sellerWallet.rpcLockedBalance), 40);
  assert.equal(sellOrder.status, 'OPEN');

  const cancelSell = await app.inject({ method: 'POST', url: `/api/rpc-market/orders/${sellOrderId}/cancel`, headers: { authorization: `Bearer ${sellerTk}` } });
  assert.equal(cancelSell.statusCode, 200, cancelSell.body);
  sellerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: seller.id } });
  sellOrder = await prisma.rpcLimitOrder.findUniqueOrThrow({ where: { id: sellOrderId } });
  assert.equal(Number(sellerWallet.rpcAvailableBalance), 300);
  assert.equal(Number(sellerWallet.rpcLockedBalance), 0);
  assert.equal(sellOrder.status, 'CANCELED');

  const fillBuyResp = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${buyerTk}` }, payload: { side: 'BUY_RPC', fiatAmount: 100, limitPrice: 2 } });
  const fillSellResp = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${sellerTk}` }, payload: { side: 'SELL_RPC', rpcAmount: 20, limitPrice: 0.5 } });
  assert.equal(fillBuyResp.statusCode, 201, fillBuyResp.body);
  assert.equal(fillSellResp.statusCode, 201, fillSellResp.body);
  const fillBuyId = fillBuyResp.json().order.id as string;
  const fillSellId = fillSellResp.json().order.id as string;

  const process = await app.inject({ method: 'POST', url: '/api/admin/rpc-market/orders/process', headers: { authorization: `Bearer ${chiefTk}` }, payload: { maxOrders: 20 } });
  assert.equal(process.statusCode, 200, process.body);

  const filledBuy = await prisma.rpcLimitOrder.findUniqueOrThrow({ where: { id: fillBuyId } });
  const filledSell = await prisma.rpcLimitOrder.findUniqueOrThrow({ where: { id: fillSellId } });
  assert.equal(filledBuy.status, 'FILLED');
  assert.equal(filledSell.status, 'FILLED');

  buyerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
  sellerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: seller.id } });
  assert.equal(Number(buyerWallet.fiatLockedBalance), 0);
  assert.ok(Number(buyerWallet.rpcAvailableBalance) > 0);
  assert.equal(Number(sellerWallet.rpcLockedBalance), 0);
  assert.ok(Number(sellerWallet.fiatAvailableBalance) > 0);

  const rpcTrades = await prisma.rpcExchangeTrade.findMany({ where: { userId: { in: [buyer.id, seller.id] } } });
  assert.ok(rpcTrades.length >= 2);
  const state = await prisma.rpcMarketState.findUniqueOrThrow({ where: { id: 'RPC_MARKET_MAIN' } });
  assert.ok(Number(state.totalBuys) >= 1);
  assert.ok(Number(state.totalSells) >= 1);
});

test('ordens limite RPC/R$ bloqueadores P1: arredondamento mínimo e seleção por lado', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const rChief = await mkRole('COIN_CHIEF_ADMIN');
  const buyer = await mkUser('p1-buyer@test.local');
  const seller = await mkUser('p1-seller@test.local');
  const chief = await mkUser('p1-chief@test.local');
  await prisma.userRole.createMany({ data: [
    { userId: buyer.id, roleId: rUser.id },
    { userId: seller.id, roleId: rUser.id },
    { userId: chief.id, roleId: rChief.id },
  ] });

  await prisma.wallet.update({ where: { userId: buyer.id }, data: { fiatAvailableBalance: 1000 } });
  await prisma.wallet.update({ where: { userId: seller.id }, data: { rpcAvailableBalance: 2000 } });

  const buyerTk = await token(buyer.id, ['USER']);
  const sellerTk = await token(seller.id, ['USER']);
  const chiefTk = await token(chief.id, ['COIN_CHIEF_ADMIN']);

  const tooSmallBuy = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${buyerTk}` }, payload: { side: 'BUY_RPC', fiatAmount: 0.001, limitPrice: 1 } });
  assert.equal(tooSmallBuy.statusCode, 400, tooSmallBuy.body);
  assert.match(tooSmallBuy.body, /valor mínimo para ordem é 0,01/i);

  const tooSmallSell = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${sellerTk}` }, payload: { side: 'SELL_RPC', rpcAmount: 0.001, limitPrice: 1 } });
  assert.equal(tooSmallSell.statusCode, 400, tooSmallSell.body);
  assert.match(tooSmallSell.body, /valor mínimo para ordem é 0,01/i);

  const makerCount = 11;
  const buyers = [{ id: buyer.id, token: buyerTk }];
  for (let i = 0; i < makerCount - 1; i += 1) {
    const maker = await mkUser(`p1-maker-buy-${i}@test.local`);
    await prisma.userRole.create({ data: { userId: maker.id, roleId: rUser.id } });
    await prisma.wallet.update({ where: { userId: maker.id }, data: { fiatAvailableBalance: 1000 } });
    buyers.push({ id: maker.id, token: await token(maker.id, ['USER']) });
  }

  for (const maker of buyers) {
    const openCount = await prisma.rpcLimitOrder.count({ where: { userId: maker.id, status: 'OPEN' } });
    assert.ok(openCount < RPC_MARKET_MAX_OPEN_ORDERS_PER_USER);
    for (let i = 0; i < RPC_MARKET_MAX_OPEN_ORDERS_PER_USER; i += 1) {
      const o = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${maker.token}` }, payload: { side: 'BUY_RPC', fiatAmount: 1, limitPrice: 0.5 } });
      assert.equal(o.statusCode, 201, o.body);
    }
  }

  const eligibleSell = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${sellerTk}` }, payload: { side: 'SELL_RPC', rpcAmount: 20, limitPrice: 0.8 } });
  assert.equal(eligibleSell.statusCode, 201, eligibleSell.body);
  const eligibleSellId = eligibleSell.json().order.id as string;

  const process = await app.inject({ method: 'POST', url: '/api/admin/rpc-market/orders/process', headers: { authorization: `Bearer ${chiefTk}` }, payload: { maxOrders: 20 } });
  assert.equal(process.statusCode, 200, process.body);

  const sellOrder = await prisma.rpcLimitOrder.findUniqueOrThrow({ where: { id: eligibleSellId } });
  assert.equal(sellOrder.status, 'FILLED');
});

test('admin não pode revisar o próprio saque e outro admin pode revisar', async () => {
  await resetDb();
  const rAdmin = await mkRole('ADMIN');
  const adminA = await mkUser('self-wd-a@test.local');
  const adminB = await mkUser('self-wd-b@test.local');
  await prisma.userRole.createMany({ data: [{ userId: adminA.id, roleId: rAdmin.id }, { userId: adminB.id, roleId: rAdmin.id }] });
  await prisma.wallet.update({ where: { userId: adminA.id }, data: { fiatAvailableBalance: 200 } });

  const tkA = await token(adminA.id, ['ADMIN']);
  const tkB = await token(adminB.id, ['ADMIN']);

  const req = await app.inject({ method: 'POST', url: '/api/withdrawals', headers: { authorization: `Bearer ${tkA}` }, payload: { amount: 50 } });
  assert.equal(req.statusCode, 201, req.body);
  const withdrawalId = req.json().id as string;

  const selfComplete = await app.inject({ method: 'POST', url: `/api/admin/withdrawals/${withdrawalId}/complete`, headers: { authorization: `Bearer ${tkA}` }, payload: { adminNote: 'self' } });
  assert.equal(selfComplete.statusCode, 403, selfComplete.body);

  const otherComplete = await app.inject({ method: 'POST', url: `/api/admin/withdrawals/${withdrawalId}/complete`, headers: { authorization: `Bearer ${tkB}` }, payload: { adminNote: 'ok' } });
  assert.equal(otherComplete.statusCode, 200, otherComplete.body);
});
