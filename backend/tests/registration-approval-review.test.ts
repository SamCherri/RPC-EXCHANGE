import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { replaceActiveRegistrationEvidence } from '../src/services/registration-evidence-service.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const evidenceInput = { fileName: 'suncity.png', mimeType: 'image/png' as const, dataBase64: pngBase64 };

async function resetDb() {
  await prisma.$transaction([
    prisma.profileChangeRequest.deleteMany(),
    prisma.registrationEvidence.deleteMany(),
    prisma.userPermission.deleteMany(),
    prisma.rpcLimitOrder.deleteMany(),
    prisma.rpcExchangeTrade.deleteMany(),
    prisma.trade.deleteMany(),
    prisma.marketOrder.deleteMany(),
    prisma.companyHolding.deleteMany(),
    prisma.companyInitialOffer.deleteMany(),
    prisma.companyRevenueAccount.deleteMany(),
    prisma.company.deleteMany(),
    prisma.coinTransfer.deleteMany(),
    prisma.transaction.deleteMany(),
    prisma.withdrawalRequest.deleteMany(),
    prisma.adminLog.deleteMany(),
    prisma.brokerAccount.deleteMany(),
    prisma.wallet.deleteMany(),
    prisma.userRole.deleteMany(),
    prisma.role.deleteMany(),
    prisma.user.deleteMany(),
    prisma.platformAccount.deleteMany(),
    prisma.treasuryAccount.deleteMany(),
  ]);
}

async function mkRole(key: string) {
  return prisma.role.create({ data: { key, name: key } });
}

async function mkUser(discord: string, roles: string[] = ['USER'], approvalStatus: 'PENDING' | 'CORRECTION_REQUIRED' | 'APPROVED' = 'PENDING') {
  const user = await prisma.user.create({
    data: {
      name: `Usuário ${discord}`,
      characterName: `Personagem ${discord}`,
      discord,
      gamePhone: `555-${discord}`,
      passwordHash: await bcrypt.hash('12345678', 10),
      approvalStatus,
      approvalReason: approvalStatus === 'CORRECTION_REQUIRED' ? 'Corrigir comprovante.' : 'Aguardando análise.',
      wallet: { create: {} },
    },
  });

  for (const roleKey of roles) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }

  return user;
}

function authToken(userId: string, roles: string[]) {
  return app.jwt.sign({ sub: userId, roles });
}

test.before(async () => { await app.ready(); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('admin visualiza evidência autenticado e usuário comum não acessa evidência de outro usuário', async () => {
  await resetDb();
  await Promise.all([mkRole('USER'), mkRole('ADMIN')]);
  const owner = await mkUser('dono');
  const intruder = await mkUser('intruso');
  const admin = await mkUser('admin-reviewer', ['ADMIN']);
  const evidence = await replaceActiveRegistrationEvidence(owner.id, evidenceInput);

  const forbidden = await app.inject({
    method: 'GET',
    url: `/api/auth/registration-evidence/${evidence.id}`,
    headers: { authorization: `Bearer ${authToken(intruder.id, ['USER'])}` },
  });
  assert.equal(forbidden.statusCode, 403);

  const ok = await app.inject({
    method: 'GET',
    url: `/api/auth/registration-evidence/${evidence.id}`,
    headers: { authorization: `Bearer ${authToken(admin.id, ['ADMIN'])}` },
  });
  assert.equal(ok.statusCode, 200);
  assert.match(String(ok.headers['content-type']), /image\/png/);

  const adminLog = await prisma.adminLog.findFirst({ where: { userId: admin.id, action: 'VIEW_REGISTRATION_EVIDENCE', entity: 'RegistrationEvidence' } });
  assert.ok(adminLog);
});

test('usuário reenvia o mesmo screenshot em correção sem violar storageKey único nem duplicar evidência', async () => {
  await resetDb();
  await mkRole('USER');
  const user = await mkUser('reenviador', ['USER'], 'CORRECTION_REQUIRED');
  const firstEvidence = await replaceActiveRegistrationEvidence(user.id, evidenceInput);

  const response = await app.inject({
    method: 'PUT',
    url: '/api/auth/registration-resubmit',
    headers: { authorization: `Bearer ${authToken(user.id, ['USER'])}` },
    payload: {
      name: 'Usuário Reenviado',
      characterName: 'Personagem Reenviado',
      discord: 'reenviador',
      gamePhone: '555-reenviador',
      evidence: evidenceInput,
    },
  });

  assert.equal(response.statusCode, 200);
  const evidences = await prisma.registrationEvidence.findMany({ where: { userId: user.id } });
  assert.equal(evidences.length, 1);
  assert.equal(evidences[0].id, firstEvidence.id);
  assert.equal(evidences[0].status, 'ACTIVE');
  assert.equal(evidences[0].replacedAt, null);

  const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(reloaded.approvalStatus, 'PENDING');
});
