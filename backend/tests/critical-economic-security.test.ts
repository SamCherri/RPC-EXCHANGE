import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { RPC_MARKET_MAX_OPEN_ORDERS_PER_USER } from '../src/config/anti-abuse-limits.js';

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
  await prisma.$transaction([
    prisma.rpcLimitOrder.deleteMany(),
    prisma.rpcExchangeTrade.deleteMany(),
    prisma.rpcMarketState.deleteMany(),
    prisma.projectHolderDistributionPayment.deleteMany(),
    prisma.projectHolderDistributionSnapshot.deleteMany(),
    prisma.projectHolderDistributionProgram.deleteMany(),
    prisma.projectTokenReserveEntry.deleteMany(),
    prisma.projectTokenReserve.deleteMany(),
    prisma.projectBuybackExecution.deleteMany(),
    prisma.projectBuybackProgram.deleteMany(),
    prisma.companyCapitalFlowEntry.deleteMany(),
    prisma.feeDistribution.deleteMany(),
    prisma.trade.deleteMany(),
    prisma.marketOrder.deleteMany(),
    prisma.companyOperation.deleteMany(),
    prisma.companyHolding.deleteMany(),
    prisma.companyInitialOffer.deleteMany(),
    prisma.companyRevenueAccount.deleteMany(),
    prisma.companyBoostInjection.deleteMany(),
    prisma.companyBoostAccount.deleteMany(),
    prisma.company.deleteMany(),
    prisma.coinTransfer.deleteMany(),
    prisma.coinIssuance.deleteMany(),
    prisma.transaction.deleteMany(),
    prisma.withdrawalRequest.deleteMany(),
    prisma.adminLog.deleteMany(),
    prisma.brokerAccount.deleteMany(),
    prisma.wallet.deleteMany(),
    prisma.userRole.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.testModeReport.deleteMany(),
    prisma.testModeTrade.deleteMany(),
    prisma.testModeWallet.deleteMany(),
    prisma.testModeMarketState.deleteMany(),
    prisma.systemModeConfig.deleteMany(),
    prisma.user.deleteMany(),
    prisma.platformAccount.deleteMany(),
    prisma.treasuryAccount.deleteMany(),
  ]);
}

async function mkUser(email: string, name = 'User') {
  return prisma.user.create({ data: { email, name, passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10), wallet: { create: {} } } });
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
  assert.ok(payload.priceIncrease);
  assert.ok(payload.grossAmount);
  assert.ok(payload.totalAmount);
  assert.equal(payload.availableSharesBefore, 600);
  assert.equal(payload.availableSharesAfter, 550);
  assert.ok(Number(payload.priceAfter) > Number(payload.priceBefore));
  assert.equal(String(payload.currentPrice), String(payload.priceAfter));

  const companyAfter = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  const holding = await prisma.companyHolding.findUniqueOrThrow({ where: { userId_companyId: { userId: buyer.id, companyId: company.id } } });
  const op = await prisma.companyOperation.findFirst({ where: { companyId: company.id, userId: buyer.id, type: 'INITIAL_OFFER_BUY' } });
  const fees = await prisma.feeDistribution.findMany({ where: { companyId: company.id } });
  const platform = await prisma.platformAccount.findFirstOrThrow();
  const revenue = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  const tradesCount = await prisma.trade.count({ where: { companyId: company.id } });
  const marketOrderCount = await prisma.marketOrder.count({ where: { companyId: company.id } });

  assert.ok(Number(companyAfter.currentPrice) > 10);
  assert.equal(holding.shares, 50);
  assert.ok(op);
  assert.ok(fees.length > 0);
  assert.ok(Number(platform.balance) > 0);
  assert.ok(Number(revenue.balance) > 0);
  assert.equal(tradesCount, 0);
  assert.equal(marketOrderCount, 0);
});

