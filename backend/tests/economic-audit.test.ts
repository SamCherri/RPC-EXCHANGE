import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

if (process.env.NODE_ENV === 'production') throw new Error('Testes não podem rodar em produção.');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();
const PASSWORD = 'Admin@123';

async function resetDb() {
  await prisma.$transaction([
    prisma.projectHolderDistributionPayment.deleteMany(), prisma.projectHolderDistributionSnapshot.deleteMany(), prisma.projectHolderDistributionProgram.deleteMany(),
    prisma.projectTokenReserveEntry.deleteMany(), prisma.projectTokenReserve.deleteMany(), prisma.projectBuybackExecution.deleteMany(), prisma.projectBuybackProgram.deleteMany(), prisma.companyCapitalFlowEntry.deleteMany(),
    prisma.coinIssuance.deleteMany(), prisma.coinTransfer.deleteMany(), prisma.testModeWallet.deleteMany(), prisma.adminLog.deleteMany(), prisma.transaction.deleteMany(), prisma.trade.deleteMany(), prisma.marketOrder.deleteMany(), prisma.companyHolding.deleteMany(), prisma.companyRevenueAccount.deleteMany(), prisma.platformAccount.deleteMany(), prisma.brokerAccount.deleteMany(), prisma.treasuryAccount.deleteMany(), prisma.wallet.deleteMany(), prisma.company.deleteMany(), prisma.userRole.deleteMany(), prisma.role.deleteMany(), prisma.user.deleteMany(),
  ]);
}
const mkRole = (key: string) => prisma.role.create({ data: { key, name: key } });
const mkUser = async (email: string) => prisma.user.create({ data: { email, name: email, passwordHash: await bcrypt.hash(PASSWORD, 10), wallet: { create: {} } } });
const auth = (userId: string, roles: string[]) => app.jwt.sign({ sub: userId, roles });

