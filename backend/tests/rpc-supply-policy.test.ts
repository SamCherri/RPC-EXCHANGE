import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();
const PWD = 'Admin@123';

async function resetDb() {
  await prisma.$transaction([
    prisma.projectHolderDistributionPayment.deleteMany(), prisma.projectHolderDistributionSnapshot.deleteMany(), prisma.projectHolderDistributionProgram.deleteMany(),
    prisma.projectBuybackExecution.deleteMany(), prisma.projectBuybackProgram.deleteMany(), prisma.companyInitialOffer.deleteMany(), prisma.companyHolding.deleteMany(),
    prisma.companyRevenueAccount.deleteMany(), prisma.company.deleteMany(),
    prisma.coinIssuance.deleteMany(), prisma.coinTransfer.deleteMany(), prisma.withdrawalRequest.deleteMany(),
    prisma.brokerAccount.deleteMany(), prisma.wallet.deleteMany(), prisma.userRole.deleteMany(), prisma.role.deleteMany(), prisma.user.deleteMany(),
    prisma.platformAccount.deleteMany(), prisma.treasuryAccount.deleteMany(), prisma.testModeWallet.deleteMany(),
  ]);
}

async function mkRole(key: string) { return prisma.role.create({ data: { key, name: key } }); }
async function mkUser(email: string) { return prisma.user.create({ data: { email, name: email, passwordHash: await bcrypt.hash(PWD, 10), wallet: { create: {} } } }); }
async function tk(userId: string, roles: string[]) { return app.jwt.sign({ sub: userId, roles }); }