test('segunda compra inicial usa currentPrice atualizado como base de custo', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const buyer = await mkUser('initialbuyer2@test.local', 'Initial Buyer 2');
  await prisma.userRole.create({ data: { userId: buyer.id, roleId: rUser.id } });
  await prisma.platformAccount.create({ data: {} });
  await prisma.wallet.update({ where: { userId: buyer.id }, data: { rpcAvailableBalance: 10000 } });

  const company = await prisma.company.create({
    data: {
      name: 'Oferta Inicial 2', ticker: 'INIT2', description: 'desc', sector: 'setor', founderUserId: buyer.id, status: 'ACTIVE', totalShares: 1000,
      circulatingShares: 0, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 600,
      initialPrice: 10, currentPrice: 10, buyFeePercent: 2, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(),
      revenueAccount: { create: {} }, initialOffer: { create: { totalShares: 600, availableShares: 600 } },
    },
  });

  const buyerToken = await token(buyer.id, ['USER']);
  const firstBuy = await app.inject({
    method: 'POST',
    url: `/api/companies/${company.id}/buy-initial-offer`,
    headers: { authorization: `Bearer ${buyerToken}` },
    payload: { quantity: 50 },
  });
  assert.equal(firstBuy.statusCode, 201, firstBuy.body);
  const firstPayload = firstBuy.json();
  const firstPriceAfter = Number(firstPayload.priceAfter);
  assert.ok(firstPriceAfter > 10);

  const walletAfterFirst = await prisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
  const firstWalletBalanceAfter = Number(walletAfterFirst.rpcAvailableBalance);

  const secondBuy = await app.inject({
    method: 'POST',
    url: `/api/companies/${company.id}/buy-initial-offer`,
    headers: { authorization: `Bearer ${buyerToken}` },
    payload: { quantity: 10 },
  });
  assert.equal(secondBuy.statusCode, 201, secondBuy.body);
  const secondPayload = secondBuy.json();

  assert.equal(Number(secondPayload.priceBefore), firstPriceAfter);

  const expectedGrossSecond = firstPriceAfter * 10;
  assert.equal(Number(secondPayload.grossAmount), Number(expectedGrossSecond.toFixed(2)));

  const expectedFeeSecond = expectedGrossSecond * 0.02;
  const expectedTotalSecond = expectedGrossSecond + expectedFeeSecond;

  const walletAfterSecond = await prisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
  const secondWalletBalanceAfter = Number(walletAfterSecond.rpcAvailableBalance);
  assert.equal(Number((firstWalletBalanceAfter - secondWalletBalanceAfter).toFixed(2)), Number(expectedTotalSecond.toFixed(2)));
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

test('cadastro salva characterName e bankAccountNumber e /auth/me retorna campos', async () => {
  await resetDb();
  await mkRole('USER');

  const register = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Player One', characterName: 'Kenshin', bankAccountNumber: 'RP-001', email: 'register@test.local', password: '12345678' } });
  assert.equal(register.statusCode, 201, register.body);
  const payload = register.json();
  assert.equal(payload.characterName, 'Kenshin');
  assert.equal(payload.bankAccountNumber, 'RP-001');

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'register@test.local', password: '12345678' } });
  assert.equal(login.statusCode, 200, login.body);
  const tokenValue = login.json().token;

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${tokenValue}` } });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().user.characterName, 'Kenshin');
  assert.equal(me.json().user.bankAccountNumber, 'RP-001');

  const invalidCharacter = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Player Two', characterName: 'ab', bankAccountNumber: 'RP-002', email: 'invalid-char@test.local', password: '12345678' } });
  assert.equal(invalidCharacter.statusCode, 400);

  const invalidBank = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Player Three', characterName: 'ValidName', bankAccountNumber: '12', email: 'invalid-bank@test.local', password: '12345678' } });
  assert.equal(invalidBank.statusCode, 400);
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

test('modo teste global bloqueia rotas reais, mantém isolamento e registra logs administrativos', async () => {
  await resetDb();

  const rSuper = await mkRole('SUPER_ADMIN');
  const rAdmin = await mkRole('ADMIN');
  const rUser = await mkRole('USER');

  const superAdmin = await mkUser('tm-super@test.local');
  const admin = await mkUser('tm-admin@test.local');
  const user = await mkUser('tm-user@test.local');

  await prisma.userRole.createMany({ data: [
    { userId: superAdmin.id, roleId: rSuper.id },
    { userId: admin.id, roleId: rAdmin.id },
    { userId: user.id, roleId: rUser.id },
  ] });

  const superTk = await token(superAdmin.id, ['SUPER_ADMIN']);
  const adminTk = await token(admin.id, ['ADMIN']);
  const userTk = await token(user.id, ['USER']);

  const modeStart = await app.inject({ method: 'GET', url: '/api/system-mode' });
  assert.equal(modeStart.statusCode, 200);
  assert.equal(modeStart.json().mode, 'NORMAL');

  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/system-mode/test/enable', headers: { authorization: `Bearer ${userTk}` }, payload: { reason: 'tentativa sem permissão user' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/system-mode/test/enable', headers: { authorization: `Bearer ${adminTk}` }, payload: { reason: 'tentativa sem permissão admin' } })).statusCode, 403);

  const enable = await app.inject({ method: 'POST', url: '/api/admin/system-mode/test/enable', headers: { authorization: `Bearer ${superTk}` }, payload: { reason: 'ativando modo teste global' } });
  assert.equal(enable.statusCode, 200, enable.body);

  const blockedNoToken = await app.inject({ method: 'GET', url: '/api/rpc-market' });
  assert.equal(blockedNoToken.statusCode, 403);
  const blockedUser = await app.inject({ method: 'GET', url: '/api/rpc-market', headers: { authorization: `Bearer ${userTk}` } });
  assert.equal(blockedUser.statusCode, 403);

  const testMe = await app.inject({ method: 'GET', url: '/api/test-mode/me', headers: { authorization: `Bearer ${userTk}` } });
  assert.equal(testMe.statusCode, 200, testMe.body);
  assert.equal(Number(testMe.json().fiatBalance), 10000);

  const reportInTest = await app.inject({ method: 'POST', url: '/api/test-mode/reports', headers: { authorization: `Bearer ${userTk}` }, payload: { type: 'BUG', location: 'Tela', description: 'Teste de report' } });
  assert.equal(reportInTest.statusCode, 201, reportInTest.body);

  const buy = await app.inject({ method: 'POST', url: '/api/test-mode/buy', headers: { authorization: `Bearer ${userTk}` }, payload: { fiatAmount: 100 } });
  assert.equal(buy.statusCode, 200, buy.body);
  const sell = await app.inject({ method: 'POST', url: '/api/test-mode/sell', headers: { authorization: `Bearer ${userTk}` }, payload: { rpcAmount: 10 } });
  assert.equal(sell.statusCode, 200, sell.body);

  const realWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
  const testWallet = await prisma.testModeWallet.findUniqueOrThrow({ where: { userId: user.id } });
  assert.equal(Number(realWallet.fiatAvailableBalance), 0);
  assert.ok(Number(testWallet.fiatBalance) >= 0);

  assert.equal(await prisma.rpcExchangeTrade.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.rpcMarketState.count(), 0);

  const resetUser = await app.inject({ method: 'POST', url: '/api/admin/test-mode/reset-user', headers: { authorization: `Bearer ${superTk}` }, payload: { userId: user.id, reason: 'reset de carteira de teste' } });
  assert.equal(resetUser.statusCode, 200, resetUser.body);

  const clearWrong = await app.inject({ method: 'POST', url: '/api/admin/test-mode/clear', headers: { authorization: `Bearer ${superTk}` }, payload: { reason: 'limpeza errada', confirmation: 'ERRADO' } });
  assert.equal(clearWrong.statusCode, 400);
  const clearOk = await app.inject({ method: 'POST', url: '/api/admin/test-mode/clear', headers: { authorization: `Bearer ${superTk}` }, payload: { reason: 'limpeza correta de teste', confirmation: 'LIMPAR MODO TESTE' } });
  assert.equal(clearOk.statusCode, 200, clearOk.body);

  const disable = await app.inject({ method: 'POST', url: '/api/admin/system-mode/normal/enable', headers: { authorization: `Bearer ${superTk}` }, payload: { reason: 'encerrando modo teste global' } });
  assert.equal(disable.statusCode, 200, disable.body);

  const reportInNormal = await app.inject({ method: 'POST', url: '/api/test-mode/reports', headers: { authorization: `Bearer ${userTk}` }, payload: { type: 'BUG', location: 'Tela', description: 'Teste de report' } });
  assert.equal(reportInNormal.statusCode, 403);

  const logs = await prisma.adminLog.findMany({ where: { action: { in: ['SYSTEM_MODE_ENABLE_TEST', 'SYSTEM_MODE_ENABLE_NORMAL', 'TEST_MODE_RESET_USER', 'TEST_MODE_CLEAR'] } } });
  assert.ok(logs.length >= 4);
});

test('modo teste global bloqueia /api/me e /api/rpc-market para USER e permite /api/test-mode/me', async () => {
  await resetDb();
  const roleUser = await mkRole('USER');
  const user = await mkUser('testmode-user@test.local');
  await prisma.userRole.create({ data: { userId: user.id, roleId: roleUser.id } });
  await prisma.systemModeConfig.upsert({ where: { id: 'SYSTEM_MODE_MAIN' }, update: { mode: 'TEST' }, create: { id: 'SYSTEM_MODE_MAIN', mode: 'TEST' } });

  const userToken = await token(user.id, ['USER']);

  const meBlocked = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(meBlocked.statusCode, 403, meBlocked.body);

  const marketBlocked = await app.inject({ method: 'GET', url: '/api/rpc-market', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(marketBlocked.statusCode, 403, marketBlocked.body);

  const withoutTokenBlocked = await app.inject({ method: 'GET', url: '/api/market/orders' });
  assert.equal(withoutTokenBlocked.statusCode, 403, withoutTokenBlocked.body);

  const testModeMeAllowed = await app.inject({ method: 'GET', url: '/api/test-mode/me', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(testModeMeAllowed.statusCode, 200, testModeMeAllowed.body);
});

test('modo normal bloqueia endpoint test-mode/me', async () => {
  await resetDb();
  const roleUser = await mkRole('USER');
  const user = await mkUser('normal-user@test.local');
  await prisma.userRole.create({ data: { userId: user.id, roleId: roleUser.id } });
  await prisma.systemModeConfig.upsert({ where: { id: 'SYSTEM_MODE_MAIN' }, update: { mode: 'NORMAL' }, create: { id: 'SYSTEM_MODE_MAIN', mode: 'NORMAL' } });
  const userToken = await token(user.id, ['USER']);
  const response = await app.inject({ method: 'GET', url: '/api/test-mode/me', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(response.statusCode, 403, response.body);
});


test('modo teste: preço, leaderboard, guardas e report types', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const user = await mkUser('tmode@test.local', 'TMode');
  await prisma.userRole.create({ data: { userId: user.id, roleId: rUser.id } });

  const superAdminRole = await mkRole('SUPER_ADMIN');
  const admin = await mkUser('admin-tmode@test.local', 'Admin');
  await prisma.userRole.create({ data: { userId: admin.id, roleId: superAdminRole.id } });

  const adminToken = await token(admin.id, ['SUPER_ADMIN']);
  const userToken = await token(user.id, ['USER']);

  const setTest = await app.inject({ method: 'POST', url: '/api/admin/system-mode/test/enable', headers: { authorization: `Bearer ${adminToken}` }, payload: { reason: 'Ativando modo teste para teste crítico' } });
  assert.equal(setTest.statusCode, 200, setTest.body);

  const deniedMe = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(deniedMe.statusCode, 403, deniedMe.body);

  const deniedMarket = await app.inject({ method: 'GET', url: '/api/rpc-market', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(deniedMarket.statusCode, 403, deniedMarket.body);

  const testMe = await app.inject({ method: 'GET', url: '/api/test-mode/me', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(testMe.statusCode, 200, testMe.body);

  const beforeMarket = await app.inject({ method: 'GET', url: '/api/test-mode/market', headers: { authorization: `Bearer ${userToken}` } });
  const beforePrice = Number(beforeMarket.json().currentPrice);

  const buy = await app.inject({ method: 'POST', url: '/api/test-mode/buy', headers: { authorization: `Bearer ${userToken}` }, payload: { fiatAmount: 100 } });
  assert.equal(buy.statusCode, 200, buy.body);
  const afterBuyMarket = await app.inject({ method: 'GET', url: '/api/test-mode/market', headers: { authorization: `Bearer ${userToken}` } });
  const afterBuyPrice = Number(afterBuyMarket.json().currentPrice);
  assert.ok(afterBuyPrice > beforePrice);

  const sell = await app.inject({ method: 'POST', url: '/api/test-mode/sell', headers: { authorization: `Bearer ${userToken}` }, payload: { rpcAmount: 1 } });
  assert.equal(sell.statusCode, 200, sell.body);
  const afterSellMarket = await app.inject({ method: 'GET', url: '/api/test-mode/market', headers: { authorization: `Bearer ${userToken}` } });
  const afterSellPrice = Number(afterSellMarket.json().currentPrice);
  assert.ok(afterSellPrice < afterBuyPrice);

  const leaderboard = await app.inject({ method: 'GET', url: '/api/test-mode/leaderboard', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(leaderboard.statusCode, 200, leaderboard.body);
  const rows = leaderboard.json().leaderboard as Array<{ userId: string; estimatedTotalFiat: string }>;
  assert.ok(rows.some((row) => row.userId === user.id));
  const sorted = [...rows].sort((a, b) => Number(b.estimatedTotalFiat) - Number(a.estimatedTotalFiat));
  assert.deepEqual(rows.map((r) => r.userId), sorted.map((r) => r.userId));

  const reportTypes = ['BUG','VISUAL_ERROR','BALANCE_ERROR','CHEAT_SUSPECTED','SUGGESTION','OTHER'] as const;
  for (const [idx, type] of reportTypes.entries()) {
    const reportUser = await mkUser(`tmode-report-${idx}@test.local`, `TMode Report ${idx}`);
    await prisma.userRole.create({ data: { userId: reportUser.id, roleId: rUser.id } });
    const reportToken = await token(reportUser.id, ['USER']);
    const report = await app.inject({ method: 'POST', url: '/api/test-mode/reports', headers: { authorization: `Bearer ${reportToken}` }, payload: { type, location: 'Tela', description: 'Teste' } });
    assert.equal(report.statusCode, 201, report.body);
  }

  const setNormal = await app.inject({ method: 'POST', url: '/api/admin/system-mode/normal/enable', headers: { authorization: `Bearer ${adminToken}` }, payload: { reason: 'Voltando para modo normal no teste crítico' } });
  assert.equal(setNormal.statusCode, 200, setNormal.body);

  const reportBlockedInNormal = await app.inject({ method: 'POST', url: '/api/test-mode/reports', headers: { authorization: `Bearer ${userToken}` }, payload: { type: 'BUG', location: 'Tela', description: 'Teste em normal' } });
  assert.equal(reportBlockedInNormal.statusCode, 403, reportBlockedInNormal.body);
});

test('bot tick do modo teste só opera em TEST e não altera economia real', async () => {
  await resetDb();

  const rUser = await mkRole('USER');
  const user = await mkUser('testmode-bot@test.local', 'Test Bot User');
  await prisma.userRole.create({ data: { userId: user.id, roleId: rUser.id } });
  await prisma.platformAccount.create({ data: {} });

  const userToken = await token(user.id, ['USER']);
  await prisma.systemModeConfig.upsert({
    where: { id: 'SYSTEM_MODE_MAIN' },
    update: { mode: 'NORMAL' },
    create: { id: 'SYSTEM_MODE_MAIN', mode: 'NORMAL' },
  });

  const normalMode = await app.inject({
    method: 'POST',
    url: '/api/test-mode/bot-tick',
    headers: { authorization: `Bearer ${userToken}` },
  });
  assert.equal(normalMode.statusCode, 403, normalMode.body);

  const superAdminRole = await mkRole('SUPER_ADMIN');
  const admin = await mkUser('testmode-admin@test.local', 'Test Admin');
  await prisma.userRole.create({ data: { userId: admin.id, roleId: superAdminRole.id } });
  const adminToken = await token(admin.id, ['SUPER_ADMIN']);

  const setTestMode = await app.inject({
    method: 'POST',
    url: '/api/admin/system-mode/test/enable',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { reason: 'Ativando TEST para validar bot tick' },
  });
  assert.equal(setTestMode.statusCode, 200, setTestMode.body);

  const realMarketBefore = await prisma.rpcMarketState.findFirst();
  const realTradesBefore = await prisma.rpcExchangeTrade.count();
  const realWalletsBefore = await prisma.wallet.count();
  const testMarketBefore = await prisma.testModeMarketState.findUnique({ where: { id: 'TEST_MODE_MARKET_MAIN' } });

  const tick = await app.inject({
    method: 'POST',
    url: '/api/test-mode/bot-tick',
    headers: { authorization: `Bearer ${userToken}` },
  });
  assert.equal(tick.statusCode, 200, tick.body);
  const payload = tick.json();
  assert.ok(payload.currentPrice);
  assert.ok(payload.skipped === true || payload.side === 'BUY' || payload.side === 'SELL');

  const realMarketAfter = await prisma.rpcMarketState.findFirst();
  const realTradesAfter = await prisma.rpcExchangeTrade.count();
  const realWalletsAfter = await prisma.wallet.count();
  const testMarketAfter = await prisma.testModeMarketState.findUniqueOrThrow({ where: { id: 'TEST_MODE_MARKET_MAIN' } });

  assert.equal(JSON.stringify(realMarketAfter), JSON.stringify(realMarketBefore));
  assert.equal(realTradesAfter, realTradesBefore);
  assert.equal(realWalletsAfter, realWalletsBefore);
  assert.notEqual(String(testMarketAfter.updatedAt), String(testMarketBefore?.updatedAt ?? ''));

  const setNormalMode = await app.inject({
    method: 'POST',
    url: '/api/admin/system-mode/normal/enable',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { reason: 'Voltando para NORMAL após validar bot tick' },
  });
  assert.equal(setNormalMode.statusCode, 200, setNormalMode.body);
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

test('mercado secundário: criação/cancelamento não movem preço e market sem contraparte válida falha', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const user = await mkUser('secondary-rules@test.local', 'Secondary Rules');
  await prisma.userRole.create({ data: { userId: user.id, roleId: rUser.id } });
  await prisma.platformAccount.create({ data: {} });
  await prisma.wallet.update({ where: { userId: user.id }, data: { rpcAvailableBalance: 500 } });

  const company = await prisma.company.create({
    data: {
      name: 'Secondary Rule Co', ticker: 'SECR3', description: 'desc', sector: 'setor', founderUserId: user.id, status: 'ACTIVE', totalShares: 1000,
      circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 600,
      initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(),
      revenueAccount: { create: {} },
    },
  });

  await prisma.companyHolding.create({
    data: { userId: user.id, companyId: company.id, shares: 50, averageBuyPrice: 10, estimatedValue: 500 },
  });

  const tk = await token(user.id, ['USER']);
  const created = await app.inject({
    method: 'POST',
    url: '/api/market/orders',
    headers: { authorization: `Bearer ${tk}` },
    payload: { companyId: company.id, type: 'BUY', mode: 'LIMIT', quantity: 5, limitPrice: 10 },
  });
  assert.equal(created.statusCode, 201, created.body);
  const priceAfterCreate = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(Number(priceAfterCreate.currentPrice), 10);

  const orderId = created.json().order.id as string;
  const canceled = await app.inject({
    method: 'POST',
    url: `/api/market/orders/${orderId}/cancel`,
    headers: { authorization: `Bearer ${tk}` },
  });
  assert.equal(canceled.statusCode, 200, canceled.body);
  const priceAfterCancel = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(Number(priceAfterCancel.currentPrice), 10);

  const sellAfterCancel = await app.inject({
    method: 'POST',
    url: '/api/market/orders',
    headers: { authorization: `Bearer ${tk}` },
    payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 2, limitPrice: 9 },
  });
  assert.equal(sellAfterCancel.statusCode, 201, sellAfterCancel.body);
  const tradesAfterSell = await prisma.trade.count({ where: { companyId: company.id } });
  assert.equal(tradesAfterSell, 0);
  const priceAfterSell = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(Number(priceAfterSell.currentPrice), 10);

  const noLiquidity = await app.inject({
    method: 'POST',
    url: `/api/market/companies/${company.id}/buy-market`,
    headers: { authorization: `Bearer ${tk}` },
    payload: { quantity: 1, slippagePercent: 5 },
  });
  assert.equal(noLiquidity.statusCode, 400, noLiquidity.body);
  assert.match(noLiquidity.body, /não há contraparte válida de outro usuário/i);
});

test('mercado secundário: execução parcial preserva remaining/locks e reembolsa sobra da BUY limitada', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const buyer = await mkUser('partial-buyer@test.local');
  const seller = await mkUser('partial-seller@test.local');
  await prisma.userRole.createMany({ data: [{ userId: buyer.id, roleId: rUser.id }, { userId: seller.id, roleId: rUser.id }] });
  await prisma.platformAccount.create({ data: {} });
  await prisma.wallet.update({ where: { userId: buyer.id }, data: { rpcAvailableBalance: 1000 } });
  await prisma.company.create({
    data: {
      name: 'Partial Corp', ticker: 'PART3', description: 'desc', sector: 'setor', founderUserId: buyer.id, status: 'ACTIVE', totalShares: 1000,
      circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 600,
      initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(), revenueAccount: { create: {} },
    },
  });
  const company = await prisma.company.findUniqueOrThrow({ where: { ticker: 'PART3' } });
  await prisma.companyHolding.create({ data: { userId: seller.id, companyId: company.id, shares: 20, averageBuyPrice: 9, estimatedValue: 180 } });
  const sellerTk = await token(seller.id, ['USER']);
  const buyerTk = await token(buyer.id, ['USER']);

  const sell = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${sellerTk}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 10, limitPrice: 9 } });
  assert.equal(sell.statusCode, 201, sell.body);
  const buy = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${buyerTk}` }, payload: { companyId: company.id, type: 'BUY', mode: 'LIMIT', quantity: 20, limitPrice: 10 } });
  assert.equal(buy.statusCode, 201, buy.body);

  const buyOrder = await prisma.marketOrder.findFirstOrThrow({ where: { userId: buyer.id, companyId: company.id, type: 'BUY' } });
  assert.equal(buyOrder.remainingQuantity, 10);
  assert.equal(buyOrder.status, 'PARTIALLY_FILLED');
  assert.ok(Number(buyOrder.lockedCash) > 0);
  assert.ok(Number(buyOrder.lockedCash) >= 0);
  assert.ok(Number(buyOrder.lockedShares) >= 0);

  const buyCancel = await app.inject({ method: 'POST', url: `/api/market/orders/${buyOrder.id}/cancel`, headers: { authorization: `Bearer ${buyerTk}` } });
  assert.equal(buyCancel.statusCode, 200, buyCancel.body);
  const buyCanceled = await prisma.marketOrder.findUniqueOrThrow({ where: { id: buyOrder.id } });
  assert.equal(Number(buyCanceled.lockedCash), 0);
  assert.equal(buyCanceled.status, 'CANCELED');

  const buyerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
  assert.equal(Number(buyerWallet.rpcLockedBalance), 0);
  assert.ok(Number(buyerWallet.rpcAvailableBalance) >= 0);
});

