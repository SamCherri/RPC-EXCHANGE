import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { escapeCsvValue } from '../src/services/csv-export-service.js';
import { resetTestDatabase } from './helpers/reset-test-db.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();

async function resetDb() {
  await resetTestDatabase(prisma);
}
const mkRole = (key: string) => prisma.role.create({ data: { key, name: key } });
async function mkUser(email: string) { return prisma.user.create({ data: { email, name: email, passwordHash: await bcrypt.hash('123456', 10), wallet: { create: {} } } }); }
const token = (userId: string, roles: string[]) => app.jwt.sign({ sub: userId, roles });

test.before(async () => { await app.ready(); await resetDb(); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('admin reports permissão e payload', async () => {
  await resetDb();
  const [rUser, rAuditor, rBroker] = await Promise.all([mkRole('USER'), mkRole('AUDITOR'), mkRole('VIRTUAL_BROKER')]);
  const [user, auditor, broker] = await Promise.all([mkUser('user@t.local'), mkUser('auditor@t.local'), mkUser('broker@t.local')]);
  await prisma.userRole.createMany({ data: [{ userId: user.id, roleId: rUser.id }, { userId: auditor.id, roleId: rAuditor.id }, { userId: broker.id, roleId: rBroker.id }] });

  const forbidden = await app.inject({ method: 'GET', url: `/api/admin/reports/users/${user.id}`, headers: { authorization: `Bearer ${token(user.id, ['USER'])}` } });
  assert.equal(forbidden.statusCode, 403);

  const ok = await app.inject({ method: 'GET', url: `/api/admin/reports/users/${user.id}`, headers: { authorization: `Bearer ${token(auditor.id, ['AUDITOR'])}` } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.includes('passwordHash'), false);

  const missingUser = await app.inject({ method: 'GET', url: '/api/admin/reports/users/inexistente', headers: { authorization: `Bearer ${token(auditor.id, ['AUDITOR'])}` } });
  assert.equal(missingUser.statusCode, 404);

  const missingBroker = await app.inject({ method: 'GET', url: '/api/admin/reports/brokers/inexistente', headers: { authorization: `Bearer ${token(auditor.id, ['AUDITOR'])}` } });
  assert.equal(missingBroker.statusCode, 404);

  const brokerOk = await app.inject({ method: 'GET', url: `/api/admin/reports/brokers/${broker.id}`, headers: { authorization: `Bearer ${token(auditor.id, ['AUDITOR'])}` } });
  assert.equal(brokerOk.statusCode, 200);
  assert.ok(brokerOk.body.includes('broker'));

  const brokerCsvOk = await app.inject({ method: 'GET', url: `/api/admin/reports/brokers/${broker.id}.csv`, headers: { authorization: `Bearer ${token(auditor.id, ['AUDITOR'])}` } });
  assert.equal(brokerCsvOk.statusCode, 200);
  assert.match(String(brokerCsvOk.headers['content-type']), /text\/csv/);
});

test('csv admin logs permissão e content-type + escape', async () => {
  await resetDb();
  const [rUser, rAuditor] = await Promise.all([mkRole('USER'), mkRole('AUDITOR')]);
  const [user, auditor] = await Promise.all([mkUser('user2@t.local'), mkUser('auditor2@t.local')]);
  await prisma.userRole.createMany({ data: [{ userId: user.id, roleId: rUser.id }, { userId: auditor.id, roleId: rAuditor.id }] });
  await prisma.adminLog.create({ data: { userId: auditor.id, action: 'X', entity: 'Y', reason: 'campo, "valor"' } });

  const forbidden = await app.inject({ method: 'GET', url: '/api/admin/reports/admin-logs.csv', headers: { authorization: `Bearer ${token(user.id, ['USER'])}` } });
  assert.equal(forbidden.statusCode, 403);

  const ok = await app.inject({ method: 'GET', url: '/api/admin/reports/admin-logs.csv', headers: { authorization: `Bearer ${token(auditor.id, ['AUDITOR'])}` } });
  assert.equal(ok.statusCode, 200);
  assert.match(String(ok.headers['content-type']), /text\/csv/);
  assert.equal(escapeCsvValue('a,"b"'), '"a,""b"""');
});
