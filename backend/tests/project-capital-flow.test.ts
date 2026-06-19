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
async function mkUser(email: string) { return prisma.user.create({ data: { email, name: email, passwordHash: await bcrypt.hash(PASS, 8), wallet: { create: {} } } }); }
async function tk(userId: string, roles: string[]) { return app.jwt.sign({ sub: userId, roles }); }
function idem(suffix: string) { return `project-capital-flow-${suffix}-000000`; }

test.before(async()=>{ await app.ready(); await resetDb(); });
test.after(async()=>{ await app.close(); await prisma.$disconnect(); });

test('project capital flow rules and idempotency', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const founder = await mkUser('founder@test.local');
  const other = await mkUser('other@test.local');
  await prisma.userRole.createMany({ data:[{userId:founder.id, roleId:rUser.id},{userId:other.id, roleId:rUser.id}] });
  await prisma.wallet.update({ where: { userId: founder.id }, data: { rpcAvailableBalance: 1000 } });
  const company = await prisma.company.create({ data: { name:'Comp', ticker:'CFLOW1', description:'desc', sector:'setor', founderUserId: founder.id, status:'ACTIVE', totalShares:1000, circulatingShares:0, ownerSharePercent:40, publicOfferPercent:60, ownerShares:400, publicOfferShares:600, availableOfferShares:600, initialPrice:10, currentPrice:10, buyFeePercent:1, sellFeePercent:1, fictitiousMarketCap:10000, revenueAccount:{create:{}} } });
  const founderToken = await tk(founder.id, ['USER']);
  const otherToken = await tk(other.id, ['USER']);

  const missingProject = await app.inject({ method:'POST', url:'/api/project-capital-flow/companies/missing-company/contribute', headers:{authorization:`Bearer ${founderToken}`, 'idempotency-key':idem('missing')}, payload:{amountRpc:10, reason:'motivo valido 123'} });
  assert.equal(missingProject.statusCode, 404);

  const forbidden = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${otherToken}`, 'idempotency-key':idem('forbidden')}, payload:{amountRpc:10, reason:'motivo valido 123'} });
  assert.equal(forbidden.statusCode, 403);

  const invalidAmount = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`, 'idempotency-key':idem('invalid-amount')}, payload:{amountRpc:0, reason:'motivo valido 123'} });
  assert.equal(invalidAmount.statusCode, 400);

  const invalidReason = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`, 'idempotency-key':idem('invalid-reason')}, payload:{amountRpc:10, reason:'curto'} });
  assert.equal(invalidReason.statusCode, 400);

  const missingIdempotency = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`}, payload:{amountRpc:10, reason:'motivo valido 123'} });
  assert.equal(missingIdempotency.statusCode, 400);

  const insufficient = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`, 'idempotency-key':idem('insufficient')}, payload:{amountRpc:5000, reason:'motivo valido 123'} });
  assert.equal(insufficient.statusCode, 400);

  const key = idem('success');
  const success = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`, 'idempotency-key':key}, payload:{amountRpc:100, reason:'aporte inicial valido'} });
  assert.equal(success.statusCode, 200, success.body);
  assert.equal(JSON.parse(success.body).idempotentReplay, false);

  const retry = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`, 'idempotency-key':key}, payload:{amountRpc:100, reason:'aporte inicial valido'} });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(JSON.parse(retry.body).idempotentReplay, true);
  assert.equal(JSON.parse(retry.body).entryId, JSON.parse(success.body).entryId);

  const conflict = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`, 'idempotency-key':key}, payload:{amountRpc:101, reason:'aporte inicial valido'} });
  assert.equal(conflict.statusCode, 409);

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
  assert.equal(await prisma.companyCapitalFlowEntry.count({ where: { companyId: company.id } }), 1);
  assert.equal(await prisma.transaction.count({ where: { walletId: walletAfter.id, type: 'PROJECT_RPC_CONTRIBUTION' } }), 1);
  assert.equal(await prisma.adminLog.count({ where: { action: 'PROJECT_RPC_CONTRIBUTION' } }), 1);
  assert.equal(Number(entry.previousWalletRpcBalance), 1000);
  assert.equal(Number(entry.newWalletRpcBalance), 900);
  assert.equal(Number(entry.previousProjectBalance), 0);
  assert.equal(Number(entry.newProjectBalance), 100);
  assert.equal(entry.idempotencyKey, key);
  assert.ok(tx);
  assert.ok(log);
  assert.equal(Number(companyAfter.currentPrice), 10);
  assert.equal(companyAfter.totalShares, 1000);
  assert.equal(trades, 0);
  assert.equal(orders, 0);
  assert.equal(holding, 0);

  await prisma.company.update({ where: { id: company.id }, data: { status: 'SUSPENDED' } });
  const inactive = await app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`, 'idempotency-key':idem('inactive')}, payload:{amountRpc:10, reason:'motivo valido 123'} });
  assert.equal(inactive.statusCode, 400);
});

test('project capital flow concurrent requests are idempotent and respect available balance', async () => {
  await resetDb();
  const rUser = await mkRole('USER');
  const founder = await mkUser('founder-concurrent@test.local');
  await prisma.userRole.create({ data:{userId:founder.id, roleId:rUser.id} });
  await prisma.wallet.update({ where: { userId: founder.id }, data: { rpcAvailableBalance: 150 } });
  const company = await prisma.company.create({ data: { name:'Comp Concurrent', ticker:'CFLOW2', description:'desc', sector:'setor', founderUserId: founder.id, status:'ACTIVE', totalShares:1000, circulatingShares:0, ownerSharePercent:40, publicOfferPercent:60, ownerShares:400, publicOfferShares:600, availableOfferShares:600, initialPrice:10, currentPrice:10, buyFeePercent:1, sellFeePercent:1, fictitiousMarketCap:10000, revenueAccount:{create:{}} } });
  const founderToken = await tk(founder.id, ['USER']);
  const sameKey = idem('same-concurrent');

  const [first, second] = await Promise.all([
    app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`, 'idempotency-key':sameKey}, payload:{amountRpc:100, reason:'aporte concorrente valido'} }),
    app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`, 'idempotency-key':sameKey}, payload:{amountRpc:100, reason:'aporte concorrente valido'} }),
  ]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual([JSON.parse(first.body).idempotentReplay, JSON.parse(second.body).idempotentReplay].sort(), [false, true]);

  let walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { userId: founder.id } });
  let revenueAfter = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  assert.equal(Number(walletAfter.rpcAvailableBalance), 50);
  assert.equal(Number(revenueAfter.balance), 100);
  assert.equal(await prisma.companyCapitalFlowEntry.count({ where: { companyId: company.id } }), 1);
  assert.equal(await prisma.transaction.count({ where: { type: 'PROJECT_RPC_CONTRIBUTION' } }), 1);
  assert.equal(await prisma.adminLog.count({ where: { action: 'PROJECT_RPC_CONTRIBUTION' } }), 1);

  const [third, fourth] = await Promise.all([
    app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`, 'idempotency-key':idem('different-a')}, payload:{amountRpc:40, reason:'aporte diferente um valido'} }),
    app.inject({ method:'POST', url:`/api/project-capital-flow/companies/${company.id}/contribute`, headers:{authorization:`Bearer ${founderToken}`, 'idempotency-key':idem('different-b')}, payload:{amountRpc:40, reason:'aporte diferente dois valido'} }),
  ]);
  assert.deepEqual([third.statusCode, fourth.statusCode].sort(), [200, 400]);

  walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { userId: founder.id } });
  revenueAfter = await prisma.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
  assert.equal(Number(walletAfter.rpcAvailableBalance), 10);
  assert.equal(Number(revenueAfter.balance), 140);
  assert.equal(await prisma.companyCapitalFlowEntry.count({ where: { companyId: company.id } }), 2);
  assert.equal(await prisma.transaction.count({ where: { type: 'PROJECT_RPC_CONTRIBUTION' } }), 2);
  assert.equal(await prisma.adminLog.count({ where: { action: 'PROJECT_RPC_CONTRIBUTION' } }), 2);
  assert.equal(await prisma.trade.count({ where: { companyId: company.id } }), 0);
  assert.equal(await prisma.marketOrder.count({ where: { companyId: company.id } }), 0);
  assert.equal(await prisma.companyHolding.count({ where: { companyId: company.id } }), 0);
});