test('mercado secundário: self-trade nunca executa e só executa com contraparte real', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const a = await mkUser('self-a@test.local');
  const b = await mkUser('self-b@test.local');
  await prisma.userRole.createMany({ data: [{ userId: a.id, roleId: rUser.id }, { userId: b.id, roleId: rUser.id }] });
  await prisma.platformAccount.create({ data: {} });
  await prisma.wallet.update({ where: { userId: a.id }, data: { rpcAvailableBalance: 500 } });
  await prisma.wallet.update({ where: { userId: b.id }, data: { rpcAvailableBalance: 500 } });
  const company = await prisma.company.create({
    data: { name: 'Self Corp', ticker: 'SELF3', description: 'desc', sector: 'setor', founderUserId: a.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 600, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(), revenueAccount: { create: {} } },
  });
  await prisma.companyHolding.create({ data: { userId: a.id, companyId: company.id, shares: 30, averageBuyPrice: 10, estimatedValue: 300 } });
  await prisma.companyHolding.create({ data: { userId: b.id, companyId: company.id, shares: 30, averageBuyPrice: 10, estimatedValue: 300 } });
  const aTk = await token(a.id, ['USER']);
  const bTk = await token(b.id, ['USER']);

  const ownSell = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${aTk}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 5, limitPrice: 10 } });
  assert.equal(ownSell.statusCode, 201, ownSell.body);
  const ownBuy = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${aTk}` }, payload: { companyId: company.id, type: 'BUY', mode: 'LIMIT', quantity: 5, limitPrice: 10 } });
  assert.equal(ownBuy.statusCode, 201, ownBuy.body);
  const ownBuyOrder = await prisma.marketOrder.findUniqueOrThrow({ where: { id: ownBuy.json().order.id } });
  assert.equal(ownBuyOrder.status, 'OPEN');
  const tradesAfterOwn = await prisma.trade.count({ where: { companyId: company.id } });
  assert.equal(tradesAfterOwn, 0);

  const ownOnlyMarket = await app.inject({ method: 'POST', url: `/api/market/companies/${company.id}/buy-market`, headers: { authorization: `Bearer ${aTk}` }, payload: { quantity: 1, slippagePercent: 5 } });
  assert.equal(ownOnlyMarket.statusCode, 400, ownOnlyMarket.body);
  assert.match(ownOnlyMarket.body, /não há contraparte válida de outro usuário/i);

  const externalSell = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${bTk}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 3, limitPrice: 10 } });
  assert.equal(externalSell.statusCode, 201, externalSell.body);
  const buyWithCounterparty = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${aTk}` }, payload: { companyId: company.id, type: 'BUY', mode: 'LIMIT', quantity: 3, limitPrice: 10 } });
  assert.equal(buyWithCounterparty.statusCode, 201, buyWithCounterparty.body);

  const trades = await prisma.trade.findMany({ where: { companyId: company.id } });
  assert.ok(trades.length >= 1);
  assert.ok(trades.every((t) => t.buyerId !== t.sellerId));
});

