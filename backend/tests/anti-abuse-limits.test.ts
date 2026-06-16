import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { Decimal } from '@prisma/client/runtime/library';
import { COMPANY_MARKET_MAX_OPEN_ORDERS_PER_USER, MAX_PENDING_WITHDRAWALS_PER_USER, MAX_PROJECT_CREATIONS_PER_DAY, MAX_REPORTS_PER_HOUR, RPC_MARKET_MAX_OPEN_ORDERS_PER_USER } from '../src/config/anti-abuse-limits.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();

async function resetDb() {
  await prisma.$transaction([
    prisma.trade.deleteMany(), prisma.marketOrder.deleteMany(), prisma.rpcLimitOrder.deleteMany(), prisma.rpcExchangeTrade.deleteMany(), prisma.withdrawalRequest.deleteMany(),
    prisma.testModeReport.deleteMany(), prisma.companyOperation.deleteMany(), prisma.companyHolding.deleteMany(), prisma.companyInitialOffer.deleteMany(), prisma.companyRevenueAccount.deleteMany(), prisma.companyBoostInjection.deleteMany(), prisma.companyBoostAccount.deleteMany(), prisma.company.deleteMany(),
    prisma.transaction.deleteMany(), prisma.wallet.deleteMany(), prisma.userFinancialPermission.deleteMany(),
    prisma.userRole.deleteMany(), prisma.rolePermission.deleteMany(), prisma.permission.deleteMany(), prisma.role.deleteMany(), prisma.user.deleteMany(), prisma.platformAccount.deleteMany(), prisma.treasuryAccount.deleteMany(), prisma.testModeTrade.deleteMany(), prisma.testModeWallet.deleteMany(), prisma.testModeMarketState.deleteMany(), prisma.systemModeConfig.deleteMany(),
  ]);
}

async function mkUser(email: string) {
  const user = await prisma.user.create({ data: { email, name: email, approvalStatus: 'APPROVED', passwordHash: await bcrypt.hash('123456', 10), wallet: { create: { fiatAvailableBalance: 10000, rpcAvailableBalance: 10000 } } } });
  await grantTestFinancialPermissions(user.id);
  return user;
}

async function token(userId: string, roles: string[] = ['USER']) { return app.jwt.sign({ sub: userId, roles }); }

async function mkCompany(ownerId: string, ticker: string) {
  return prisma.company.create({ data: { name: ticker, ticker, description: 'desc', sector: 'setor', founderUserId: ownerId, status: 'ACTIVE', totalShares: 1000, circulatingShares: 100, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 500, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(), revenueAccount: { create: {} } } });
}

async function grantTestFinancialPermissions(userId: string) {
  await prisma.userFinancialPermission.createMany({ data: ['RPC_MARKET_TRADE', 'COMPANY_MARKET_TRADE', 'PROJECT_CREATE', 'WITHDRAWAL_REQUEST', 'BROKER_TRANSFER'] as const.map((permission) => ({ userId, permission, grantedById: userId, reason: 'Permissão financeira em fixture de teste' })), skipDuplicates: true });
}

