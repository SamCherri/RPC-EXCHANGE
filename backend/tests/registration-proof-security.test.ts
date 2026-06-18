import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { resetTestDatabase } from './helpers/reset-test-db.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';

const [{ buildApp }, { prisma }, { REGISTRATION_PROOF_MAX_BYTES }] = await Promise.all([
  import('../src/app.js'),
  import('../src/lib/prisma.js'),
  import('../src/services/registration-proof-service.js'),
]);

const VALID_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const VALID_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/ISf/2gAMAwEAAgADAAAAEP/EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z';

const app = buildApp();

test.before(async () => {
  await app.ready();
});

test.after(async () => {
  await app.close().catch(() => undefined);
});

async function resetDb() {
  await resetTestDatabase(prisma);
}

async function mkRole(key: string) {
  return prisma.role.upsert({ where: { key }, update: {}, create: { key, name: key } });
}

async function mkUser(email: string, roles: string[], approvalStatus: 'PENDING' | 'NEEDS_CORRECTION' | 'APPROVED' | 'REJECTED' = 'APPROVED') {
  const user = await prisma.user.create({
    data: {
      email,
      name: email,
      discordId: email.split('@')[0],
      characterName: email.split('@')[0],
      characterPhone: '555-0000',
      approvalStatus,
      passwordHash: await bcrypt.hash('12345678', 10),
      wallet: { create: {} },
    },
  });

  for (const roleKey of roles) {
    const role = await mkRole(roleKey);
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }

  return user;
}

async function tokenFor(discordId: string) {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { discordId, password: '12345678' } });
  assert.equal(login.statusCode, 200, login.body);
  return login.json().token as string;
}

function registerPayload(discordId: string, screenshot = { mimeType: 'image/png', fileName: 'cadastro.png', data: `data:image/png;base64,${VALID_PNG_BASE64}` }) {
  return {
    name: `User ${discordId}`,
    characterName: `Char ${discordId}`,
    discordId,
    characterPhone: '555-0101',
    screenshot,
    password: '12345678',
  };
}

test('aceita imagem PNG válida dentro do limite e grava checksum sem armazenar Data URL', async () => {
  await resetDb();
  await mkRole('USER');

  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: registerPayload('proof-ok') });
  assert.equal(response.statusCode, 201, response.body);

  const user = await prisma.user.findFirstOrThrow({ where: { discordId: 'proof-ok' }, include: { registrationProof: true } });
  assert.equal(user.registrationProof?.mimeType, 'image/png');
  assert.equal(user.registrationProof?.data, VALID_PNG_BASE64);
  assert.ok(user.registrationProof?.checksum);
  assert.equal(user.registrationProof?.data.includes('data:image'), false);
});

test('rejeita payload acima do limite antes da persistência', async () => {
  await resetDb();
  await mkRole('USER');
  const oversized = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(REGISTRATION_PROOF_MAX_BYTES + 1)]).toString('base64');

  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: registerPayload('proof-big', { mimeType: 'image/png', fileName: 'big.png', data: oversized }) });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().message, /limite/);
  assert.equal(await prisma.registrationProof.count(), 0);
});

test('rejeita MIME declarado diferente do conteúdo real', async () => {
  await resetDb();
  await mkRole('USER');

  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: registerPayload('proof-mime-false', { mimeType: 'image/jpeg', fileName: 'falso.jpg', data: `data:image/jpeg;base64,${VALID_PNG_BASE64}` }) });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().message, /MIME declarado/);
});

test('rejeita conteúdo não reconhecido como imagem e arquivo vazio', async () => {
  await resetDb();
  await mkRole('USER');

  const textPayload = Buffer.from('isto nao e imagem').toString('base64');
  const text = await app.inject({ method: 'POST', url: '/api/auth/register', payload: registerPayload('proof-text', { mimeType: 'image/png', fileName: 'texto.png', data: textPayload }) });
  assert.equal(text.statusCode, 400, text.body);
  assert.match(text.json().message, /não foi reconhecido/);

  const empty = await app.inject({ method: 'POST', url: '/api/auth/register', payload: registerPayload('proof-empty', { mimeType: 'image/png', fileName: 'vazio.png', data: 'data:image/png;base64,' }) });
  assert.equal(empty.statusCode, 400, empty.body);
});