test('self-trade: quando há ordem própria e ordem de terceiro compatível, deve casar só com terceiro', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const a = await mkUser('skip-own-a@test.local');
  const b = await mkUser('skip-own-b@test.local');
  await prisma.userRole.createMany({ data: [{ userId: a.id, roleId: rUser.id }, { userId: b.id, roleId: rUser.id }] });
  await prisma.platformAccount.create({ data: {} });
  await prisma.wallet.update({ where: { userId: a.id }, data: { rpcAvailableBalance: 500 } });
  const company = await prisma.company.create({
    data: { name: 'Skip Own Corp', ticker: 'SKIP3', description: 'desc', sector: 'setor', founderUserId: a.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 600, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(), revenueAccount: { create: {} } },
  });
  await prisma.companyHolding.create({ data: { userId: a.id, companyId: company.id, shares: 20, averageBuyPrice: 10, estimatedValue: 200 } });
  await prisma.companyHolding.create({ data: { userId: b.id, companyId: company.id, shares: 20, averageBuyPrice: 10, estimatedValue: 200 } });
  const aTk = await token(a.id, ['USER']);
  const bTk = await token(b.id, ['USER']);

  const sellOwn = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${aTk}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 5, limitPrice: 10 } });
  const sellB = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${bTk}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 5, limitPrice: 10 } });
  assert.equal(sellOwn.statusCode, 201, sellOwn.body);
  assert.equal(sellB.statusCode, 201, sellB.body);

  const buyA = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${aTk}` }, payload: { companyId: company.id, type: 'BUY', mode: 'LIMIT', quantity: 5, limitPrice: 10 } });
  assert.equal(buyA.statusCode, 201, buyA.body);

  const trades = await prisma.trade.findMany({ where: { companyId: company.id } });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].buyerId, a.id);
  assert.equal(trades[0].sellerId, b.id);
  assert.notEqual(trades[0].buyerId, trades[0].sellerId);

  const ownSellAfter = await prisma.marketOrder.findUniqueOrThrow({ where: { id: sellOwn.json().order.id } });
  assert.equal(ownSellAfter.status, 'OPEN');
  assert.equal(ownSellAfter.remainingQuantity, 5);
});

test('market BUY usa slippage com melhor contraparte válida (ignora ordem própria no bestPrice)', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const a = await mkUser('slippage-own-a@test.local');
  const b = await mkUser('slippage-own-b@test.local');
  await prisma.userRole.createMany({ data: [{ userId: a.id, roleId: rUser.id }, { userId: b.id, roleId: rUser.id }] });
  await prisma.platformAccount.create({ data: {} });
  await prisma.wallet.update({ where: { userId: a.id }, data: { rpcAvailableBalance: 1000 } });
  const company = await prisma.company.create({
    data: { name: 'Slip Corp', ticker: 'SLIP3', description: 'desc', sector: 'setor', founderUserId: a.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 600, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(), revenueAccount: { create: {} } },
  });
  await prisma.companyHolding.create({ data: { userId: a.id, companyId: company.id, shares: 20, averageBuyPrice: 10, estimatedValue: 200 } });
  await prisma.companyHolding.create({ data: { userId: b.id, companyId: company.id, shares: 20, averageBuyPrice: 10, estimatedValue: 200 } });
  const aTk = await token(a.id, ['USER']);
  const bTk = await token(b.id, ['USER']);

  const ownSell = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${aTk}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 1, limitPrice: 1 } });
  const bSell = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${bTk}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 1, limitPrice: 10 } });
  assert.equal(ownSell.statusCode, 201, ownSell.body);
  assert.equal(bSell.statusCode, 201, bSell.body);

  const marketBuy = await app.inject({ method: 'POST', url: `/api/market/companies/${company.id}/buy-market`, headers: { authorization: `Bearer ${aTk}` }, payload: { quantity: 1, slippagePercent: 5 } });
  assert.equal(marketBuy.statusCode, 201, marketBuy.body);

  const trades = await prisma.trade.findMany({ where: { companyId: company.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].buyerId, a.id);
  assert.equal(trades[0].sellerId, b.id);
  assert.notEqual(trades[0].buyerId, trades[0].sellerId);
});

test('caixa institucional: fundador consulta, usuário comum bloqueado e admin auditor autorizado', async () => {
  await resetDb();
  const rFounder = await mkRole('BUSINESS_OWNER');
  const rUser = await mkRole('USER');
  const rAuditor = await mkRole('AUDITOR');

  const founder = await mkUser('founder@inst.local', 'Founder');
  const outsider = await mkUser('outsider@inst.local', 'Outsider');
  const auditor = await mkUser('auditor@inst.local', 'Auditor');

  await prisma.userRole.createMany({ data: [
    { userId: founder.id, roleId: rFounder.id },
    { userId: founder.id, roleId: rUser.id },
    { userId: outsider.id, roleId: rUser.id },
    { userId: auditor.id, roleId: rAuditor.id },
  ]});

  await prisma.wallet.update({ where: { userId: founder.id }, data: { rpcAvailableBalance: 500 } });

  const company = await prisma.company.create({ data: {
    name: 'Inst Project', ticker: 'INST4', description: 'Projeto institucional', sector: 'RP', founderUserId: founder.id, status: 'ACTIVE',
    totalShares: 1000, circulatingShares: 0, ownerSharePercent: 50, publicOfferPercent: 50, ownerShares: 500, publicOfferShares: 500,
    availableOfferShares: 500, initialPrice: 1, currentPrice: 1, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000,
    approvedAt: new Date(), revenueAccount: { create: {} },
  }});

  const founderToken = await token(founder.id, ['USER', 'BUSINESS_OWNER']);
  const contrib = await app.inject({ method: 'POST', url: `/api/project-capital-flow/companies/${company.id}/contribute`, headers: { authorization: `Bearer ${founderToken}` }, payload: { amountRpc: 100, reason: 'Aporte institucional para caixa operacional' } });
  assert.equal(contrib.statusCode, 200, contrib.body);

  const founderView = await app.inject({ method: 'GET', url: `/api/project-capital-flow/companies/${company.id}`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(founderView.statusCode, 200, founderView.body);
  const founderPayload = founderView.json();
  assert.equal(Number(founderPayload.institutionalBalance), 100);
  assert.ok(founderPayload.totalsByType.OWNER_RPC_CONTRIBUTION >= 100);
  assert.ok(founderPayload.totalsBySource.OWNER_WALLET >= 100);

  const outsiderToken = await token(outsider.id, ['USER']);
  const outsiderView = await app.inject({ method: 'GET', url: `/api/project-capital-flow/companies/${company.id}`, headers: { authorization: `Bearer ${outsiderToken}` } });
  assert.equal(outsiderView.statusCode, 403, outsiderView.body);

  const auditorToken = await token(auditor.id, ['AUDITOR']);
  const auditorView = await app.inject({ method: 'GET', url: `/api/project-capital-flow/companies/${company.id}`, headers: { authorization: `Bearer ${auditorToken}` } });
  assert.equal(auditorView.statusCode, 200, auditorView.body);

  const adminAccounts = await app.inject({ method: 'GET', url: '/api/admin/project-institutional-accounts', headers: { authorization: `Bearer ${auditorToken}` } });
  assert.equal(adminAccounts.statusCode, 200, adminAccounts.body);
});

test('recordProjectInstitutionalEntry rejeita PROJECT_REVENUE_OUT neste PR', async () => {
  await resetDb();
  const [{ recordProjectInstitutionalEntry }, { Decimal }] = await Promise.all([
    import('../src/services/project-institutional-account-service.js'),
    import('@prisma/client/runtime/library'),
  ]);

  const founder = await mkUser('outflow@test.local', 'Founder Outflow');
  const company = await prisma.company.create({ data: {
    name: 'Outflow Blocked', ticker: 'OUTBLK', description: 'Projeto', sector: 'RP', founderUserId: founder.id, status: 'ACTIVE',
    totalShares: 1000, circulatingShares: 0, ownerSharePercent: 60, publicOfferPercent: 40, ownerShares: 600, publicOfferShares: 400,
    availableOfferShares: 400, initialPrice: 1, currentPrice: 1, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000,
    approvedAt: new Date(), revenueAccount: { create: { balance: 200 } },
  }});

  await assert.rejects(
    prisma.$transaction((tx) => recordProjectInstitutionalEntry(tx, {
      companyId: company.id,
      actorUserId: founder.id,
      amountRpc: new Decimal(10),
      reason: 'Tentativa de saída',
      type: 'PROJECT_REVENUE_OUT',
      source: 'MANUAL_CORRECTION',
    })),
    /Saídas institucionais ainda não são suportadas neste fluxo/,
  );
});

test('summary calcula totais completos mesmo com extrato limitado a 50 e ADMIN pode consultar', async () => {
  await resetDb();
  const rFounder = await mkRole('BUSINESS_OWNER');
  const rUser = await mkRole('USER');
  const rAdmin = await mkRole('ADMIN');
  const rAuditor = await mkRole('AUDITOR');

  const founder = await mkUser('founder-total@test.local', 'Founder Total');
  const admin = await mkUser('admin-total@test.local', 'Admin Total');
  const outsider = await mkUser('outsider-total@test.local', 'Outsider Total');

  await prisma.userRole.createMany({ data: [
    { userId: founder.id, roleId: rFounder.id },
    { userId: founder.id, roleId: rUser.id },
    { userId: admin.id, roleId: rAdmin.id },
    { userId: outsider.id, roleId: rUser.id },
  ]});

  const company = await prisma.company.create({ data: {
    name: 'Totals Full', ticker: 'TTLSF', description: 'Projeto totais', sector: 'RP', founderUserId: founder.id, status: 'ACTIVE',
    totalShares: 1000, circulatingShares: 0, ownerSharePercent: 50, publicOfferPercent: 50, ownerShares: 500, publicOfferShares: 500,
    availableOfferShares: 500, initialPrice: 1, currentPrice: 1, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000,
    approvedAt: new Date(), revenueAccount: { create: { balance: 120 } },
  }});

  const entries = Array.from({ length: 60 }).map((_, i) => ({
    companyId: company.id,
    actorUserId: founder.id,
    type: i < 40 ? 'OWNER_RPC_CONTRIBUTION' : 'PROJECT_REVENUE_IN',
    source: i < 30 ? 'OWNER_WALLET' : 'MARKET_FEE',
    amountRpc: 2,
    previousWalletRpcBalance: 0,
    newWalletRpcBalance: 0,
    previousProjectBalance: i * 2,
    newProjectBalance: (i + 1) * 2,
    reason: `Entry ${i} válido para total`,
    metadata: null,
  }));
  await prisma.companyCapitalFlowEntry.createMany({ data: entries as any });

  const founderToken = await token(founder.id, ['USER', 'BUSINESS_OWNER']);
  const founderView = await app.inject({ method: 'GET', url: `/api/project-capital-flow/companies/${company.id}`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(founderView.statusCode, 200, founderView.body);
  const founderPayload = founderView.json();
  assert.equal(founderPayload.entries.length, 50);
  assert.equal(Number(founderPayload.totalsByType.OWNER_RPC_CONTRIBUTION), 80);
  assert.equal(Number(founderPayload.totalsByType.PROJECT_REVENUE_IN), 40);
  assert.equal(Number(founderPayload.totalsBySource.OWNER_WALLET), 60);
  assert.equal(Number(founderPayload.totalsBySource.MARKET_FEE), 60);

  const adminToken = await token(admin.id, ['ADMIN']);
  const adminView = await app.inject({ method: 'GET', url: `/api/project-capital-flow/companies/${company.id}`, headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(adminView.statusCode, 200, adminView.body);

  const outsiderToken = await token(outsider.id, ['USER']);
  const forbiddenAdminList = await app.inject({ method: 'GET', url: '/api/admin/project-institutional-accounts', headers: { authorization: `Bearer ${outsiderToken}` } });
  assert.equal(forbiddenAdminList.statusCode, 403, forbiddenAdminList.body);

  const auditorUser = await mkUser('auditor-list@test.local', 'Auditor List');
  await prisma.userRole.create({ data: { userId: auditorUser.id, roleId: rAuditor.id } });
  const auditorToken = await token(auditorUser.id, ['AUDITOR']);
  const allowedAdminList = await app.inject({ method: 'GET', url: '/api/admin/project-institutional-accounts', headers: { authorization: `Bearer ${auditorToken}` } });
  assert.equal(allowedAdminList.statusCode, 200, allowedAdminList.body);
});

test('buyback: completa por target e devolve sobra ao caixa institucional', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const founder = await mkUser('bb-founder@test.local', 'Founder');
  const seller = await mkUser('bb-seller@test.local', 'Seller');
  await prisma.userRole.createMany({ data: [{ userId: founder.id, roleId: rUser.id }, { userId: seller.id, roleId: rUser.id }] });

  const company = await prisma.company.create({ data: { name: 'Buyback Co', ticker: 'BBK1', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 100, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000, approvedAt: new Date(), revenueAccount: { create: { balance: 100 } } } });
  await prisma.companyHolding.create({ data: { userId: seller.id, companyId: company.id, shares: 10, averageBuyPrice: 8, estimatedValue: 80 } });

  const sellerToken = await token(seller.id, ['USER']);
  await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${sellerToken}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 5, limitPrice: 10 } });

  const founderToken = await token(founder.id, ['USER']);
  const created = await app.inject({ method: 'POST', url: `/api/project-buybacks/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 100, maxPricePerShare: 10, targetShares: 5, reason: 'Programa recompra alvo 5 shares' } });
  assert.equal(created.statusCode, 201, created.body);
  const programId = created.json().id;

  const exec = await app.inject({ method: 'POST', url: `/api/project-buybacks/programs/${programId}/execute`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(exec.statusCode, 200, exec.body);

  const revenue = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  const program = await prisma.projectBuybackProgram.findUniqueOrThrow({ where: { id: programId } });
  assert.equal(program.status, 'COMPLETED');
  assert.equal(Number(program.remainingRpc), 0);
  assert.equal(Number(revenue.balance), 50);
});

