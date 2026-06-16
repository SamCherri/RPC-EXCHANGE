import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();
const PASSWORD = 'Admin@123';

async function resetDb() { await prisma.$transaction([prisma.rpcLimitOrder.deleteMany(), prisma.rpcExchangeTrade.deleteMany(), prisma.rpcMarketState.deleteMany(), prisma.trade.deleteMany(), prisma.marketOrder.deleteMany(), prisma.companyHolding.deleteMany(), prisma.companyRevenueAccount.deleteMany(), prisma.company.deleteMany(), prisma.testModeTrade.deleteMany(), prisma.testModeWallet.deleteMany(), prisma.testModeMarketState.deleteMany(), prisma.wallet.deleteMany(), prisma.userRole.deleteMany(), prisma.role.deleteMany(), prisma.user.deleteMany(), prisma.platformAccount.deleteMany()]); }
async function mkRole(key: string) { return prisma.role.create({ data: { key, name: key } }); }
async function mkUser(email: string) { return prisma.user.create({ data: { email, discord: email.replace(/[^a-z0-9]/gi, '_').toLowerCase(), gamePhone: `TEST-${email.replace(/[^a-z0-9]/gi, '_').slice(0, 24)}`, name: email, passwordHash: await bcrypt.hash(PASSWORD, 10), wallet: { create: {} } } }); }
async function auth(userId: string, roles: string[]) { return app.jwt.sign({ sub: userId, roles }); }

test.before(async () => { await app.ready(); await resetDb(); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('market health exige permissão e retorna sections', async () => {
  await resetDb();
  const rUser = await mkRole('USER'); const rAuditor = await mkRole('AUDITOR');
  const user = await mkUser('u@test.local'); const auditor = await mkUser('a@test.local');
  await prisma.userRole.createMany({ data: [{ userId: user.id, roleId: rUser.id }, { userId: auditor.id, roleId: rAuditor.id }] });

  const forbidden = await app.inject({ method: 'GET', url: '/api/admin/market-health', headers: { authorization: `Bearer ${await auth(user.id, ['USER'])}` } });
  assert.equal(forbidden.statusCode, 403);

  const ok = await app.inject({ method: 'GET', url: '/api/admin/market-health', headers: { authorization: `Bearer ${await auth(auditor.id, ['AUDITOR'])}` } });
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json();
  assert.ok(body.sections?.testMode);
  assert.ok(body.sections?.rpcMarket);
  assert.ok(body.sections?.companyMarket);
  assert.equal(JSON.stringify(body).includes('passwordHash'), false);
});

test('detecta inconsistências principais', async () => {
  await resetDb();
  const r = await mkRole('SUPER_ADMIN');
  const admin = await mkUser('admin@test.local');
  await prisma.userRole.create({ data: { userId: admin.id, roleId: r.id } });
  const u = await mkUser('bad@test.local');

  await prisma.testModeWallet.create({ data: { userId: u.id, fiatBalance: -1, rpcBalance: 1 } });
  await prisma.testModeMarketState.create({ data: { id: 'test_market', currentPrice: 10, fiatReserve: 1000, rpcReserve: 1 } });
  await prisma.wallet.update({ where: { userId: u.id }, data: { fiatAvailableBalance: -10 } });
  await prisma.rpcExchangeTrade.create({ data: { userId: u.id, side: 'BUY_RPC', fiatAmount: 100, rpcAmount: 10, unitPrice: 1, priceBefore: 1, priceAfter: 1 } });

  const founder = await mkUser('founder@test.local');
  const company = await prisma.company.create({ data: { name: 'Comp', ticker: 'CMP2', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000, circulatingShares: 10, ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 400, publicOfferShares: 600, availableOfferShares: 10, initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 10000, approvedAt: new Date(), revenueAccount: { create: {} } } });
  await prisma.trade.create({ data: { companyId: company.id, buyerId: u.id, sellerId: u.id, quantity: 1, unitPrice: 10, grossAmount: 10, buyFeeAmount: 0.1, sellFeeAmount: 0.1 } });

  const response = await app.inject({ method: 'GET', url: '/api/admin/market-health', headers: { authorization: `Bearer ${await auth(admin.id, ['SUPER_ADMIN'])}` } });
  const body = response.json();
  const all = [...body.sections.testMode.issues, ...body.sections.rpcMarket.issues, ...body.sections.companyMarket.issues].map((i: { code: string }) => i.code);
  assert.ok(all.includes('TEST_WALLET_NEGATIVE'));
  assert.ok(all.includes('TEST_MARKET_PRICE_DIVERGENCE'));
  assert.ok(all.includes('RPC_WALLET_NEGATIVE'));
  assert.ok(all.includes('RPC_TRADE_UNIT_PRICE_INCONSISTENT'));
  assert.ok(all.includes('COMPANY_SELF_TRADE'));
});
