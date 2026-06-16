import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

if (process.env.NODE_ENV === 'production') throw new Error('Simulação não pode rodar em produção.');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para simulação.');
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
    prisma.rpcLimitOrder.deleteMany(), prisma.rpcExchangeTrade.deleteMany(), prisma.rpcMarketState.deleteMany(),
    prisma.feeDistribution.deleteMany(), prisma.trade.deleteMany(), prisma.marketOrder.deleteMany(), prisma.companyOperation.deleteMany(),
    prisma.companyHolding.deleteMany(), prisma.companyInitialOffer.deleteMany(), prisma.companyRevenueAccount.deleteMany(), prisma.companyBoostInjection.deleteMany(),
    prisma.companyBoostAccount.deleteMany(), prisma.company.deleteMany(), prisma.coinTransfer.deleteMany(), prisma.coinIssuance.deleteMany(),
    prisma.transaction.deleteMany(), prisma.withdrawalRequest.deleteMany(), prisma.adminLog.deleteMany(), prisma.brokerAccount.deleteMany(),
    prisma.wallet.deleteMany(), prisma.userRole.deleteMany(), prisma.rolePermission.deleteMany(), prisma.permission.deleteMany(), prisma.role.deleteMany(),
    prisma.testModeReport.deleteMany(), prisma.testModeTrade.deleteMany(), prisma.testModeWallet.deleteMany(), prisma.testModeMarketState.deleteMany(),
    prisma.user.deleteMany(), prisma.platformAccount.deleteMany(), prisma.treasuryAccount.deleteMany(),
  ]);
}

async function mkRole(key: string) {
  return prisma.role.create({ data: { key, name: key } });
}
async function mkUser(email: string, roles: { id: string; key: string }[], balances?: { fiat?: number; rpc?: number }) {
  const user = await prisma.user.create({ data: { email, discord: email.replace(/[^a-z0-9]/gi, '_').toLowerCase(), gamePhone: `TEST-${email.replace(/[^a-z0-9]/gi, '_').slice(0, 24)}`, name: email.split('@')[0], passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10), wallet: { create: {} } } });
  await prisma.userRole.createMany({ data: roles.map((r) => ({ userId: user.id, roleId: r.id })) });
  if (balances?.fiat || balances?.rpc) {
    await prisma.wallet.update({
      where: { userId: user.id },
      data: { fiatAvailableBalance: balances.fiat ?? undefined, rpcAvailableBalance: balances.rpc ?? undefined },
    });
  }
  return user;
}
async function tk(userId: string, roles: string[]) {
  return app.jwt.sign({ sub: userId, roles });
}

const dec = (v: unknown) => Number(v);

test.before(async () => {
  await app.ready();
  await resetDb();
});