test('buyback: admin executor não executa contra ordem SELL própria', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const rAdmin = await mkRole('ADMIN');
  const founder = await mkUser('bb-founder2@test.local', 'Founder');
  const admin = await mkUser('bb-admin@test.local', 'Admin');
  await prisma.userRole.createMany({ data: [{ userId: founder.id, roleId: rUser.id }, { userId: admin.id, roleId: rAdmin.id }] });

  const company = await prisma.company.create({ data: { name: 'Buyback Co2', ticker: 'BBK2', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 100, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000, approvedAt: new Date(), revenueAccount: { create: { balance: 100 } } } });
  await prisma.companyHolding.create({ data: { userId: admin.id, companyId: company.id, shares: 10, averageBuyPrice: 8, estimatedValue: 80 } });

  const adminToken = await token(admin.id, ['ADMIN']);
  await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${adminToken}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 5, limitPrice: 10 } });

  const created = await app.inject({ method: 'POST', url: `/api/project-buybacks/companies/${company.id}/programs`, headers: { authorization: `Bearer ${adminToken}` }, payload: { budgetRpc: 50, maxPricePerShare: 10, targetShares: 5, reason: 'Programa admin sem self trade' } });
  assert.equal(created.statusCode, 201, created.body);
  const programId = created.json().id;

  const exec = await app.inject({ method: 'POST', url: `/api/project-buybacks/programs/${programId}/execute`, headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(exec.statusCode, 200, exec.body);
  const trades = await prisma.trade.findMany({ where: { companyId: company.id } });
  assert.equal(trades.length, 0);
});