test.before(async () => { await app.ready(); await resetDb(); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('query inválida retorna 400 e USER comum recebe 403', async () => {
  await resetDb();
  const userRole = await mkRole('USER'); const adminRole = await mkRole('SUPER_ADMIN');
  const user = await mkUser('user@ea.test'); const admin = await mkUser('admin@ea.test');
  await prisma.userRole.createMany({ data: [{ userId: user.id, roleId: userRole.id }, { userId: admin.id, roleId: adminRole.id }] });

  const bad = await app.inject({ method: 'GET', url: '/api/admin/economic-audit?includeWarnings=abc', headers: { authorization: `Bearer ${await auth(admin.id, ['SUPER_ADMIN'])}` } });
  assert.equal(bad.statusCode, 400);

  const forbidden = await app.inject({ method: 'GET', url: '/api/admin/economic-audit', headers: { authorization: `Bearer ${await auth(user.id, ['USER'])}` } });
  assert.equal(forbidden.statusCode, 403);
});

test('filtros includeWarnings, severity e category funcionam', async () => {
  await resetDb();
  const adminRole = await mkRole('SUPER_ADMIN');
  const admin = await mkUser('admin2@ea.test');
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });

  await prisma.coinIssuance.create({ data: { createdById: '', amount: 1, reason: '', destination: 'TREASURY', previousValue: 0, newValue: 1 } });
  await prisma.wallet.update({ where: { userId: admin.id }, data: { rpcAvailableBalance: -1 } });

  const token = await auth(admin.id, ['SUPER_ADMIN']);
  const noWarn = await app.inject({ method: 'GET', url: '/api/admin/economic-audit?includeWarnings=false', headers: { authorization: `Bearer ${token}` } });
  assert.equal(noWarn.statusCode, 200);
  assert.equal(noWarn.json().issues.some((i: { severity: string }) => i.severity === 'WARNING'), false);

  const critical = await app.inject({ method: 'GET', url: '/api/admin/economic-audit?severity=CRITICAL', headers: { authorization: `Bearer ${token}` } });
  assert.equal(critical.statusCode, 200);
  assert.ok(critical.json().issues.every((i: { severity: string }) => i.severity === 'CRITICAL'));

  const byCategory = await app.inject({ method: 'GET', url: '/api/admin/economic-audit?category=NEGATIVE_BALANCE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(byCategory.statusCode, 200);
  assert.ok(byCategory.json().issues.every((i: { category: string }) => i.category === 'NEGATIVE_BALANCE'));
});

test('detecta checks novos de order/buyback/distribution e mantém read-only', async () => {
  await resetDb();
  const adminRole = await mkRole('SUPER_ADMIN');
  const admin = await mkUser('admin3@ea.test');
  const founder = await mkUser('founder@ea.test');
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });

  const company = await prisma.company.create({ data: { name: 'Comp', ticker: 'COMPZ', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 1000, ownerSharePercent: 50, publicOfferPercent: 50, ownerShares: 500, publicOfferShares: 500, availableOfferShares: 500, initialPrice: 1, currentPrice: 1, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000 } });
  const program = await prisma.projectBuybackProgram.create({ data: { companyId: company.id, createdByUserId: admin.id, status: 'COMPLETED', budgetRpc: 100, spentRpc: 20, remainingRpc: 30, maxPricePerShare: 1, targetShares: 10, reason: 'x' } });
  const trade = await prisma.trade.create({ data: { companyId: company.id, buyerId: admin.id, sellerId: founder.id, quantity: 1, unitPrice: 1, grossAmount: 1, buyFeeAmount: 0, sellFeeAmount: 0 } });
  await prisma.projectBuybackExecution.create({ data: { programId: program.id, companyId: company.id, sellerUserId: founder.id, tradeId: trade.id, quantity: 1, unitPrice: 1, grossAmountRpc: 1, feeAmountRpc: 0, totalAmountRpc: 1 } });

  const dist = await prisma.projectHolderDistributionProgram.create({ data: { companyId: company.id, createdByUserId: admin.id, status: 'COMPLETED', budgetRpc: 10, distributedRpc: 1, eligibleShares: 1, eligibleHoldersCount: 1, reason: 'r', excludeFounder: true } });
  const snap = await prisma.projectHolderDistributionSnapshot.create({ data: { programId: dist.id, companyId: company.id, userId: founder.id, shares: 1, sharePercent: 1, calculatedAmountRpc: 1, status: 'PENDING' } });
  await prisma.projectHolderDistributionPayment.create({ data: { programId: dist.id, snapshotId: snap.id, companyId: company.id, userId: founder.id, walletId: (await prisma.wallet.findUniqueOrThrow({ where: { userId: founder.id } })).id, transactionId: 'tx-missing', amountRpc: 1 } });

  await prisma.marketOrder.create({ data: { companyId: company.id, userId: admin.id, type: 'BUY', mode: 'LIMIT', quantity: 5, remainingQuantity: 0, lockedCash: -2, status: 'OPEN', limitPrice: 1 } });

  const before = {
    tx: await prisma.transaction.count(),
    trades: await prisma.trade.count(),
    orders: await prisma.marketOrder.count(),
  };

  const token = await auth(admin.id, ['SUPER_ADMIN']);
  const res = await app.inject({ method: 'GET', url: '/api/admin/economic-audit?includeWarnings=true', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200, res.body);
  const codes = res.json().issues.map((i: { code: string }) => i.code);
  assert.ok(codes.includes('OPEN_ORDER_INVALID_REMAINING'));
  assert.ok(codes.includes('ORDER_NEGATIVE_LOCKED_CASH'));
  assert.ok(codes.includes('BUYBACK_BUDGET_MISMATCH'));
  assert.ok(codes.includes('BUYBACK_COMPLETED_WITH_REMAINING'));
  assert.ok(codes.includes('BUYBACK_EXECUTION_WITHOUT_RESERVE_ENTRY'));
  assert.ok(codes.includes('HOLDER_DISTRIBUTION_COMPLETED_WITH_PENDING'));
  assert.ok(codes.includes('FOUNDER_PAID_WHEN_EXCLUDED'));
  assert.ok(codes.includes('HOLDER_PAYMENT_WITHOUT_TRANSACTION'));

  const after = {
    tx: await prisma.transaction.count(),
    trades: await prisma.trade.count(),
    orders: await prisma.marketOrder.count(),
  };
  assert.deepEqual(after, before);
});


test('detecta alertas de preço e crédito institucional sem origem e mantém filtros/read-only', async () => {
  await resetDb();
  const adminRole = await mkRole('SUPER_ADMIN');
  const admin = await mkUser('admin4@ea.test');
  const founder = await mkUser('founder4@ea.test');
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });

  const c1 = await prisma.company.create({ data: { name: 'P1', ticker: 'P1AA', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 100, ownerSharePercent: 50, publicOfferPercent: 50, ownerShares: 50, publicOfferShares: 50, availableOfferShares: 50, initialPrice: 1, currentPrice: 0, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 0 } });
  const c2 = await prisma.company.create({ data: { name: 'P2', ticker: 'P2AA', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 100, ownerSharePercent: 50, publicOfferPercent: 50, ownerShares: 50, publicOfferShares: 50, availableOfferShares: 50, initialPrice: 1, currentPrice: 2, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 50 } });

  await prisma.companyRevenueAccount.create({ data: { companyId: c2.id, balance: 20, totalReceivedFees: 9, totalWithdrawn: 0, totalUsedForBoost: 0 } });

  const token = await auth(admin.id, ['SUPER_ADMIN']);
  const all = await app.inject({ method: 'GET', url: '/api/admin/economic-audit?includeWarnings=true', headers: { authorization: `Bearer ${token}` } });
  assert.equal(all.statusCode, 200, all.body);
  const codes = all.json().issues.map((i: { code: string }) => i.code);
  assert.ok(codes.includes('ACTIVE_COMPANY_NON_POSITIVE_PRICE'));
  assert.ok(codes.includes('PRICE_CHANGED_WITHOUT_ECONOMIC_EVENT'));
  assert.ok(codes.includes('INSTITUTIONAL_BALANCE_WITHOUT_TRACEABLE_SOURCE'));
  assert.ok(codes.includes('COMPANY_REVENUE_FEES_MISMATCH'));

  const filtered = await app.inject({ method: 'GET', url: '/api/admin/economic-audit?category=PRICE_INTEGRITY', headers: { authorization: `Bearer ${token}` } });
  assert.equal(filtered.statusCode, 200);
  assert.ok(filtered.json().issues.every((i: { category: string }) => i.category === 'PRICE_INTEGRITY'));

  const before = { tx: await prisma.transaction.count(), trades: await prisma.trade.count(), orders: await prisma.marketOrder.count() };
  await app.inject({ method: 'GET', url: '/api/admin/economic-audit/summary', headers: { authorization: `Bearer ${token}` } });
  const after = { tx: await prisma.transaction.count(), trades: await prisma.trade.count(), orders: await prisma.marketOrder.count() };
  assert.deepEqual(after, before);
});

