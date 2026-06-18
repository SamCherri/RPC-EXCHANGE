import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { resetTestDatabase } from './helpers/reset-test-db.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();
const PASSWORD = 'Admin@123';

async function resetDb() {
  await resetTestDatabase(prisma);
}

async function mkRole(key: string) {
  return prisma.role.create({ data: { key, name: key } });
}

async function grantFinancialPermissions(userId: string) {
  await prisma.userFinancialPermission.createMany({
    data: (['RPC_MARKET_TRADE', 'COMPANY_MARKET_TRADE', 'PROJECT_CREATE', 'WITHDRAWAL_REQUEST', 'BROKER_TRANSFER'] as const).map((permission) => ({
      userId,
      permission,
      grantedById: userId,
      reason: 'Permissão financeira em fixture de teste',
    })),
    skipDuplicates: true,
  });
}

async function mkUser(email: string, roles: { id: string; key: string }[], balances?: { fiat?: number; rpc?: number }) {
  const user = await prisma.user.create({
    data: {
      email,
      name: email.split('@')[0],
      approvalStatus: 'APPROVED',
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      wallet: { create: { fiatAvailableBalance: balances?.fiat ?? 0, rpcAvailableBalance: balances?.rpc ?? 0 } },
    },
  });
  await grantFinancialPermissions(user.id);
  await prisma.userRole.createMany({ data: roles.map((role) => ({ userId: user.id, roleId: role.id })) });
  return user;
}

async function auth(userId: string, roles: string[] = ['USER']) {
  return app.jwt.sign({ sub: userId, roles });
}

async function createActiveCompany(founderUserId: string, ticker = 'REAL1') {
  return prisma.company.create({
    data: {
      name: `Projeto ${ticker}`,
      ticker,
      description: 'Projeto de teste econômico real',
      sector: 'Tecnologia',
      founderUserId,
      status: 'ACTIVE',
      totalShares: 1000,
      circulatingShares: 100,
      ownerSharePercent: 40,
      publicOfferPercent: 60,
      ownerShares: 400,
      publicOfferShares: 600,
      availableOfferShares: 500,
      initialPrice: 10,
      currentPrice: 10,
      buyFeePercent: 1,
      sellFeePercent: 1,
      fictitiousMarketCap: 10000,
      approvedAt: new Date(),
      revenueAccount: { create: {} },
    },
  });
}

const num = (value: unknown) => Number(value ?? 0);

async function walletOf(userId: string) {
  return prisma.wallet.findUniqueOrThrow({ where: { userId } });
}

