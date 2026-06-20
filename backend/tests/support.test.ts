import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { resetTestDatabase } from './helpers/reset-test-db.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();
const token = (userId: string, roles: string[]) => app.jwt.sign({ sub: userId, roles });
async function mkUser(email: string, role: string) { const r = await prisma.role.upsert({ where:{key:role}, update:{}, create:{key:role,name:role} }); const u = await prisma.user.create({ data: { email, name: email, passwordHash: await bcrypt.hash('123456', 10), wallet:{create:{}}, roles:{create:{roleId:r.id}} } }); return u; }

test.before(async () => { await app.ready(); await resetTestDatabase(prisma); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('suporte privado, permissões, anexos, rate limit e exportação segura', async () => {
  await resetTestDatabase(prisma);
  const user = await mkUser('user@support.local','USER');
  const other = await mkUser('other@support.local','USER');
  const admin = await mkUser('admin@support.local','ADMIN');
  const developer = await mkUser('dev@support.local','DEVELOPER');
  const beforeWallet = await prisma.wallet.findUnique({ where:{userId:user.id} });

  const unauth = await app.inject({ method:'POST', url:'/api/support/tickets', payload:{ category:'BUG', title:'Bug teste', message:'Mensagem suficientemente grande' } });
  assert.equal(unauth.statusCode, 401);

  const created = await app.inject({ method:'POST', url:'/api/support/tickets', headers:{authorization:`Bearer ${token(user.id,['USER'])}`}, payload:{ category:'BUG', title:'Bug no painel', message:'Algo quebrou na tela de carteira.', screen:'Carteira', platform:'Chrome' } });
  assert.equal(created.statusCode, 201);
  const id = created.json().ticket.id;

  const mine = await app.inject({ method:'GET', url:'/api/support/my-tickets', headers:{authorization:`Bearer ${token(user.id,['USER'])}`} });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().tickets.length, 1);
  const otherTry = await app.inject({ method:'GET', url:`/api/support/my-tickets/${id}`, headers:{authorization:`Bearer ${token(other.id,['USER'])}`} });
  assert.equal(otherTry.statusCode, 404);

  const allAdmin = await app.inject({ method:'GET', url:'/api/admin/support/tickets', headers:{authorization:`Bearer ${token(admin.id,['ADMIN'])}`} });
  assert.equal(allAdmin.statusCode, 200);
  const allDev = await app.inject({ method:'GET', url:'/api/admin/support/tickets', headers:{authorization:`Bearer ${token(developer.id,['DEVELOPER'])}`} });
  assert.equal(allDev.statusCode, 200);
  const forbidden = await app.inject({ method:'GET', url:'/api/admin/support/tickets', headers:{authorization:`Bearer ${token(user.id,['USER'])}`} });
  assert.equal(forbidden.statusCode, 403);

  const invalidMime = await app.inject({ method:'POST', url:'/api/support/tickets', headers:{authorization:`Bearer ${token(user.id,['USER'])}`}, payload:{ category:'BUG', title:'Arquivo inválido', message:'Testando arquivo inválido.', screenshot:{ mimeType:'text/plain', fileName:'x.txt', data: Buffer.from('payload-pequeno').toString('base64') } } });
  assert.equal(invalidMime.statusCode, 400);
  const big = await app.inject({ method:'POST', url:'/api/support/tickets', headers:{authorization:`Bearer ${token(user.id,['USER'])}`}, payload:{ category:'BUG', title:'Arquivo grande', message:'Testando arquivo grande.', screenshot:{ mimeType:'image/png', fileName:'x.png', data: Buffer.alloc(2*1024*1024+1).toString('base64') } } });
  assert.equal(big.statusCode, 413);

  for (let i=0;i<5;i++) await app.inject({ method:'POST', url:'/api/support/tickets', headers:{authorization:`Bearer ${token(other.id,['USER'])}`}, payload:{ category:'QUESTION', title:`Spam ${i} teste`, message:'Mensagem válida para testar limite.' } });
  const limited = await app.inject({ method:'POST', url:'/api/support/tickets', headers:{authorization:`Bearer ${token(other.id,['USER'])}`}, payload:{ category:'QUESTION', title:'Spam final', message:'Mensagem válida para testar limite.' } });
  assert.equal(limited.statusCode, 429);

  const patch = await app.inject({ method:'PATCH', url:`/api/admin/support/tickets/${id}`, headers:{authorization:`Bearer ${token(admin.id,['ADMIN'])}`}, payload:{ status:'IN_REVIEW', internalPriority:'HIGH', internalNote:'Triar sem mexer em economia', response:'Recebemos seu chamado.' } });
  assert.equal(patch.statusCode, 200);

  const exportMd = await app.inject({ method:'GET', url:'/api/admin/support/tickets/export/codex', headers:{authorization:`Bearer ${token(developer.id,['DEVELOPER'])}`} });
  assert.equal(exportMd.statusCode, 200);
  assert.match(exportMd.body, /Resumo por categoria/);
  assert.equal(exportMd.body.includes('passwordHash'), false);
  assert.equal(exportMd.body.includes('user@support.local'), false);

  const afterWallet = await prisma.wallet.findUnique({ where:{userId:user.id} });
  assert.deepEqual(JSON.stringify(afterWallet), JSON.stringify(beforeWallet));
});
