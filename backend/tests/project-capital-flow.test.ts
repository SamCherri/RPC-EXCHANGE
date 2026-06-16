import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();
const PASS = 'Admin@123';

async function resetDb() {
  await prisma.$transaction([
    prisma.companyCapitalFlowEntry.deleteMany(), prisma.rpcLimitOrder.deleteMany(), prisma.rpcExchangeTrade.deleteMany(), prisma.rpcMarketState.deleteMany(),
    prisma.feeDistribution.deleteMany(), prisma.trade.deleteMany(), prisma.marketOrder.deleteMany(), prisma.companyOperation.deleteMany(), prisma.companyHolding.deleteMany(), prisma.companyInitialOffer.deleteMany(), prisma.companyRevenueAccount.deleteMany(), prisma.companyBoostInjection.deleteMany(), prisma.companyBoostAccount.deleteMany(), prisma.company.deleteMany(), prisma.coinTransfer.deleteMany(), prisma.coinIssuance.deleteMany(), prisma.transaction.deleteMany(), prisma.withdrawalRequest.deleteMany(), prisma.adminLog.deleteMany(), prisma.brokerAccount.deleteMany(), prisma.wallet.deleteMany(), prisma.userRole.deleteMany(), prisma.rolePermission.deleteMany(), prisma.permission.deleteMany(), prisma.role.deleteMany(), prisma.testModeReport.deleteMany(), prisma.testModeTrade.deleteMany(), prisma.testModeWallet.deleteMany(), prisma.testModeMarketState.deleteMany(), prisma.systemModeConfig.deleteMany(), prisma.user.deleteMany(), prisma.platformAccount.deleteMany(), prisma.treasuryAccount.deleteMany(),
  ]);
}
async function mkRole(key: string) { return prisma.role.create({ data: { key, name: key } }); }
async function mkUser(email: string) { return prisma.user.create({ data: { email, discord: email.replace(/[^a-z0-9]/gi, '_').toLowerCase(), gamePhone: `TEST-${email.replace(/[^a-z0-9]/gi, '_').slice(0, 24)}`, name: email, passwordHash: await bcrypt.hash(PASS, 8), wallet: { create: {} } } }); }
async function tk(userId: string, roles: string[]) { return app.jwt.sign({ sub: userId, roles }); }

test.before(async()=>{ await app.ready(); await resetDb(); });
test.after(async()=>{ await app.close(); await prisma.$disconnect(); });

test('project capital flow rules', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const founder = await mkUser('founder@test.local');
  const other = await mkUser('other@test.local');
  await prisma.userRole.createMany({ data:[{userId:founder.id, roleId:rUser.id},{userId:other.id, roleId:rUser.id}] });
  await prisma.wallet.update({ where: { userId: founder.id }, data: { rpcAvailableBalance: 1000 } });
  const company = await prisma.company.create({ data: { name:'Comp', ticker:'CFLOW1', description:'desc', sector:'setor', founderUserId: founder.id, status:'ACTIVE', totalShares:1000, circulatingShares:0, ownerSharePercent:40, publicOfferPercent:60, ownerShares:400, publicOfferShares:600, availableOfferShares:600, initialPrice:10, currentPrice:10, buyFeePercent:1, sellFeePercent:1, fictitiousMarketCap:10000, revenueAccount:{create:{}} } });
  const founderToken = await tk(founder.id, ['USER']);
  const otherToken = await tk(other.id, ['USER']);

  const forbidden = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${otherToken}`}, payload:{amountRpc:10, reason:'motivo valido 123'} });
  assert.equal(forbidden.statusCode, 403);

  const invalidAmount = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`}, payload:{amountRpc:0, reason:'motivo valido 123'} });
  assert.equal(invalidAmount.statusCode, 400);

  const invalidReason = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`}, payload:{amountRpc:10, reason:'curto'} });
  assert.equal(invalidReason.statusCode, 400);

  const insufficient = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`}, payload:{amountRpc:5000, reason:'motivo valido 123'} });
  assert.equal(insufficient.statusCode, 400);

  const success = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`}, payload:{amountRpc:100, reason:'aporte inicial valido'} });
  assert.equal(success.statusCode, 200, success.body);

  const companyAfter = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  const walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { userId: founder.id } });
  const revenueAfter = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  const entry = await prisma.companyCapitalFlowEntry.findFirstOrThrow({ where: { companyId: company.id } });
  const tx = await prisma.transaction.findFirst({ where: { walletId: walletAfter.id, type: 'PROJECT_RPC_CONTRIBUTION' } });
  const log = await prisma.adminLog.findFirst({ where: { action: 'PROJECT_RPC_CONTRIBUTION' } });
  const trades = await prisma.trade.count({ where: { companyId: company.id } });
  const orders = await prisma.marketOrder.count({ where: { companyId: company.id } });
  const holding = await prisma.companyHolding.count({ where: { companyId: company.id } });

  assert.equal(Number(walletAfter.rpcAvailableBalance), 900);
  assert.equal(Number(revenueAfter.balance), 100);
  assert.equal(Number(entry.previousWalletRpcBalance), 1000);
  assert.equal(Number(entry.newWalletRpcBalance), 900);
  assert.equal(Number(entry.previousProjectBalance), 0);
  assert.equal(Number(entry.newProjectBalance), 100);
  assert.ok(tx);
  assert.ok(log);
  assert.equal(Number(companyAfter.currentPrice), 10);
  assert.equal(trades, 0);
  assert.equal(orders, 0);
  assert.equal(holding, 0);

  await prisma.company.update({ where: { id: company.id }, data: { status: 'SUSPENDED' } });
  const inactive = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`}, payload:{amountRpc:10, reason:'motivo valido 123'} });
  assert.equal(inactive.statusCode, 400);
});
