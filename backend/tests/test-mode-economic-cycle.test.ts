import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();

async function resetDb() {
  await prisma.$transaction([
    prisma.projectHolderDistributionPayment.deleteMany(),
    prisma.projectHolderDistributionSnapshot.deleteMany(),
    prisma.projectHolderDistributionProgram.deleteMany(),
    prisma.projectTokenReserveEntry.deleteMany(),
    prisma.projectTokenReserve.deleteMany(),
    prisma.projectBuybackExecution.deleteMany(),
    prisma.projectBuybackProgram.deleteMany(),
    prisma.companyCapitalFlowEntry.deleteMany(),
    prisma.feeDistribution.deleteMany(),
    prisma.companyOperation.deleteMany(),
    prisma.coinIssuance.deleteMany(),
    prisma.coinTransfer.deleteMany(),
    prisma.adminLog.deleteMany(),
    prisma.transaction.deleteMany(),
    prisma.trade.deleteMany(),
    prisma.marketOrder.deleteMany(),
    prisma.companyHolding.deleteMany(),
    prisma.companyInitialOffer.deleteMany(),
    prisma.companyRevenueAccount.deleteMany(),
    prisma.companyBoostInjection.deleteMany(),
    prisma.companyBoostAccount.deleteMany(),
    prisma.company.deleteMany(),
    prisma.testModeSimulationStep.deleteMany(), prisma.testModeSimulationRun.deleteMany(),
    prisma.testModeReport.deleteMany(), prisma.testModeTrade.deleteMany(), prisma.testModeWallet.deleteMany(), prisma.testModeMarketState.deleteMany(),
    prisma.rpcMarketState.deleteMany(), prisma.platformAccount.deleteMany(), prisma.brokerAccount.deleteMany(), prisma.treasuryAccount.deleteMany(),
    prisma.wallet.deleteMany(), prisma.userRole.deleteMany(), prisma.role.deleteMany(), prisma.user.deleteMany(),
  ]);
}
async function mkRole(key: string) { return prisma.role.create({ data: { key, name: key } }); }
async function mkUser(email: string, roles: {id:string;key:string}[]) { const u = await prisma.user.create({ data: { email, name: email, passwordHash: await bcrypt.hash('Admin@123', 10), wallet: { create: {} } } }); await prisma.userRole.createMany({ data: roles.map((r) => ({ userId: u.id, roleId: r.id })) }); return u; }
const tk = (u: string, roles: string[]) => app.jwt.sign({ sub: u, roles });