test('usuário não acessa evidência de outro usuário nem substitui evidência alheia', async () => {
  await resetDb();
  await mkRole('USER');
  const victim = await mkUser('victim@test.local', ['USER'], 'NEEDS_CORRECTION');
  await prisma.registrationProof.create({ data: { userId: victim.id, mimeType: 'image/png', fileName: 'old.png', data: VALID_PNG_BASE64, checksum: 'old-checksum' } });
  const attacker = await mkUser('attacker@test.local', ['USER'], 'NEEDS_CORRECTION');
  const attackerToken = await tokenFor('attacker');

  const read = await app.inject({ method: 'GET', url: `/api/admin/users/${victim.id}/registration-proof`, headers: { authorization: `Bearer ${attackerToken}` } });
  assert.equal(read.statusCode, 403, read.body);

  const resend = await app.inject({ method: 'PUT', url: '/api/registration/screenshot', headers: { authorization: `Bearer ${attackerToken}` }, payload: { screenshot: { mimeType: 'image/jpeg', fileName: 'novo.jpg', data: `data:image/jpeg;base64,${VALID_JPEG_BASE64}` } } });
  assert.equal(resend.statusCode, 200, resend.body);

  const victimProof = await prisma.registrationProof.findUniqueOrThrow({ where: { userId: victim.id } });
  assert.equal(victimProof.checksum, 'old-checksum');
  const attackerProof = await prisma.registrationProof.findUniqueOrThrow({ where: { userId: attacker.id } });
  assert.equal(attackerProof.mimeType, 'image/jpeg');
});

test('consulta administrativa exige role de revisão e admin autorizado visualiza evidência antiga válida', async () => {
  await resetDb();
  await mkRole('USER');
  const user = await mkUser('pending@test.local', ['USER'], 'PENDING');
  const proof = await prisma.registrationProof.create({ data: { userId: user.id, mimeType: 'image/png', fileName: 'legacy.png', data: VALID_PNG_BASE64, checksum: 'legacy-checksum' } });

  const common = await mkUser('common@test.local', ['USER']);
  const chief = await mkUser('chief@test.local', ['USER', 'COIN_CHIEF_ADMIN']);
  const admin = await mkUser('admin@test.local', ['USER', 'ADMIN']);

  const commonToken = await tokenFor(common.discordId!);
  const chiefToken = await tokenFor(chief.discordId!);
  const adminToken = await tokenFor(admin.discordId!);

  const commonRead = await app.inject({ method: 'GET', url: `/api/admin/registration-proofs/${proof.id}`, headers: { authorization: `Bearer ${commonToken}` } });
  assert.equal(commonRead.statusCode, 403, commonRead.body);

  const chiefRead = await app.inject({ method: 'GET', url: `/api/admin/registration-proofs/${proof.id}`, headers: { authorization: `Bearer ${chiefToken}` } });
  assert.equal(chiefRead.statusCode, 403, chiefRead.body);

  const adminRead = await app.inject({ method: 'GET', url: `/api/admin/registration-proofs/${proof.id}`, headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(adminRead.statusCode, 200, adminRead.body);
  assert.equal(adminRead.headers['content-type'], 'image/png');
  assert.deepEqual((adminRead as unknown as { rawPayload: Buffer }).rawPayload, Buffer.from(VALID_PNG_BASE64, 'base64'));
});

test('aprovação cadastral e bloqueio econômico de usuário não aprovado continuam funcionando', async () => {
  await resetDb();
  await mkRole('USER');
  const user = await mkUser('needs@test.local', ['USER'], 'NEEDS_CORRECTION');
  const admin = await mkUser('reviewer@test.local', ['USER', 'ADMIN']);
  await prisma.registrationProof.create({ data: { userId: user.id, mimeType: 'image/png', fileName: 'proof.png', data: VALID_PNG_BASE64, checksum: 'checksum' } });

  const userToken = await tokenFor(user.discordId!);
  const blockedTrade = await app.inject({ method: 'POST', url: '/api/rpc-market/buy', headers: { authorization: `Bearer ${userToken}` }, payload: { fiatAmount: 10 } });
  assert.equal(blockedTrade.statusCode, 403, blockedTrade.body);

  const adminToken = await tokenFor(admin.discordId!);
  const review = await app.inject({ method: 'PATCH', url: `/api/admin/users/${user.id}/approval`, headers: { authorization: `Bearer ${adminToken}` }, payload: { status: 'APPROVED', note: 'Cadastro conferido' } });
  assert.equal(review.statusCode, 200, review.body);
  assert.equal(review.json().user.approvalStatus, 'APPROVED');
});