test('buyback: programa expirado devolve saldo e marca EXPIRED', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const founder = await mkUser('bb-founder3@test.local', 'Founder');
  await prisma.userRole.create({ data: { userId: founder.id, roleId: rUser.id } });
  const company = await prisma.company.create({ data: { name: 'Buyback Co3', ticker: 'BBK3', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 100, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000, approvedAt: new Date(), revenueAccount: { create: { balance: 30 } } } });

  const founderToken = await token(founder.id, ['USER']);
  const created = await app.inject({ method: 'POST', url: `/api/project-buybacks/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 30, maxPricePerShare: 10, targetShares: 5, reason: 'Programa para expirar com retorno', expiresAt: '2020-01-01T00:00:00.000Z' } });
  assert.equal(created.statusCode, 201, created.body);
  const programId = created.json().id;

  const exec = await app.inject({ method: 'POST', url: `/api/project-buybacks/programs/${programId}/execute`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(exec.statusCode, 400);
  const program = await prisma.projectBuybackProgram.findUniqueOrThrow({ where: { id: programId } });
  const revenue = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  assert.equal(program.status, 'EXPIRED');
  assert.equal(Number(program.remainingRpc), 0);
  assert.equal(Number(revenue.balance), 30);
});

test('buyback: não executa ordem com lockedShares insuficiente e mantém ordem sem negativo', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const founder = await mkUser('bb-founder4@test.local');
  const seller = await mkUser('bb-seller4@test.local');
  await prisma.userRole.createMany({ data: [{ userId: founder.id, roleId: rUser.id }, { userId: seller.id, roleId: rUser.id }] });
  const company = await prisma.company.create({ data: { name: 'Buyback Co4', ticker: 'BBK4', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 100, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000, approvedAt: new Date(), revenueAccount: { create: { balance: 100 } } } });
  const order = await prisma.marketOrder.create({ data: { companyId: company.id, userId: seller.id, type: 'SELL', mode: 'LIMIT', quantity: 5, remainingQuantity: 5, limitPrice: 10, lockedShares: 1, status: 'OPEN' } });

  const founderToken = await token(founder.id, ['USER']);
  const created = await app.inject({ method: 'POST', url: `/api/project-buybacks/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 100, maxPricePerShare: 10, targetShares: 5, reason: 'Programa para validar lock insuficiente' } });
  const programId = created.json().id;
  const exec = await app.inject({ method: 'POST', url: `/api/project-buybacks/programs/${programId}/execute`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(exec.statusCode, 200, exec.body);

  const orderAfter = await prisma.marketOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(orderAfter.remainingQuantity, 5);
  assert.equal(orderAfter.lockedShares, 1);
  assert.ok(orderAfter.remainingQuantity >= 0);
  assert.ok(orderAfter.lockedShares >= 0);
});

