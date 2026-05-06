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
    prisma.projectBuybackExecution.deleteMany(), prisma.projectBuybackProgram.deleteMany(),
    prisma.companyRevenueAccount.deleteMany(), prisma.coinIssuance.deleteMany(), prisma.coinTransfer.deleteMany(), prisma.withdrawalRequest.deleteMany(),
    prisma.brokerAccount.deleteMany(), prisma.wallet.deleteMany(), prisma.userRole.deleteMany(), prisma.role.deleteMany(), prisma.user.deleteMany(),
    prisma.platformAccount.deleteMany(), prisma.treasuryAccount.deleteMany(),
  ]);
}

async function mkRole(key: string) { return prisma.role.create({ data: { key, name: key } }); }
async function mkUser(email: string) { return prisma.user.create({ data: { email, name: email, passwordHash: await bcrypt.hash(PWD, 10), wallet: { create: {} } } }); }
async function tk(userId: string, roles: string[]) { return app.jwt.sign({ sub: userId, roles }); }

test.before(async () => { await app.ready(); await resetDb(); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('política RPC respeita permissões e calcula snapshot', async () => {
  await resetDb();
  const roleUser = await mkRole('USER'); const roleAudit = await mkRole('AUDITOR');
  const user = await mkUser('u@test.local'); const auditor = await mkUser('a@test.local');
  await prisma.userRole.createMany({ data: [{ userId: user.id, roleId: roleUser.id }, { userId: auditor.id, roleId: roleAudit.id }] });

  await prisma.wallet.update({ where: { userId: user.id }, data: { rpcAvailableBalance: 100, rpcLockedBalance: 20, pendingWithdrawalBalance: 5 } });
  await prisma.treasuryAccount.create({ data: { balance: 300 } });
  await prisma.brokerAccount.create({ data: { userId: auditor.id, available: 40, receivedTotal: 999 } });
  await prisma.platformAccount.create({ data: { balance: 50 } });

  const forbid = await app.inject({ method: 'GET', url: '/api/admin/rpc-supply-policy', headers: { authorization: `Bearer ${await tk(user.id, ['USER'])}` } });
  assert.equal(forbid.statusCode, 403);

  const ok = await app.inject({ method: 'GET', url: '/api/admin/rpc-supply-policy', headers: { authorization: `Bearer ${await tk(auditor.id, ['AUDITOR'])}` } });
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json();
  assert.equal(Number(body.availableRpc), 100);
  assert.equal(Number(body.lockedRpc), 20);
  assert.equal(Number(body.pendingWithdrawalRpc), 5);
  assert.equal(Number(body.treasuryRpc), 300);
  assert.equal(Number(body.brokerRpc), 40);
  assert.equal(Number(body.platformRpc), 50);
  assert.equal(Number(body.companyRevenueRpc), 0);
});