test.before(async () => { await app.ready(); await resetDb(); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('round-trip RPC/R$ não gera lucro artificial', async () => {
  await resetDb();
  const userRole = await mkRole('USER');
  await prisma.platformAccount.create({ data: {} });
  const user = await mkUser('roundtrip@test.local', [userRole], { fiat: 1000 });
  const token = await auth(user.id);

  const before = await walletOf(user.id);
  const buy = await app.inject({ method: 'POST', url: '/api/rpc-market/buy', headers: { authorization: `Bearer ${token}` }, payload: { fiatAmount: 100 } });
  assert.equal(buy.statusCode, 200, buy.body);
  const boughtRpc = num(buy.json().rpcAmount);
  assert.ok(boughtRpc > 0);

  const sell = await app.inject({ method: 'POST', url: '/api/rpc-market/sell', headers: { authorization: `Bearer ${token}` }, payload: { rpcAmount: boughtRpc } });
  assert.equal(sell.statusCode, 200, sell.body);

  const after = await walletOf(user.id);
  assert.ok(num(after.fiatAvailableBalance) <= num(before.fiatAvailableBalance));
  assert.ok(num(after.fiatAvailableBalance) >= 0);
  assert.ok(num(after.rpcAvailableBalance) >= 0);
});

test('múltiplos ciclos RPC/R$ não geram lucro artificial', async () => {
  await resetDb();
  const userRole = await mkRole('USER');
  await prisma.platformAccount.create({ data: {} });
  const user = await mkUser('multi-cycle@test.local', [userRole], { fiat: 1000 });
  const token = await auth(user.id);
  const initial = await walletOf(user.id);

  for (let i = 0; i < 5; i += 1) {
    const buy = await app.inject({ method: 'POST', url: '/api/rpc-market/buy', headers: { authorization: `Bearer ${token}` }, payload: { fiatAmount: 50 } });
    assert.equal(buy.statusCode, 200, buy.body);
    const boughtRpc = num(buy.json().rpcAmount);
    const sell = await app.inject({ method: 'POST', url: '/api/rpc-market/sell', headers: { authorization: `Bearer ${token}` }, payload: { rpcAmount: boughtRpc } });
    assert.equal(sell.statusCode, 200, sell.body);
  }

  const finalWallet = await walletOf(user.id);
  assert.ok(num(finalWallet.fiatAvailableBalance) <= num(initial.fiatAvailableBalance));
  assert.ok(num(finalWallet.fiatAvailableBalance) >= 0);
  assert.ok(num(finalWallet.rpcAvailableBalance) >= 0);
});

test('mercado de empresas bloqueia self-trade e operação sem contraparte', async () => {
  await resetDb();
  const userRole = await mkRole('USER');
  const founder = await mkUser('founder-real@test.local', [userRole], { rpc: 0 });
  const trader = await mkUser('self-trader@test.local', [userRole], { rpc: 1000 });
  const company = await createActiveCompany(founder.id, 'SELF1');
  await prisma.companyHolding.create({ data: { userId: trader.id, companyId: company.id, shares: 100, averageBuyPrice: 10, estimatedValue: 1000 } });
  const traderToken = await auth(trader.id);

  const noCounterpartyWalletBefore = await walletOf(trader.id);
  const marketWithoutCounterparty = await app.inject({ method: 'POST', url: `/api/market/companies/${company.id}/buy-market`, headers: { authorization: `Bearer ${traderToken}` }, payload: { quantity: 1, slippagePercent: 5 } });
  assert.equal(marketWithoutCounterparty.statusCode, 400, marketWithoutCounterparty.body);
  assert.match(marketWithoutCounterparty.body, /Livro sem liquidez/);
  assert.equal(await prisma.trade.count({ where: { companyId: company.id } }), 0);
  const noCounterpartyWalletAfter = await walletOf(trader.id);
  assert.equal(String(noCounterpartyWalletAfter.rpcAvailableBalance), String(noCounterpartyWalletBefore.rpcAvailableBalance));

  const sell = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${traderToken}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 10, limitPrice: 10 } });
  assert.equal(sell.statusCode, 201, sell.body);
  const buy = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${traderToken}` }, payload: { companyId: company.id, type: 'BUY', mode: 'LIMIT', quantity: 10, limitPrice: 10 } });
  assert.equal(buy.statusCode, 201, buy.body);

  assert.equal(await prisma.trade.count({ where: { companyId: company.id } }), 0);
  const orders = await prisma.marketOrder.findMany({ where: { companyId: company.id, userId: trader.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(orders.length, 2);
  assert.ok(orders.every((order) => order.status === 'OPEN'));
});

test('cancelamento preserva saldo e holdings no mercado de empresas', async () => {
  await resetDb();
  const userRole = await mkRole('USER');
  const founder = await mkUser('founder-cancel@test.local', [userRole]);
  const buyer = await mkUser('buyer-cancel@test.local', [userRole], { rpc: 500 });
  const seller = await mkUser('seller-cancel@test.local', [userRole], { rpc: 0 });
  const company = await createActiveCompany(founder.id, 'CANC1');
  await prisma.companyHolding.create({ data: { userId: seller.id, companyId: company.id, shares: 50, averageBuyPrice: 10, estimatedValue: 500 } });
  const buyerToken = await auth(buyer.id);
  const sellerToken = await auth(seller.id);

  const buyerBefore = await walletOf(buyer.id);
  const buyOrder = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${buyerToken}` }, payload: { companyId: company.id, type: 'BUY', mode: 'LIMIT', quantity: 10, limitPrice: 10 } });
  assert.equal(buyOrder.statusCode, 201, buyOrder.body);
  const buyOrderId = buyOrder.json().order.id as string;
  const buyerLocked = await walletOf(buyer.id);
  assert.ok(num(buyerLocked.rpcAvailableBalance) < num(buyerBefore.rpcAvailableBalance));
  assert.ok(num(buyerLocked.rpcLockedBalance) > 0);

  const cancelBuy = await app.inject({ method: 'POST', url: `/api/market/orders/${buyOrderId}/cancel`, headers: { authorization: `Bearer ${buyerToken}` } });
  assert.equal(cancelBuy.statusCode, 200, cancelBuy.body);
  const buyerAfter = await walletOf(buyer.id);
  assert.equal(String(buyerAfter.rpcAvailableBalance), String(buyerBefore.rpcAvailableBalance));
  assert.equal(num(buyerAfter.rpcLockedBalance), 0);

  const holdingBefore = await prisma.companyHolding.findUniqueOrThrow({ where: { userId_companyId: { userId: seller.id, companyId: company.id } } });
  const sellOrder = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${sellerToken}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 10, limitPrice: 10 } });
  assert.equal(sellOrder.statusCode, 201, sellOrder.body);
  const sellOrderId = sellOrder.json().order.id as string;
  const holdingLocked = await prisma.companyHolding.findUniqueOrThrow({ where: { userId_companyId: { userId: seller.id, companyId: company.id } } });
  assert.equal(holdingLocked.shares, holdingBefore.shares - 10);

  const cancelSell = await app.inject({ method: 'POST', url: `/api/market/orders/${sellOrderId}/cancel`, headers: { authorization: `Bearer ${sellerToken}` } });
  assert.equal(cancelSell.statusCode, 200, cancelSell.body);
  const holdingAfter = await prisma.companyHolding.findUniqueOrThrow({ where: { userId_companyId: { userId: seller.id, companyId: company.id } } });
  assert.equal(holdingAfter.shares, holdingBefore.shares);
});