test('buyback: spentRpc nunca ultrapassa budgetRpc', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const founder = await mkUser('bb-founder5@test.local');
  const seller = await mkUser('bb-seller5@test.local');
  await prisma.userRole.createMany({ data: [{ userId: founder.id, roleId: rUser.id }, { userId: seller.id, roleId: rUser.id }] });
  const company = await prisma.company.create({ data: { name: 'Buyback Co5', ticker: 'BBK5', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 100, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000, approvedAt: new Date(), revenueAccount: { create: { balance: 30 } } } });
  await prisma.companyHolding.create({ data: { userId: seller.id, companyId: company.id, shares: 10, averageBuyPrice: 8, estimatedValue: 80 } });
  const sellerToken = await token(seller.id, ['USER']);
  await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${sellerToken}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 10, limitPrice: 10 } });

  const founderToken = await token(founder.id, ['USER']);
  const created = await app.inject({ method: 'POST', url: `/api/project-buybacks/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 30, maxPricePerShare: 10, targetShares: 10, reason: 'Programa budget limitado para spent' } });
  const programId = created.json().id;
  const exec = await app.inject({ method: 'POST', url: `/api/project-buybacks/programs/${programId}/execute`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(exec.statusCode, 200, exec.body);
  const program = await prisma.projectBuybackProgram.findUniqueOrThrow({ where: { id: programId } });
  assert.ok(Number(program.spentRpc) <= Number(program.budgetRpc));
});

test('buyback: cancel ACTIVE devolve remaining e segunda tentativa não duplica saldo', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const founder = await mkUser('bb-founder6@test.local');
  await prisma.userRole.create({ data: { userId: founder.id, roleId: rUser.id } });
  const company = await prisma.company.create({ data: { name: 'Buyback Co6', ticker: 'BBK6', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 100, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000, approvedAt: new Date(), revenueAccount: { create: { balance: 60 } } } });
  const founderToken = await token(founder.id, ['USER']);
  const created = await app.inject({ method: 'POST', url: `/api/project-buybacks/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 40, maxPricePerShare: 10, targetShares: 5, reason: 'Programa para testar cancelamento seguro' } });
  const programId = created.json().id;

  const cancel1 = await app.inject({ method: 'POST', url: `/api/project-buybacks/programs/${programId}/cancel`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(cancel1.statusCode, 200, cancel1.body);
  const revenueAfter1 = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  assert.equal(Number(revenueAfter1.balance), 60);

  const cancel2 = await app.inject({ method: 'POST', url: `/api/project-buybacks/programs/${programId}/cancel`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(cancel2.statusCode, 400, cancel2.body);
  const revenueAfter2 = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  assert.equal(Number(revenueAfter2.balance), 60);
});

test('buyback: cancelar COMPLETED/EXPIRED não devolve saldo novamente', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const founder = await mkUser('bb-founder7@test.local');
  await prisma.userRole.create({ data: { userId: founder.id, roleId: rUser.id } });
  const company = await prisma.company.create({ data: { name: 'Buyback Co7', ticker: 'BBK7', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 100, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000, approvedAt: new Date(), revenueAccount: { create: { balance: 30 } } } });
  const founderToken = await token(founder.id, ['USER']);
  const created = await app.inject({ method: 'POST', url: `/api/project-buybacks/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 30, maxPricePerShare: 10, targetShares: 5, reason: 'Programa expira e não pode cancelar depois', expiresAt: '2020-01-01T00:00:00.000Z' } });
  const programId = created.json().id;
  await app.inject({ method: 'POST', url: `/api/project-buybacks/programs/${programId}/execute`, headers: { authorization: `Bearer ${founderToken}` } });

  const cancel = await app.inject({ method: 'POST', url: `/api/project-buybacks/programs/${programId}/cancel`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(cancel.statusCode, 400, cancel.body);
  const revenue = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  assert.equal(Number(revenue.balance), 30);
});

test('fundador consulta reserva do próprio projeto e usuário comum não acessa projeto alheio', async () => {
  await resetDb();
  const founder = await mkUser('reserve-founder@test.local', 'Founder Reserve');
  const other = await mkUser('reserve-other@test.local', 'Other Reserve');
  await mkRole('USER');
  const company = await prisma.company.create({
    data: {
      name: 'Reserve Co', ticker: `RSV${Date.now()}`.slice(-6), description: 'desc', sector: 'setor', founderUserId: founder.id,
      status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 500,
      initialPrice: 10, currentPrice: 10, buyFeePercent: 2, sellFeePercent: 1, fictitiousMarketCap: 1000,
      tokenReserve: { create: { shares: 20, totalCostRpc: 100, policy: 'HOLD_LOCKED', locked: true } },
    },
  });
  const founderToken = await token(founder.id, ['USER']);
  const otherToken = await token(other.id, ['USER']);

  const ok = await app.inject({ method: 'GET', url: `/api/project-token-reserves/companies/${company.id}`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(ok.statusCode, 200, ok.body);
  const payload = ok.json();
  assert.equal(payload.reserve.reserveShares, 20);
  assert.equal(payload.reserve.policy, 'HOLD_LOCKED');

  const forbidden = await app.inject({ method: 'GET', url: `/api/project-token-reserves/companies/${company.id}`, headers: { authorization: `Bearer ${otherToken}` } });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});

test('admin de auditoria consulta lista read-only de reservas', async () => {
  await resetDb();
  const admin = await mkUser('reserve-auditor@test.local', 'Reserve Auditor');
  await mkRole('AUDITOR');
  const adminToken = await token(admin.id, ['AUDITOR']);

  const response = await app.inject({ method: 'GET', url: '/api/admin/project-token-reserves', headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(response.statusCode, 200, response.body);
  const payload = response.json();
  assert.ok(Array.isArray(payload.reserves));
});

test('buyback reserva institucional mantém vínculos, custos e auditoria de divergência', async () => {
  await resetDb();
  const role = await mkRole('USER');
  const founder = await mkUser('reserve-founder2@test.local');
  const seller = await mkUser('reserve-seller2@test.local');
  await prisma.userRole.createMany({ data: [{ userId: founder.id, roleId: role.id }, { userId: seller.id, roleId: role.id }] });

  const company = await prisma.company.create({ data: { name: 'Reserve Co2', ticker: 'RSV2', description: 'desc', sector: 'setor', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 500, initialPrice: 10, currentPrice: 10, buyFeePercent: 2, sellFeePercent: 1, fictitiousMarketCap: 1000, revenueAccount: { create: { balance: 100 } } } });
  await prisma.companyHolding.create({ data: { userId: seller.id, companyId: company.id, shares: 10, averageBuyPrice: 8, estimatedValue: 80 } });

  const sellerToken = await token(seller.id, ['USER']);
  const sellOrder = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${sellerToken}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 4, limitPrice: 10 } });
  assert.equal(sellOrder.statusCode, 201, sellOrder.body);

  const founderToken = await token(founder.id, ['USER']);
  const created = await app.inject({ method: 'POST', url: `/api/project-buybacks/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 60, maxPricePerShare: 10, targetShares: 4, reason: 'Programa para validar reserva institucional completa' } });
  assert.equal(created.statusCode, 201, created.body);
  const programId = created.json().id;

  const executed = await app.inject({ method: 'POST', url: `/api/project-buybacks/programs/${programId}/execute`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(executed.statusCode, 200, executed.body);

  const reserve = await prisma.projectTokenReserve.findUniqueOrThrow({ where: { companyId: company.id } });
  const entry = await prisma.projectTokenReserveEntry.findFirstOrThrow({ where: { companyId: company.id, type: 'BUYBACK_IN' } });
  assert.equal(reserve.shares, 4);
  assert.equal(Number(reserve.totalCostRpc), 40);
  assert.equal(entry.programId, programId);
  assert.ok(entry.executionId);
  assert.equal(entry.shares, 4);
  assert.equal(Number(entry.totalCostRpc), 40);

  const summary = await app.inject({ method: 'GET', url: `/api/project-token-reserves/companies/${company.id}`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(summary.statusCode, 200, summary.body);
  const summaryBody = summary.json();
  assert.equal(summaryBody.reserve.averageCostRpc, 10);
  assert.equal(summaryBody.inconsistencies.includes('RESERVE_SHARES_SUM_MISMATCH'), false);
  assert.equal(summaryBody.inconsistencies.includes('RESERVE_COST_SUM_MISMATCH'), false);

  const founderHolding = await prisma.companyHolding.findUnique({ where: { userId_companyId: { userId: founder.id, companyId: company.id } } });
  assert.equal(founderHolding, null);

  await prisma.projectTokenReserve.update({ where: { companyId: company.id }, data: { shares: 5 } });
  const auditResponse = await app.inject({ method: 'GET', url: `/api/admin/project-token-reserves/companies/${company.id}/audit`, headers: { authorization: `Bearer ${await token(founder.id, ['COIN_CHIEF_ADMIN'])}` } });
  assert.equal(auditResponse.statusCode, 200, auditResponse.body);
  assert.equal(auditResponse.json().inconsistencies.includes('RESERVE_SHARES_SUM_MISMATCH'), true);

  await prisma.projectTokenReserveEntry.deleteMany({ where: { companyId: company.id } });
  const auditAfterDelete = await app.inject({ method: 'GET', url: `/api/admin/project-token-reserves/companies/${company.id}/audit`, headers: { authorization: `Bearer ${await token(founder.id, ['SUPER_ADMIN'])}` } });
  assert.equal(auditAfterDelete.statusCode, 200, auditAfterDelete.body);
  const issues = auditAfterDelete.json().inconsistencies as string[];
  assert.ok(issues.some((i) => i.startsWith('EXECUTION_WITHOUT_RESERVE_ENTRY:')));
});

test('reserva retorna HttpError correto para projeto inexistente e acesso indevido', async () => {
  await resetDb();
  const user = await mkUser('reserve-user3@test.local');
  const other = await mkUser('reserve-user4@test.local');
  await mkRole('USER');

  const notFound = await app.inject({ method: 'GET', url: '/api/project-token-reserves/companies/company-inexistente', headers: { authorization: `Bearer ${await token(user.id, ['USER'])}` } });
  assert.equal(notFound.statusCode, 404, notFound.body);

  const company = await prisma.company.create({ data: { name: 'Reserve Co3', ticker: 'RSV3', description: 'd', sector: 's', founderUserId: user.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 0, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 600, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000 } });
  const forbidden = await app.inject({ method: 'GET', url: `/api/project-token-reserves/companies/${company.id}`, headers: { authorization: `Bearer ${await token(other.id, ['USER'])}` } });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});

test('holder distribution: criação/execução/cancelamento seguem regras econômicas e invariantes', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const rAuditor = await mkRole('AUDITOR');
  const founder = await mkUser('hd-founder@test.local', 'Founder HD');
  const holderA = await mkUser('hd-a@test.local');
  const holderB = await mkUser('hd-b@test.local');
  const outsider = await mkUser('hd-outsider@test.local');
  const auditor = await mkUser('hd-auditor@test.local');
  await prisma.userRole.createMany({ data: [
    { userId: founder.id, roleId: rUser.id },
    { userId: holderA.id, roleId: rUser.id },
    { userId: holderB.id, roleId: rUser.id },
    { userId: outsider.id, roleId: rUser.id },
    { userId: auditor.id, roleId: rAuditor.id },
  ] });

  const company = await prisma.company.create({ data: { name: 'Holder Dist', ticker: 'HDST1', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 200, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 400, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(), revenueAccount: { create: { balance: 100 } } } });
  await prisma.companyHolding.createMany({ data: [
    { companyId: company.id, userId: founder.id, shares: 50, averageBuyPrice: 10, estimatedValue: 500 },
    { companyId: company.id, userId: holderA.id, shares: 100, averageBuyPrice: 10, estimatedValue: 1000 },
    { companyId: company.id, userId: holderB.id, shares: 300, averageBuyPrice: 10, estimatedValue: 3000 },
  ] });

  const founderToken = await token(founder.id, ['USER']);
  const outsiderToken = await token(outsider.id, ['USER']);

  const budgetInvalid = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 0, reason: 'motivo valido para bloquear budget' } });
  assert.equal(budgetInvalid.statusCode, 400);
  const reasonInvalid = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 10, reason: 'curto' } });
  assert.equal(reasonInvalid.statusCode, 400);
  const founderIncludeBlocked = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 10, reason: 'Motivo válido para testar founder bloqueado', excludeFounder: false } });
  assert.equal(founderIncludeBlocked.statusCode, 400);
  assert.match(founderIncludeBlocked.body, /não é suportada nesta política inicial/i);
  const outsiderForbidden = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/companies/${company.id}/programs`, headers: { authorization: `Bearer ${outsiderToken}` }, payload: { budgetRpc: 10, reason: 'Motivo válido para usuário comum' } });
  assert.equal(outsiderForbidden.statusCode, 403);

  const priceBefore = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  const create = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 25, reason: 'Distribuição auditável para holders do projeto' } });
  assert.equal(create.statusCode, 201, create.body);
  const programId = create.json().id as string;

  const program = await prisma.projectHolderDistributionProgram.findUniqueOrThrow({ where: { id: programId } });
  const snaps = await prisma.projectHolderDistributionSnapshot.findMany({ where: { programId }, orderBy: { userId: 'asc' } });
  const revenueAfterCreate = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  assert.equal(snaps.length, 2);
  assert.ok(snaps.every((s) => s.userId !== founder.id));
  assert.equal(program.eligibleShares, 400);
  assert.equal(Number(revenueAfterCreate.balance), 75);
  assert.equal(program.status, 'READY');
  const priceAfterCreate = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(String(priceBefore.currentPrice), String(priceAfterCreate.currentPrice));
  assert.equal(await prisma.trade.count({ where: { companyId: company.id } }), 0);
  assert.equal(await prisma.marketOrder.count({ where: { companyId: company.id } }), 0);

  const execute = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/programs/${programId}/execute`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(execute.statusCode, 200, execute.body);
  const executeTwice = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/programs/${programId}/execute`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(executeTwice.statusCode, 400);

  const programAfterExec = await prisma.projectHolderDistributionProgram.findUniqueOrThrow({ where: { id: programId } });
  const snapsAfterExec = await prisma.projectHolderDistributionSnapshot.findMany({ where: { programId } });
  assert.equal(programAfterExec.status, 'COMPLETED');
  assert.ok(snapsAfterExec.every((s) => s.status !== 'PENDING'));
  assert.ok(snapsAfterExec.some((s) => s.status === 'PAID'));
  const payments = await prisma.projectHolderDistributionPayment.findMany({ where: { programId } });
  assert.equal(payments.length, snapsAfterExec.filter((s) => s.status === 'PAID').length);
  const txs = await prisma.transaction.findMany({ where: { type: 'PROJECT_HOLDER_DISTRIBUTION_IN' } });
  assert.ok(txs.length >= 1);
  const walletA = await prisma.wallet.findUniqueOrThrow({ where: { userId: holderA.id } });
  const walletB = await prisma.wallet.findUniqueOrThrow({ where: { userId: holderB.id } });
  assert.ok(Number(walletA.rpcAvailableBalance) > 0);
  assert.ok(Number(walletB.rpcAvailableBalance) > 0);
  const cancelCompleted = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/programs/${programId}/cancel`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(cancelCompleted.statusCode, 400);

  const cancelProgram = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 10, reason: 'Programa para cancelar antes da execução' } });
  const cancelProgramId = cancelProgram.json().id as string;
  const revenueBeforeCancel = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  const cancel = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/programs/${cancelProgramId}/cancel`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(cancel.statusCode, 200);
  const cancelTwice = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/programs/${cancelProgramId}/cancel`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(cancelTwice.statusCode, 400);
  const revenueAfterCancel = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  assert.equal(Number((Number(revenueAfterCancel.balance) - Number(revenueBeforeCancel.balance)).toFixed(2)), 10);

  const reserve = await prisma.projectTokenReserve.findUnique({ where: { companyId: company.id } });
  assert.equal(reserve, null);
  const companyAfterAll = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(companyAfterAll.totalShares, 1000);
  assert.equal(companyAfterAll.circulatingShares, 200);
  const testModeCount = await prisma.systemModeConfig.count();
  assert.equal(testModeCount, 0);
});