test.after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('simulação segura de fluxos críticos RPC/R$', async () => {
  await resetDb();

  const userRole = await mkRole('USER');
  const adminRole = await mkRole('ADMIN');
  const superRole = await mkRole('SUPER_ADMIN');
  const chiefRole = await mkRole('COIN_CHIEF_ADMIN');

  await prisma.platformAccount.create({ data: { balance: 0, totalReceivedFees: 0, totalWithdrawn: 0 } });

  const marketBefore = await prisma.rpcMarketState.findFirst();
  const tradeCountBefore = await prisma.rpcExchangeTrade.count();

  const buyer = await mkUser('buyer.sim@test.local', [userRole], { fiat: 200 });
  const buyerToken = await tk(buyer.id, ['USER']);
  const buy = await app.inject({ method: 'POST', url: '/api/rpc-market/buy', headers: { authorization: `Bearer ${buyerToken}` }, payload: { fiatAmount: 100 } });
  assert.equal(buy.statusCode, 200, buy.body);
  const buyBody = buy.json();
  assert.equal(dec(buyBody.feePercent), 1);
  assert.equal(dec(buyBody.grossFiatAmount), 100);
  assert.equal(dec(buyBody.feeAmount), 1);
  assert.equal(dec(buyBody.netFiatAmount), 99);
  assert.ok(dec(buyBody.rpcAmount) > 0);
  
  const buyerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
  assert.equal(dec(buyerWallet.fiatAvailableBalance), 100);
  assert.ok(dec(buyerWallet.rpcAvailableBalance) > 0);

  const platformAfterBuy = await prisma.platformAccount.findFirstOrThrow();
  assert.equal(dec(platformAfterBuy.balance), 1);
  assert.equal(dec(platformAfterBuy.totalReceivedFees), 1);

  const seller = await mkUser('seller.sim@test.local', [userRole], { rpc: 100 });
  const sellerToken = await tk(seller.id, ['USER']);
  const sell = await app.inject({ method: 'POST', url: '/api/rpc-market/sell', headers: { authorization: `Bearer ${sellerToken}` }, payload: { rpcAmount: 10 } });
  assert.equal(sell.statusCode, 200, sell.body);
  const sellBody = sell.json();
  assert.equal(dec(sellBody.feePercent), 1);
  assert.ok(dec(sellBody.grossFiatAmount) > 0);
  assert.equal(dec(sellBody.netFiatAmount), dec(sellBody.grossFiatAmount) - dec(sellBody.feeAmount));
  

  const tradesAfterBuySell = await prisma.rpcExchangeTrade.findMany();
  for (const trade of tradesAfterBuySell) {
    assert.equal(dec(trade.unitPrice).toFixed(8), (dec(trade.fiatAmount) / dec(trade.rpcAmount)).toFixed(8));
  }

  const sellerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: seller.id } });
  assert.equal(dec(sellerWallet.rpcAvailableBalance), 90);
  assert.equal(dec(sellerWallet.fiatAvailableBalance), dec(sellBody.netFiatAmount));

  const limitBuyer = await mkUser('limit.buyer@test.local', [userRole], { fiat: 300 });
  const limitSeller = await mkUser('limit.seller@test.local', [userRole], { rpc: 120 });
  const chiefAdmin = await mkUser('chief.sim@test.local', [chiefRole], { fiat: 0 });

  const limitBuyerTk = await tk(limitBuyer.id, ['USER']);
  const limitSellerTk = await tk(limitSeller.id, ['USER']);
  const chiefTk = await tk(chiefAdmin.id, ['COIN_CHIEF_ADMIN']);

  const buyOrderResp = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${limitBuyerTk}` }, payload: { side: 'BUY_RPC', fiatAmount: 100, limitPrice: 2 } });
  assert.equal(buyOrderResp.statusCode, 201, buyOrderResp.body);
  const buyOrderId = buyOrderResp.json().order.id;

  let buyOrder = await prisma.rpcLimitOrder.findUniqueOrThrow({ where: { id: buyOrderId } });
  assert.equal(buyOrder.status, 'OPEN');
  let wBuy = await prisma.wallet.findUniqueOrThrow({ where: { userId: limitBuyer.id } });
  assert.equal(dec(wBuy.fiatAvailableBalance), 200);
  assert.equal(dec(wBuy.fiatLockedBalance), 100);

  const sellOrderResp = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${limitSellerTk}` }, payload: { side: 'SELL_RPC', rpcAmount: 40, limitPrice: 0.5 } });
  assert.equal(sellOrderResp.statusCode, 201, sellOrderResp.body);
  const sellOrderId = sellOrderResp.json().order.id;

  let sellOrder = await prisma.rpcLimitOrder.findUniqueOrThrow({ where: { id: sellOrderId } });
  assert.equal(sellOrder.status, 'OPEN');
  let wSell = await prisma.wallet.findUniqueOrThrow({ where: { userId: limitSeller.id } });
  assert.equal(dec(wSell.rpcAvailableBalance), 80);
  assert.equal(dec(wSell.rpcLockedBalance), 40);

  const process = await app.inject({ method: 'POST', url: '/api/admin/rpc-market/orders/process', headers: { authorization: `Bearer ${chiefTk}` }, payload: { maxOrders: 20 } });
  assert.equal(process.statusCode, 200, process.body);

  buyOrder = await prisma.rpcLimitOrder.findUniqueOrThrow({ where: { id: buyOrderId } });
  sellOrder = await prisma.rpcLimitOrder.findUniqueOrThrow({ where: { id: sellOrderId } });
  assert.equal(buyOrder.status, 'FILLED');
  assert.equal(sellOrder.status, 'FILLED');

  wBuy = await prisma.wallet.findUniqueOrThrow({ where: { userId: limitBuyer.id } });
  wSell = await prisma.wallet.findUniqueOrThrow({ where: { userId: limitSeller.id } });
  assert.equal(dec(wBuy.fiatLockedBalance), 0);
  assert.ok(dec(wBuy.rpcAvailableBalance) > 0);
  assert.equal(dec(wSell.rpcLockedBalance), 0);
  assert.ok(dec(wSell.fiatAvailableBalance) > 0);

  const cancelBuyer = await mkUser('cancel.buyer@test.local', [userRole], { fiat: 150 });
  const cancelSeller = await mkUser('cancel.seller@test.local', [userRole], { rpc: 50 });
  const cancelBuyerTk = await tk(cancelBuyer.id, ['USER']);
  const cancelSellerTk = await tk(cancelSeller.id, ['USER']);

  const buyCancelOrder = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${cancelBuyerTk}` }, payload: { side: 'BUY_RPC', fiatAmount: 80, limitPrice: 0.1 } });
  const buyCancelId = buyCancelOrder.json().order.id;
  const cancelBuy = await app.inject({ method: 'POST', url: `/api/rpc-market/orders/${buyCancelId}/cancel`, headers: { authorization: `Bearer ${cancelBuyerTk}` } });
  assert.equal(cancelBuy.statusCode, 200, cancelBuy.body);
  const cancelBuyerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: cancelBuyer.id } });
  assert.equal(dec(cancelBuyerWallet.fiatAvailableBalance), 150);

  const sellCancelOrder = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${cancelSellerTk}` }, payload: { side: 'SELL_RPC', rpcAmount: 20, limitPrice: 999 } });
  const sellCancelId = sellCancelOrder.json().order.id;
  const cancelSell = await app.inject({ method: 'POST', url: `/api/rpc-market/orders/${sellCancelId}/cancel`, headers: { authorization: `Bearer ${cancelSellerTk}` } });
  assert.equal(cancelSell.statusCode, 200, cancelSell.body);
  const cancelSellerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: cancelSeller.id } });
  assert.equal(dec(cancelSellerWallet.rpcAvailableBalance), 50);

  const cancelFilled = await app.inject({ method: 'POST', url: `/api/rpc-market/orders/${buyOrderId}/cancel`, headers: { authorization: `Bearer ${limitBuyerTk}` } });
  assert.equal(cancelFilled.statusCode, 400, cancelFilled.body);

  const superAdmin = await mkUser('super.sim@test.local', [superRole], { fiat: 0 });
  const adminTarget = await mkUser('admin.target@test.local', [adminRole], { fiat: 0 });
  const superTk = await tk(superAdmin.id, ['SUPER_ADMIN']);

  const marketStateBeforeWithdrawProfit = await prisma.rpcMarketState.findMany();
  const tradeCountBeforeWithdrawProfit = await prisma.rpcExchangeTrade.count();
  const platformBeforeWithdraw = await prisma.platformAccount.findFirstOrThrow();

  const withdrawProfit = await app.inject({ method: 'POST', url: '/api/admin/platform-account/withdraw-to-admin', headers: { authorization: `Bearer ${superTk}` }, payload: { adminId: adminTarget.id, amount: 2, reason: 'simulação retirada de lucro segura', adminPassword: ADMIN_PASSWORD } });
  assert.equal(withdrawProfit.statusCode, 201, withdrawProfit.body);

  const platformAfterWithdraw = await prisma.platformAccount.findFirstOrThrow();
  assert.equal(dec(platformAfterWithdraw.balance), dec(platformBeforeWithdraw.balance) - 2);
  assert.equal(dec(platformAfterWithdraw.totalWithdrawn), dec(platformBeforeWithdraw.totalWithdrawn) + 2);

  const adminTargetWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: adminTarget.id } });
  assert.equal(dec(adminTargetWallet.fiatAvailableBalance), 2);
  assert.equal(await prisma.rpcExchangeTrade.count(), tradeCountBeforeWithdrawProfit);
  const marketStateAfterWithdrawProfit = await prisma.rpcMarketState.findMany();
  assert.deepEqual(marketStateAfterWithdrawProfit.map((m) => ({ id: m.id, price: String(m.currentPrice) })), marketStateBeforeWithdrawProfit.map((m) => ({ id: m.id, price: String(m.currentPrice) })));

  const adminTargetTk = await tk(adminTarget.id, ['ADMIN']);
  const withdrawalRequest = await app.inject({ method: 'POST', url: '/api/withdrawals', headers: { authorization: `Bearer ${adminTargetTk}` }, payload: { amount: 1 } });
  assert.equal(withdrawalRequest.statusCode, 201, withdrawalRequest.body);
  const withdrawalId = withdrawalRequest.json().id as string;

  let adminTargetWalletAfterReq = await prisma.wallet.findUniqueOrThrow({ where: { userId: adminTarget.id } });
  assert.equal(dec(adminTargetWalletAfterReq.fiatAvailableBalance), 1);
  assert.equal(dec(adminTargetWalletAfterReq.fiatPendingWithdrawalBalance), 1);

  const reqDb = await prisma.withdrawalRequest.findUniqueOrThrow({ where: { id: withdrawalId } });
  assert.equal(reqDb.status, 'PENDING');

  const selfComplete = await app.inject({ method: 'POST', url: `/api/admin/withdrawals/${withdrawalId}/complete`, headers: { authorization: `Bearer ${adminTargetTk}` }, payload: { adminNote: 'autoaprovação' } });
  assert.equal(selfComplete.statusCode, 403, selfComplete.body);

  const adminOther = await mkUser('admin.other@test.local', [adminRole], { fiat: 0 });
  const adminOtherTk = await tk(adminOther.id, ['ADMIN']);
  const marketBeforeComplete = await prisma.rpcMarketState.findMany();
  const tradeBeforeComplete = await prisma.rpcExchangeTrade.count();

  const complete = await app.inject({ method: 'POST', url: `/api/admin/withdrawals/${withdrawalId}/complete`, headers: { authorization: `Bearer ${adminOtherTk}` }, payload: { adminNote: 'ok' } });
  assert.equal(complete.statusCode, 200, complete.body);

  const completed = await prisma.withdrawalRequest.findUniqueOrThrow({ where: { id: withdrawalId } });
  assert.equal(completed.status, 'COMPLETED');
  adminTargetWalletAfterReq = await prisma.wallet.findUniqueOrThrow({ where: { userId: adminTarget.id } });
  assert.equal(dec(adminTargetWalletAfterReq.fiatPendingWithdrawalBalance), 0);
  assert.equal(await prisma.rpcExchangeTrade.count(), tradeBeforeComplete);

  const marketAfterComplete = await prisma.rpcMarketState.findMany();
  assert.deepEqual(marketAfterComplete.map((m) => ({ id: m.id, price: String(m.currentPrice) })), marketBeforeComplete.map((m) => ({ id: m.id, price: String(m.currentPrice) })));

  const wallets = await prisma.wallet.findMany();
  assert.ok(wallets.every((w) => dec(w.fiatAvailableBalance) >= 0));
  assert.ok(wallets.every((w) => dec(w.rpcAvailableBalance) >= 0));
  assert.ok(wallets.every((w) => dec(w.fiatLockedBalance) >= 0));
  assert.ok(wallets.every((w) => dec(w.rpcLockedBalance) >= 0));

  const openOrders = await prisma.rpcLimitOrder.findMany({ where: { status: 'OPEN' } });
  assert.ok(openOrders.every((o) => dec(o.lockedFiatAmount) > 0 || dec(o.lockedRpcAmount) > 0));

  const platformEnd = await prisma.platformAccount.findFirstOrThrow();
  assert.ok(dec(platformEnd.balance) >= 0);

  const marketStates = await prisma.rpcMarketState.findMany();
  assert.equal(marketStates.length, 1);

  const trades = await prisma.rpcExchangeTrade.findMany();
  assert.ok(trades.length > tradeCountBefore);
  assert.ok(trades.every((t) => dec(t.rpcAmount) > 0));
  for (const trade of trades) {
    assert.equal(dec(trade.unitPrice).toFixed(8), (dec(trade.fiatAmount) / dec(trade.rpcAmount)).toFixed(8));
  }

  assert.ok((await prisma.rpcMarketState.count()) >= (marketBefore ? 1 : 1));
});