test.before(async () => { await app.ready(); await resetDb(); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('política RPC ignora fiat/legado e calcula apenas RPC real', async () => {
  await resetDb();
  const roleUser = await mkRole('USER'); const roleAudit = await mkRole('AUDITOR');
  const user = await mkUser('u@test.local'); const auditor = await mkUser('a@test.local');
  await prisma.userRole.createMany({ data: [{ userId: user.id, roleId: roleUser.id }, { userId: auditor.id, roleId: roleAudit.id }] });

  const company = await prisma.company.create({
    data: {
      name: 'Comp', ticker: 'RPCP1', description: 'd', sector: 's', founderUserId: auditor.id, status: 'ACTIVE', totalShares: 100, circulatingShares: 0,
      ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 40, publicOfferShares: 60, availableOfferShares: 60,
      initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000, approvedAt: new Date(), revenueAccount: { create: { balance: 70 } },
    },
  });

  await prisma.wallet.update({ where: { userId: user.id }, data: { rpcAvailableBalance: 100, rpcLockedBalance: 20, pendingWithdrawalBalance: 999, fiatPendingWithdrawalBalance: 123 } });
  await prisma.treasuryAccount.create({ data: { balance: 300 } });
  await prisma.brokerAccount.create({ data: { userId: auditor.id, available: 40, receivedTotal: 999 } });
  await prisma.platformAccount.create({ data: { balance: 50 } });
  await prisma.projectBuybackProgram.create({ data: { companyId: company.id, createdByUserId: auditor.id, status: 'ACTIVE', budgetRpc: 40, remainingRpc: 30, spentRpc: 10, maxPricePerShare: 10, targetShares: 5, purchasedShares: 1, reason: 'teste', expiresAt: new Date(Date.now() + 86400000) } });
  await prisma.withdrawalRequest.create({ data: { code: 'WDRPC1', userId: user.id, amount: 500, status: 'COMPLETED' } });
  await prisma.testModeWallet.create({ data: { userId: auditor.id, rpcBalance: 5000, fiatBalance: 1000 } });

  const forbid = await app.inject({ method: 'GET', url: '/api/admin/rpc-supply-policy', headers: { authorization: `Bearer ${await tk(user.id, ['USER'])}` } });
  assert.equal(forbid.statusCode, 403);

  const ok = await app.inject({ method: 'GET', url: '/api/admin/rpc-supply-policy', headers: { authorization: `Bearer ${await tk(auditor.id, ['AUDITOR'])}` } });
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json();
  assert.equal(Number(body.availableRpc), 100);
  assert.equal(Number(body.lockedRpc), 20);
  assert.equal(Number(body.pendingWithdrawalRpc), 0);
  assert.equal(Number(body.userWalletRpc), 120);
  assert.equal(Number(body.treasuryRpc), 300);
  assert.equal(Number(body.brokerRpc), 40);
  assert.equal(Number(body.platformRpc), 50);
  assert.equal(Number(body.companyRevenueRpc), 70);
  assert.equal(Number(body.buybackReservedRpc), 30);
  assert.equal(Number(body.circulatingRpc), 610);
  assert.equal(Number(body.totalWithdrawn), 0);
  assert.equal(Number(body.fiatWithdrawn), 500);
});

test('auditoria RPC detecta negativos críticos e revisão legado', async () => {
  await resetDb();
  const roleAudit = await mkRole('AUDITOR');
  const auditor = await mkUser('audit@test.local');
  await prisma.userRole.create({ data: { userId: auditor.id, roleId: roleAudit.id } });

  const company = await prisma.company.create({
    data: {
      name: 'Comp2', ticker: 'RPCP2', description: 'd', sector: 's', founderUserId: auditor.id, status: 'ACTIVE', totalShares: 100, circulatingShares: 0,
      ownerSharePercent: 40, publicOfferPercent: 60, ownerShares: 40, publicOfferShares: 60, availableOfferShares: 60,
      initialPrice: 10, currentPrice: 10, buyFeePercent: 1, sellFeePercent: 1, fictitiousMarketCap: 1000, approvedAt: new Date(),
    },
  });

  await prisma.wallet.update({ where: { userId: auditor.id }, data: { rpcAvailableBalance: -1, rpcLockedBalance: -2, pendingWithdrawalBalance: -3 } });
  await prisma.treasuryAccount.create({ data: { balance: -4 } });
  await prisma.companyRevenueAccount.create({ data: { companyId: company.id, balance: -5 } });
  await prisma.projectBuybackProgram.create({ data: { companyId: company.id, createdByUserId: auditor.id, status: 'ACTIVE', budgetRpc: 10, remainingRpc: -6, spentRpc: 16, maxPricePerShare: 10, targetShares: 5, purchasedShares: 0, reason: 'teste', expiresAt: new Date(Date.now() + 86400000) } });
  await prisma.projectHolderDistributionProgram.create({ data: { companyId: company.id, createdByUserId: auditor.id, budgetRpc: 10, distributedRpc: 11, eligibleShares: 100, eligibleHoldersCount: 2, excludeFounder: true, reason: 'dist' } });

  const auditResp = await app.inject({ method: 'GET', url: '/api/admin/rpc-supply-policy/audit', headers: { authorization: `Bearer ${await tk(auditor.id, ['AUDITOR'])}` } });
  assert.equal(auditResp.statusCode, 200, auditResp.body);
  const payload = auditResp.json();
  const codes = new Set(payload.issues.map((i: { code: string }) => i.code));
  assert.ok(codes.has('NEGATIVE_WALLET_RPC_AVAILABLE'));
  assert.ok(codes.has('NEGATIVE_WALLET_RPC_LOCKED'));
  assert.ok(codes.has('LEGACY_PENDING_WITHDRAWAL_BALANCE_REVIEW'));
  assert.ok(codes.has('NEGATIVE_TREASURY_BALANCE'));
  assert.ok(codes.has('NEGATIVE_COMPANY_REVENUE_BALANCE'));
  assert.ok(codes.has('NEGATIVE_BUYBACK_REMAINING_RPC'));
  assert.ok(codes.has('HOLDER_DISTRIBUTION_EXCEEDS_BUDGET'));
});