let roles: Record<string, {id:string;key:string}>;
test.before(async () => { await app.ready(); await resetDb(); roles = { USER: await mkRole('USER'), AUDITOR: await mkRole('AUDITOR'), ADMIN: await mkRole('ADMIN'), SUPER_ADMIN: await mkRole('SUPER_ADMIN'), COIN_CHIEF_ADMIN: await mkRole('COIN_CHIEF_ADMIN') }; });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('valida acesso, cenários, persistência e isolamento', async () => {
  await resetDb();
  // recria roles pós reset
  roles = { USER: await mkRole('USER'), AUDITOR: await mkRole('AUDITOR'), ADMIN: await mkRole('ADMIN'), SUPER_ADMIN: await mkRole('SUPER_ADMIN'), COIN_CHIEF_ADMIN: await mkRole('COIN_CHIEF_ADMIN') };
  const user = await mkUser('u@t.io',[roles.USER]); const auditor = await mkUser('a@t.io',[roles.AUDITOR]); const admin = await mkUser('adm@t.io',[roles.ADMIN]);
  const superAdmin = await mkUser('sa@t.io',[roles.SUPER_ADMIN]); const chief = await mkUser('cc@t.io',[roles.COIN_CHIEF_ADMIN]);

  const bad = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(admin.id,['ADMIN'])}` }, payload: { scenario: 'BASELINE_FULL_CYCLE', options: { initialRpcPrice: 0 } } });
  assert.equal(bad.statusCode, 400);

  const denied = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(user.id,['USER'])}` }, payload: { scenario: 'BASELINE_FULL_CYCLE' } });
  assert.equal(denied.statusCode, 403);
  const audRun = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(auditor.id,['AUDITOR'])}` }, payload: { scenario: 'BASELINE_FULL_CYCLE' } });
  assert.equal(audRun.statusCode, 403);

  const baseBefore = { wallet: await prisma.wallet.count(), trade: await prisma.trade.count(), order: await prisma.marketOrder.count(), company: await prisma.company.count(), rpcMarket: await prisma.rpcMarketState.count() };
  const baseline = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(admin.id,['ADMIN'])}` }, payload: { scenario: 'BASELINE_FULL_CYCLE' } });
  assert.equal(baseline.statusCode, 201, baseline.body);
  const b = baseline.json();
  assert.ok(b.runId); assert.ok(Array.isArray(b.steps) && b.steps.length >= 4);
  const persisted = await prisma.testModeSimulationRun.findUnique({ where: { id: b.runId }, include: { steps: true } });
  assert.ok(persisted); assert.equal(persisted!.steps.length, b.steps.length);
  assert.equal(b.summary.tradesExecuted, b.steps.filter((s: any) => s.type === 'SECONDARY_TRADE' || s.type === 'BUYBACK').length);

  const baseAfter = { wallet: await prisma.wallet.count(), trade: await prisma.trade.count(), order: await prisma.marketOrder.count(), company: await prisma.company.count(), rpcMarket: await prisma.rpcMarketState.count() };
  assert.deepEqual(baseAfter, baseBefore);

  const notFound = await app.inject({ method: 'GET', url: '/api/admin/test-mode/economic-cycle/runs/nao-existe', headers: { authorization: `Bearer ${tk(auditor.id,['AUDITOR'])}` } });
  assert.equal(notFound.statusCode, 404);

  const list = await app.inject({ method: 'GET', url: '/api/admin/test-mode/economic-cycle/runs', headers: { authorization: `Bearer ${tk(auditor.id,['AUDITOR'])}` } });
  assert.equal(list.statusCode, 200);
  const detail = await app.inject({ method: 'GET', url: `/api/admin/test-mode/economic-cycle/runs/${b.runId}`, headers: { authorization: `Bearer ${tk(auditor.id,['AUDITOR'])}` } });
  assert.equal(detail.statusCode, 200);
  const detailBody = detail.json();
  assert.ok(detailBody.steps.length >= 1);
  assert.equal(typeof detailBody.result, 'object');
  assert.equal(typeof detailBody.steps[0].before, 'object');
  assert.equal(typeof detailBody.steps[0].after, 'object');
  assert.ok(Array.isArray(detailBody.steps[0].issues));

  const bySuper = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(superAdmin.id,['SUPER_ADMIN'])}` }, payload: { scenario: 'WHALE_ENTRY' } });
  assert.equal(bySuper.statusCode, 201); assert.ok(bySuper.json().summary.warnings.includes('WHALE_CONCENTRATION_INCREASED'));
  const byChief = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(chief.id,['COIN_CHIEF_ADMIN'])}` }, payload: { scenario: 'WHALE_EXIT' } });
  assert.equal(byChief.statusCode, 201); assert.ok(byChief.json().summary.warnings.includes('WHALE_EXIT_SELL_PRESSURE'));

  const selfTrade = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(admin.id,['ADMIN'])}` }, payload: { scenario: 'SELF_TRADE_ATTEMPT' } });
  assert.equal(selfTrade.statusCode, 201); assert.ok(selfTrade.json().summary.warnings.includes('SELF_TRADE_BLOCKED'));
  const noLiq = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(admin.id,['ADMIN'])}` }, payload: { scenario: 'BUYBACK_NO_LIQUIDITY' } });
  assert.equal(noLiq.statusCode, 201); assert.ok(noLiq.json().summary.warnings.includes('BUYBACK_NO_SELLER_LIQUIDITY'));
  const low = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(admin.id,['ADMIN'])}` }, payload: { scenario: 'LOW_LIQUIDITY' } });
  assert.equal(low.statusCode, 201); assert.ok(low.json().summary.warnings.includes('LOW_LIQUIDITY_WARNING'));
  const mass = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(admin.id,['ADMIN'])}` }, payload: { scenario: 'MASS_SELL' } });
  assert.equal(mass.statusCode, 201); assert.ok(mass.json().summary.warnings.includes('MASS_SELL_PRESSURE')); assert.ok(Number(mass.json().summary.finalTokenPrice) < Number(mass.json().summary.initialTokenPrice));
});
