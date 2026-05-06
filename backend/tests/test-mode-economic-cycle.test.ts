import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();

async function resetDb() {
  await prisma.$transaction([
    prisma.testModeSimulationStep.deleteMany(), prisma.testModeSimulationRun.deleteMany(),
    prisma.testModeReport.deleteMany(), prisma.testModeTrade.deleteMany(), prisma.testModeWallet.deleteMany(), prisma.testModeMarketState.deleteMany(),
    prisma.trade.deleteMany(), prisma.marketOrder.deleteMany(), prisma.companyHolding.deleteMany(), prisma.company.deleteMany(),
    prisma.wallet.deleteMany(), prisma.userRole.deleteMany(), prisma.role.deleteMany(), prisma.user.deleteMany(), prisma.rpcMarketState.deleteMany(),
  ]);
}
async function mkRole(key: string) { return prisma.role.create({ data: { key, name: key } }); }
async function mkUser(email: string, roles: {id:string;key:string}[]) { const u = await prisma.user.create({ data: { email, name: email, passwordHash: await bcrypt.hash('Admin@123', 10), wallet: { create: {} } } }); await prisma.userRole.createMany({ data: roles.map((r) => ({ userId: u.id, roleId: r.id })) }); return u; }
const tk = (u: string, roles: string[]) => app.jwt.sign({ sub: u, roles });

test.before(async () => { await app.ready(); await resetDb(); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('controle de acesso e isolamento', async () => {
  await resetDb();
  const rUser = await mkRole('USER'); const rAud = await mkRole('AUDITOR'); const rAdmin = await mkRole('ADMIN');
  const user = await mkUser('u@t.io',[rUser]); const auditor = await mkUser('a@t.io',[rAud]); const admin = await mkUser('adm@t.io',[rAdmin]);

  const denied = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(user.id,['USER'])}` }, payload: { scenario: 'BASELINE_FULL_CYCLE' } });
  assert.equal(denied.statusCode, 403);
  const audRun = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(auditor.id,['AUDITOR'])}` }, payload: { scenario: 'BASELINE_FULL_CYCLE' } });
  assert.equal(audRun.statusCode, 403);

  const before = { wallet: await prisma.wallet.count(), trade: await prisma.trade.count(), order: await prisma.marketOrder.count(), company: await prisma.company.count(), rpcMarket: await prisma.rpcMarketState.count() };
  const ok = await app.inject({ method: 'POST', url: '/api/admin/test-mode/economic-cycle/run', headers: { authorization: `Bearer ${tk(admin.id,['ADMIN'])}` }, payload: { scenario: 'BASELINE_FULL_CYCLE' } });
  assert.equal(ok.statusCode, 201, ok.body);
  const body = ok.json();
  assert.ok(body.runId);
  assert.ok(body.summary && body.steps);
  const after = { wallet: await prisma.wallet.count(), trade: await prisma.trade.count(), order: await prisma.marketOrder.count(), company: await prisma.company.count(), rpcMarket: await prisma.rpcMarketState.count() };
  assert.deepEqual(after, before);

  const listed = await app.inject({ method: 'GET', url: '/api/admin/test-mode/economic-cycle/runs', headers: { authorization: `Bearer ${tk(auditor.id,['AUDITOR'])}` } });
  assert.equal(listed.statusCode, 200);
  assert.ok(listed.json().runs.length >= 1);
});