test('não acusa divergência com trade antigo quando INITIAL_OFFER_BUY é evento mais recente', async () => {
  await resetDb();
  const adminRole = await mkRole('SUPER_ADMIN');
  const admin = await mkUser('admin5@ea.test');
  const founder = await mkUser('founder5@ea.test');
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });

  const c = await prisma.company.create({ data: { name: 'PX', ticker: 'PXAA', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 100, ownerSharePercent: 50, publicOfferPercent: 50, ownerShares: 50, publicOfferShares: 50, availableOfferShares: 50, initialPrice: 1, currentPrice: 1.5, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 150 } });
  await prisma.trade.create({ data: { companyId: c.id, buyerId: admin.id, sellerId: founder.id, quantity: 1, unitPrice: 1.2, grossAmount: 1.2, buyFeeAmount: 0, sellFeeAmount: 0 } });
  await prisma.companyOperation.create({ data: { companyId: c.id, userId: founder.id, type: 'INITIAL_OFFER_BUY', quantity: 1, unitPrice: 1.5, description: 'op recente' } });

  const token = await auth(admin.id, ['SUPER_ADMIN']);
  const res = await app.inject({ method: 'GET', url: '/api/admin/economic-audit', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  const codes = res.json().issues.filter((i: { companyId?: string }) => i.companyId === c.id).map((i: { code: string }) => i.code);
  assert.equal(codes.includes('CURRENT_PRICE_DIVERGES_LAST_TRADE'), false);
});

test('não acusa COMPANY_REVENUE_BALANCE_MISMATCH em caso legítimo de budget reservado em buyback', async () => {
  await resetDb();
  const adminRole = await mkRole('SUPER_ADMIN');
  const admin = await mkUser('admin6@ea.test');
  const founder = await mkUser('founder6@ea.test');
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });

  const c = await prisma.company.create({ data: { name: 'PY', ticker: 'PYAA', description: 'd', sector: 's', founderUserId: founder.id, status: 'ACTIVE', totalShares: 100, ownerSharePercent: 50, publicOfferPercent: 50, ownerShares: 50, publicOfferShares: 50, availableOfferShares: 50, initialPrice: 1, currentPrice: 1, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 100 } });
  await prisma.companyRevenueAccount.create({ data: { companyId: c.id, balance: 60, totalReceivedFees: 100, totalWithdrawn: 0, totalUsedForBoost: 0 } });
  await prisma.feeDistribution.create({ data: { companyId: c.id, sourceType: 'INITIAL_OFFER_BUY', totalFeeAmount: 100, platformAmount: 0, companyAmount: 100, platformSharePercent: 0, companySharePercent: 100 } });
  await prisma.projectBuybackProgram.create({ data: { companyId: c.id, createdByUserId: admin.id, status: 'ACTIVE', budgetRpc: 40, spentRpc: 0, remainingRpc: 40, maxPricePerShare: 1, targetShares: 10, reason: 'reserve budget' } });

  const token = await auth(admin.id, ['SUPER_ADMIN']);
  const res = await app.inject({ method: 'GET', url: '/api/admin/economic-audit?includeWarnings=true', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  const codes = res.json().issues.filter((i: { companyId?: string }) => i.companyId === c.id).map((i: { code: string }) => i.code);
  assert.equal(codes.includes('COMPANY_REVENUE_BALANCE_MISMATCH'), false);
});