test.before(async () => { await app.ready(); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('1) bloqueia nova ordem RPC/R$ quando usuário já está no limite OPEN', async () => {
  await resetDb();
  const user = await mkUser('rpc-limit@test.local');
  const tk = await token(user.id);
  await prisma.rpcLimitOrder.createMany({ data: Array.from({ length: RPC_MARKET_MAX_OPEN_ORDERS_PER_USER }, () => ({ userId: user.id, side: 'BUY_RPC', status: 'OPEN', limitPrice: new Decimal(1), fiatAmount: new Decimal(1), lockedFiatAmount: new Decimal(1), lockedRpcAmount: new Decimal(0) })) });
  const res = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${tk}` }, payload: { side: 'BUY_RPC', fiatAmount: 1, limitPrice: 1 } });
  assert.equal(res.statusCode, 429);
});

test('2) permite cancelar ordem RPC/R$ mesmo no limite de ordens abertas', async () => {
  await resetDb();
  const user = await mkUser('rpc-cancel@test.local');
  const tk = await token(user.id);
  const orders = await Promise.all(Array.from({ length: RPC_MARKET_MAX_OPEN_ORDERS_PER_USER }, () => prisma.rpcLimitOrder.create({ data: { userId: user.id, side: 'BUY_RPC', status: 'OPEN', limitPrice: new Decimal(1), fiatAmount: new Decimal(1), lockedFiatAmount: new Decimal(1), lockedRpcAmount: new Decimal(0) } })));
  await prisma.wallet.update({ where: { userId: user.id }, data: { fiatAvailableBalance: new Decimal(10000 - RPC_MARKET_MAX_OPEN_ORDERS_PER_USER), fiatLockedBalance: new Decimal(RPC_MARKET_MAX_OPEN_ORDERS_PER_USER) } });
  const res = await app.inject({ method: 'POST', url: `/api/rpc-market/orders/${orders[0].id}/cancel`, headers: { authorization: `Bearer ${tk}` } });
  assert.equal(res.statusCode, 200, res.body);
});

test('3) bloqueia nova ordem de empresa no limite OPEN/PARTIALLY_FILLED', async () => {
  await resetDb();
  const user = await mkUser('market-limit@test.local');
  const tk = await token(user.id);
  const company = await mkCompany(user.id, 'MKT01');
  await prisma.marketOrder.createMany({ data: Array.from({ length: COMPANY_MARKET_MAX_OPEN_ORDERS_PER_USER }, (_, i) => ({ companyId: company.id, userId: user.id, type: i % 2 ? 'BUY' : 'SELL', mode: 'LIMIT', status: i % 2 ? 'OPEN' : 'PARTIALLY_FILLED', quantity: 1, remainingQuantity: 1, limitPrice: new Decimal(10), lockedCash: new Decimal(0), lockedShares: 0 })) });
  const res = await app.inject({ method: 'POST', url: '/api/market/orders', headers: { authorization: `Bearer ${tk}` }, payload: { companyId: company.id, type: 'BUY', mode: 'LIMIT', quantity: 1, limitPrice: 10 } });
  assert.equal(res.statusCode, 429);
});

test('4) bloqueia novo saque no limite de pendentes', async () => {
  await resetDb();
  const user = await mkUser('wd-limit@test.local');
  const tk = await token(user.id);
  await prisma.withdrawalRequest.createMany({ data: Array.from({ length: MAX_PENDING_WITHDRAWALS_PER_USER }, (_, i) => ({ code: `WD-L${i}`, userId: user.id, amount: new Decimal(10), status: i % 2 ? 'PENDING' : 'PROCESSING' })) });
  const res = await app.inject({ method: 'POST', url: '/api/withdrawals', headers: { authorization: `Bearer ${tk}` }, payload: { amount: 10 } });
  assert.equal(res.statusCode, 400);
});

test('5) bloqueia novo report no limite por hora', async () => {
  await resetDb();
  const user = await mkUser('report-limit@test.local');
  const tk = await token(user.id);
  await prisma.systemModeConfig.upsert({
    where: { id: 'SYSTEM_MODE_MAIN' },
    update: { mode: 'TEST' },
    create: { id: 'SYSTEM_MODE_MAIN', mode: 'TEST' },
  });
  await prisma.testModeReport.createMany({ data: Array.from({ length: MAX_REPORTS_PER_HOUR }, () => ({ userId: user.id, type: 'BUG', location: 'mercado', description: 'descricao', userSnapshot: '{}' })) });
  const res = await app.inject({ method: 'POST', url: '/api/test-mode/reports', headers: { authorization: `Bearer ${tk}` }, payload: { type: 'BUG', location: 'mercado', description: 'novo report' } });
  assert.equal(res.statusCode, 429);
});

test('6) bloqueia criação de projeto quando usuário comum está no limite diário', async () => {
  await resetDb();
  const user = await mkUser('project-limit@test.local');
  const tk = await token(user.id);
  await prisma.company.createMany({ data: Array.from({ length: MAX_PROJECT_CREATIONS_PER_DAY }, (_, i) => ({ name: `Comp ${i}`, ticker: `CP${i}X`, description: 'desc', sector: 'setor', founderUserId: user.id, status: 'PENDING', totalShares: 1000, circulatingShares: 0, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 0, initialPrice: 1, currentPrice: 1, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000 })) });
  const res = await app.inject({ method: 'POST', url: '/api/companies/request', headers: { authorization: `Bearer ${tk}` }, payload: { name: 'Nova', ticker: 'NVCPX', sector: 'setor', description: 'descricao ok', totalShares: 1000, initialPrice: 1, ownerSharePercent: 40, publicOfferPercent: 60, buyFeePercent: 1, sellFeePercent: 1 } });
  assert.equal(res.statusCode, 429);
});

test('7) não bloqueia usuário abaixo do limite', async () => {
  await resetDb();
  const user = await mkUser('under-limit@test.local');
  const tk = await token(user.id);
  const res = await app.inject({ method: 'POST', url: '/api/rpc-market/orders', headers: { authorization: `Bearer ${tk}` }, payload: { side: 'BUY_RPC', fiatAmount: 1, limitPrice: 1 } });
  assert.equal(res.statusCode, 201, res.body);
});
