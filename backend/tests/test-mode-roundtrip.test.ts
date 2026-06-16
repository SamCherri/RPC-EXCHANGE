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
const SYSTEM_MODE_ID = 'SYSTEM_MODE_MAIN';
const RPC_MARKET_STATE_ID = 'RPC_MARKET_MAIN';

async function resetDb() {
  await prisma.$transaction([
    prisma.rpcLimitOrder.deleteMany(), prisma.rpcExchangeTrade.deleteMany(), prisma.rpcMarketState.deleteMany(),
    prisma.feeDistribution.deleteMany(), prisma.trade.deleteMany(), prisma.marketOrder.deleteMany(), prisma.companyOperation.deleteMany(),
    prisma.companyHolding.deleteMany(), prisma.companyInitialOffer.deleteMany(), prisma.companyRevenueAccount.deleteMany(), prisma.companyBoostInjection.deleteMany(),
    prisma.companyBoostAccount.deleteMany(), prisma.company.deleteMany(), prisma.coinTransfer.deleteMany(), prisma.coinIssuance.deleteMany(),
    prisma.transaction.deleteMany(), prisma.withdrawalRequest.deleteMany(), prisma.adminLog.deleteMany(), prisma.brokerAccount.deleteMany(),
    prisma.wallet.deleteMany(), prisma.userRole.deleteMany(), prisma.rolePermission.deleteMany(), prisma.permission.deleteMany(), prisma.role.deleteMany(),
    prisma.testModeReport.deleteMany(), prisma.testModeTrade.deleteMany(), prisma.testModeWallet.deleteMany(), prisma.testModeMarketState.deleteMany(),
    prisma.systemModeConfig.deleteMany(), prisma.user.deleteMany(), prisma.platformAccount.deleteMany(), prisma.treasuryAccount.deleteMany(),
  ]);
}

async function mkRole(key: string) { return prisma.role.create({ data: { key, name: key } }); }
async function mkUser(email: string) { return prisma.user.create({ data: { email, discord: email.replace(/[^a-z0-9]/gi, '_').toLowerCase(), gamePhone: `TEST-${email.replace(/[^a-z0-9]/gi, '_').slice(0, 24)}`, name: email, passwordHash: await bcrypt.hash('Admin@123', 10), wallet: { create: {} } } }); }
async function tk(userId: string, roles: string[]) { return app.jwt.sign({ sub: userId, roles }); }

const dec = (v: unknown) => Number(v);
async function enableTestMode() {
  await prisma.systemModeConfig.upsert({
    where: { id: SYSTEM_MODE_ID },
    update: { mode: 'TEST' },
    create: { id: SYSTEM_MODE_ID, mode: 'TEST' },
  });
}
async function ensureRpcMarketState() {
  await prisma.rpcMarketState.upsert({
    where: { id: RPC_MARKET_STATE_ID },
    update: {},
    create: {
      id: RPC_MARKET_STATE_ID,
      currentPrice: 1,
      fiatReserve: 1000000,
      rpcReserve: 1000000,
    },
  });
}

async function estimatedTestPatrimony(userId: string) {
  const [wallet, market] = await Promise.all([
    prisma.testModeWallet.findUniqueOrThrow({ where: { userId } }),
    prisma.testModeMarketState.findUniqueOrThrow({ where: { id: 'TEST_MODE_MARKET_MAIN' } }),
  ]);
  return dec(wallet.fiatBalance) + (dec(wallet.rpcBalance) * dec(market.currentPrice));
}