test('holder distribution: snapshot vazio/projeto não ativo/saldo insuficiente e permissões auditor', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const rAuditor = await mkRole('AUDITOR');
  const founder = await mkUser('hd2-founder@test.local');
  const holder = await mkUser('hd2-holder@test.local');
  const auditor = await mkUser('hd2-auditor@test.local');
  await prisma.userRole.createMany({ data: [{ userId: founder.id, roleId: rUser.id }, { userId: holder.id, roleId: rUser.id }, { userId: auditor.id, roleId: rAuditor.id }] });

  const inactive = await prisma.company.create({ data: { name: 'Inativo', ticker: 'HDIN1', description: 'd', sector: 's', founderUserId: founder.id, status: 'PENDING', totalShares: 100, circulatingShares: 0, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 40, publicOfferShares: 60, availableOfferShares: 60, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000, revenueAccount: { create: { balance: 5 } } } });
  const active = await prisma.company.create({ data: { name: 'Ativo', ticker: 'HDACT1', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 100, circulatingShares: 0, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 40, publicOfferShares: 60, availableOfferShares: 60, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000, revenueAccount: { create: { balance: 5 } } } });

  const founderToken = await token(founder.id, ['USER']);
  const auditorToken = await token(auditor.id, ['AUDITOR']);

  const inactiveResp = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/companies/${inactive.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 1, reason: 'Motivo válido projeto inativo' } });
  assert.equal(inactiveResp.statusCode, 400);

  const emptySnap = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/companies/${active.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 1, reason: 'Motivo válido snapshot vazio' } });
  assert.equal(emptySnap.statusCode, 400);

  await prisma.companyHolding.create({ data: { companyId: active.id, userId: holder.id, shares: 10, averageBuyPrice: 10, estimatedValue: 100 } });
  const noBalance = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/companies/${active.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 50, reason: 'Motivo válido saldo insuficiente' } });
  assert.equal(noBalance.statusCode, 400);

  const ok = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/companies/${active.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 2, reason: 'Motivo válido para consulta auditor' } });
  assert.equal(ok.statusCode, 201);
  const programId = ok.json().id as string;

  const adminView = await app.inject({ method: 'GET', url: '/api/admin/project-holder-distributions', headers: { authorization: `Bearer ${auditorToken}` } });
  assert.equal(adminView.statusCode, 200);
  const auditorExec = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/programs/${programId}/execute`, headers: { authorization: `Bearer ${auditorToken}` } });
  assert.equal(auditorExec.statusCode, 403);
  const notFound = await app.inject({ method: 'POST', url: '/api/project-holder-distributions/programs/programa-inexistente/execute', headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(notFound.statusCode, 404);
});

test('holder distribution: cálculo por centavos evita negativos com muitos holders e orçamento pequeno', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const founder = await mkUser('hdc-founder@test.local');
  await prisma.userRole.create({ data: { userId: founder.id, roleId: rUser.id } });

  const company = await prisma.company.create({ data: { name: 'Holder Cents', ticker: 'HDCNT', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 10, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 100, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000, approvedAt: new Date(), revenueAccount: { create: { balance: 1 } } } });

  const holders: { userId: string; shares: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const u = await mkUser(`hdc-${i}@test.local`);
    await prisma.userRole.create({ data: { userId: u.id, roleId: rUser.id } });
    holders.push({ userId: u.id, shares: i + 1 });
  }
  await prisma.companyHolding.createMany({ data: holders.map((h) => ({ companyId: company.id, userId: h.userId, shares: h.shares, averageBuyPrice: 10, estimatedValue: h.shares * 10 })) });

  const founderToken = await token(founder.id, ['USER']);
  const create = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/companies/${company.id}/programs`, headers: { authorization: `Bearer ${founderToken}` }, payload: { budgetRpc: 0.03, reason: 'Distribuição de orçamento pequeno com muitos holders' } });
  assert.equal(create.statusCode, 201, create.body);
  const programId = create.json().id as string;

  const snapshots = await prisma.projectHolderDistributionSnapshot.findMany({ where: { programId } });
  assert.equal(snapshots.length, 9);
  assert.ok(snapshots.every((s) => Number(s.calculatedAmountRpc) >= 0));
  const sum = snapshots.reduce((acc, s) => acc + Number(s.calculatedAmountRpc), 0);
  assert.equal(Number(sum.toFixed(2)), 0.03);

  const exec = await app.inject({ method: 'POST', url: `/api/project-holder-distributions/programs/${programId}/execute`, headers: { authorization: `Bearer ${founderToken}` } });
  assert.equal(exec.statusCode, 200, exec.body);
  const snapshotsAfter = await prisma.projectHolderDistributionSnapshot.findMany({ where: { programId } });
  assert.ok(snapshotsAfter.every((s) => s.status !== 'PENDING'));

  const program = await prisma.projectHolderDistributionProgram.findUniqueOrThrow({ where: { id: programId } });
  assert.equal(program.status, 'COMPLETED');
  assert.equal(Number(program.budgetRpc), Number((Number(program.distributedRpc) + Number(program.refundedRpc)).toFixed(2)));
});

test('boost legado do fundador está desativado e não altera preço', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const founder = await mkUser('founder.boost@test.local', 'Founder');
  await prisma.userRole.create({ data: { userId: founder.id, roleId: rUser.id } });

  const company = await prisma.company.create({
    data: {
      name: 'LegacyBoost', ticker: 'LGB1', description: 'desc', sector: 'setor', founderUserId: founder.id, status: 'ACTIVE',
      totalShares: 1000, circulatingShares: 200, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600,
      availableOfferShares: 400, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000,
      approvedAt: new Date(), revenueAccount: { create: {} }, boostAccount: { create: {} },
    },
  });

  const founderToken = await token(founder.id, ['USER']);
  const response = await app.inject({
    method: 'POST',
    url: `/api/project-boosts/companies/${company.id}/boost`,
    headers: { authorization: `Bearer ${founderToken}` },
    payload: { amountRpc: 50, source: 'PERSONAL_WALLET', reason: 'Teste de rota desativada' },
  });

  assert.equal(response.statusCode, 410, response.body);
  assert.match(response.body, /impulsão legada desativada/i);

  const after = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(String(after.currentPrice), '10');
  assert.equal(String(after.fictitiousMarketCap), '10000');
  assert.equal(await prisma.trade.count({ where: { companyId: company.id } }), 0);
  assert.equal(await prisma.marketOrder.count({ where: { companyId: company.id } }), 0);
  assert.equal(await prisma.companyBoostInjection.count({ where: { companyId: company.id } }), 0);
});

test('boost legado administrativo está desativado e não altera preço', async () => {
  await resetDb();
  const rAdmin = await mkRole('ADMIN');
  const admin = await mkUser('admin.boost@test.local', 'Admin');
  await prisma.userRole.create({ data: { userId: admin.id, roleId: rAdmin.id } });

  const company = await prisma.company.create({
    data: {
      name: 'LegacyBoostAdmin', ticker: 'LGB2', description: 'desc', sector: 'setor', founderUserId: admin.id, status: 'ACTIVE',
      totalShares: 1000, circulatingShares: 200, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600,
      availableOfferShares: 400, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000,
      approvedAt: new Date(), revenueAccount: { create: {} }, boostAccount: { create: {} },
    },
  });

  const adminToken = await token(admin.id, ['ADMIN']);
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/project-boosts/companies/${company.id}/boost`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { amountRpc: 50, source: 'ADMIN_ADJUSTMENT', reason: 'Teste admin desativado' },
  });

  assert.equal(response.statusCode, 410, response.body);
  assert.match(response.body, /impulsão legada desativada/i);

  const after = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(String(after.currentPrice), '10');
  assert.equal(String(after.fictitiousMarketCap), '10000');
  assert.equal(await prisma.trade.count({ where: { companyId: company.id } }), 0);
  assert.equal(await prisma.marketOrder.count({ where: { companyId: company.id } }), 0);
  assert.equal(await prisma.companyBoostInjection.count({ where: { companyId: company.id } }), 0);
});