test.before(async () => { await app.ready(); await resetDb(); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('modo teste: round-trip imediato não gera lucro + quote compatível + leaderboard consistente', async () => {
  await resetDb();
  const role = await mkRole('USER');
  const user = await mkUser('testmode@test.local');
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  await enableTestMode();
  await prisma.testModeWallet.create({ data: { userId: user.id, fiatBalance: 10000, rpcBalance: 0 } });
  await prisma.testModeMarketState.create({ data: { id: 'TEST_MODE_MARKET_MAIN' } });

  const token = await tk(user.id, ['USER']);
  const initial = await estimatedTestPatrimony(user.id);

  const qb = await app.inject({ method: 'GET', url: '/api/test-mode/quote-buy?fiatAmount=1000', headers: { authorization: `Bearer ${token}` } });
  assert.equal(qb.statusCode, 200, qb.body);
  const qbBody = qb.json();
  assert.equal(dec(qbBody.feePercent), 1);

  const buy = await app.inject({ method: 'POST', url: '/api/test-mode/buy', headers: { authorization: `Bearer ${token}` }, payload: { fiatAmount: 1000 } });
  assert.equal(buy.statusCode, 200, buy.body);
  const walletAfterBuy = await prisma.testModeWallet.findUniqueOrThrow({ where: { userId: user.id } });
  assert.ok(Math.abs(dec(walletAfterBuy.rpcBalance) - dec(qbBody.estimatedRpcAmount)) <= 0.02);

  const qs = await app.inject({ method: 'GET', url: `/api/test-mode/quote-sell?rpcAmount=${walletAfterBuy.rpcBalance}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(qs.statusCode, 200, qs.body);

  const sell = await app.inject({ method: 'POST', url: '/api/test-mode/sell', headers: { authorization: `Bearer ${token}` }, payload: { rpcAmount: dec(walletAfterBuy.rpcBalance) } });
  assert.equal(sell.statusCode, 200, sell.body);
  const final = await estimatedTestPatrimony(user.id);
  assert.ok(final <= initial + 0.000001, `final=${final} initial=${initial}`);

  const lb = await app.inject({ method: 'GET', url: '/api/test-mode/leaderboard', headers: { authorization: `Bearer ${token}` } });
  assert.equal(lb.statusCode, 200, lb.body);
  const me = lb.json().leaderboard.find((row: { userId: string }) => row.userId === user.id);
  assert.ok(me);
  assert.ok(dec(me.estimatedTotalFiat) <= initial + 0.000001);
});

test('modo teste: 10 ciclos buy/sell não geram lucro', async () => {
  await resetDb();
  const role = await mkRole('USER');
  const user = await mkUser('cycles@test.local');
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  await enableTestMode();
  await prisma.testModeWallet.create({ data: { userId: user.id, fiatBalance: 10000, rpcBalance: 0 } });
  await prisma.testModeMarketState.create({ data: { id: 'TEST_MODE_MARKET_MAIN' } });
  const token = await tk(user.id, ['USER']);
  const initial = await estimatedTestPatrimony(user.id);

  for (let i = 0; i < 10; i += 1) {
    const buy = await app.inject({ method: 'POST', url: '/api/test-mode/buy', headers: { authorization: `Bearer ${token}` }, payload: { fiatAmount: 500 } });
    assert.equal(buy.statusCode, 200, buy.body);
    const w = await prisma.testModeWallet.findUniqueOrThrow({ where: { userId: user.id } });
    const sell = await app.inject({ method: 'POST', url: '/api/test-mode/sell', headers: { authorization: `Bearer ${token}` }, payload: { rpcAmount: dec(w.rpcBalance) } });
    assert.equal(sell.statusCode, 200, sell.body);
  }

  const final = await estimatedTestPatrimony(user.id);
  assert.ok(final <= initial + 0.000001, `final=${final} initial=${initial}`);
});

test('rpc/r$: round-trip imediato e 5 ciclos não geram lucro', async () => {
  await resetDb();
  const role = await mkRole('USER');
  const user = await mkUser('rpc@test.local');
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  await prisma.wallet.update({ where: { userId: user.id }, data: { fiatAvailableBalance: 10000, rpcAvailableBalance: 0 } });
  await ensureRpcMarketState();
  const token = await tk(user.id, ['USER']);

  const getP = async () => {
    const [w, m] = await Promise.all([
      prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } }),
      prisma.rpcMarketState.findUniqueOrThrow({ where: { id: RPC_MARKET_STATE_ID } }),
    ]);
    return dec(w.fiatAvailableBalance) + dec(w.rpcAvailableBalance) * dec(m.currentPrice);
  };

  const initial = await getP();
  let buy = await app.inject({ method: 'POST', url: '/api/rpc-market/buy', headers: { authorization: `Bearer ${token}` }, payload: { fiatAmount: 1000 } });
  assert.equal(buy.statusCode, 200, buy.body);
  let w = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
  let sell = await app.inject({ method: 'POST', url: '/api/rpc-market/sell', headers: { authorization: `Bearer ${token}` }, payload: { rpcAmount: dec(w.rpcAvailableBalance) } });
  assert.equal(sell.statusCode, 200, sell.body);

  for (let i = 0; i < 5; i += 1) {
    buy = await app.inject({ method: 'POST', url: '/api/rpc-market/buy', headers: { authorization: `Bearer ${token}` }, payload: { fiatAmount: 700 } });
    assert.equal(buy.statusCode, 200, buy.body);
    w = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
    sell = await app.inject({ method: 'POST', url: '/api/rpc-market/sell', headers: { authorization: `Bearer ${token}` }, payload: { rpcAmount: dec(w.rpcAvailableBalance) } });
    assert.equal(sell.statusCode, 200, sell.body);
  }

  w = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
  const final = await getP();
  assert.ok(final <= initial + 0.000001, `final=${final} initial=${initial}`);
  assert.ok(dec(w.rpcAvailableBalance) <= 0.01);
});

test('mercado empresas: bloqueia self-trade e sem contraparte mercado falha; cancelamento preserva saldo', async () => {
  await resetDb();
  const role = await mkRole('USER');
  const u1 = await mkUser('u1@test.local');
  const u2 = await mkUser('u2@test.local');
  await prisma.userRole.createMany({ data: [{ userId: u1.id, roleId: role.id }, { userId: u2.id, roleId: role.id }] });
  await prisma.platformAccount.create({ data: {} });
  await prisma.wallet.update({ where: { userId: u1.id }, data: { rpcAvailableBalance: 5000 } });
  await prisma.wallet.update({ where: { userId: u2.id }, data: { rpcAvailableBalance: 5000 } });
  const company = await prisma.company.create({ data: { name: 'Self Check', ticker: 'SELF1', description: 'd', sector: 's', founderUserId: u1.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 500, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(), revenueAccount: { create: {} } } });
  await prisma.companyHolding.create({ data: { userId: u1.id, companyId: company.id, shares: 50, averageBuyPrice: 10, estimatedValue: 500 } });
  const tk1 = await tk(u1.id, ['USER']);
  const tk2 = await tk(u2.id, ['USER']);

  const ownSell = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${tk1}` }, payload: { companyId: company.id, type: 'SELL', mode: 'LIMIT', quantity: 10, limitPrice: 10 } });
  assert.equal(ownSell.statusCode, 201, ownSell.body);
  const selfMarketBuy = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${tk1}` }, payload: { companyId: company.id, type: 'BUY', mode: 'MARKET', quantity: 5 } });
  assert.equal(selfMarketBuy.statusCode, 400, selfMarketBuy.body);

  const marketNoOpposite = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${tk2}` }, payload: { companyId: company.id, type: 'BUY', mode: 'MARKET', quantity: 5 } });
  assert.equal(marketNoOpposite.statusCode, 400, marketNoOpposite.body);

  const cashBefore = await prisma.wallet.findUniqueOrThrow({ where: { userId: u1.id } });
  const sellOrderId = ownSell.json().order.id as string;
  const cancel = await app.inject({ method: 'POST', url: `/api/market/orders/${sellOrderId}/cancel`, headers: { authorization: `Bearer ${tk1}` } });
  assert.equal(cancel.statusCode, 200, cancel.body);
  const cashAfter = await prisma.wallet.findUniqueOrThrow({ where: { userId: u1.id } });
  assert.equal(dec(cashBefore.rpcAvailableBalance), dec(cashAfter.rpcAvailableBalance));
});
