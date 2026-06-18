import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/lib/prisma.js')]);
const app = buildApp();

async function resetDb() {
  await prisma.$transaction([
    prisma.rpcLimitOrder.deleteMany(),
    prisma.rpcExchangeTrade.deleteMany(),
    prisma.rpcMarketState.deleteMany(),
    prisma.feeDistribution.deleteMany(),
    prisma.trade.deleteMany(),
    prisma.marketOrder.deleteMany(),
    prisma.companyOperation.deleteMany(),
    prisma.companyHolding.deleteMany(),
    prisma.companyInitialOffer.deleteMany(),
    prisma.companyRevenueAccount.deleteMany(),
    prisma.companyBoostInjection.deleteMany(),
    prisma.companyBoostAccount.deleteMany(),
    prisma.company.deleteMany(),
    prisma.coinTransfer.deleteMany(),
    prisma.coinIssuance.deleteMany(),
    prisma.transaction.deleteMany(),
    prisma.withdrawalRequest.deleteMany(),
    prisma.adminLog.deleteMany(),
    prisma.brokerAccount.deleteMany(),
    prisma.wallet.deleteMany(),
    prisma.userFinancialPermission.deleteMany(),
    prisma.userRole.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.testModeReport.deleteMany(),
    prisma.testModeTrade.deleteMany(),
    prisma.testModeWallet.deleteMany(),
    prisma.testModeMarketState.deleteMany(),
    prisma.systemModeConfig.deleteMany(),
    prisma.user.deleteMany(),
    prisma.platformAccount.deleteMany(),
    prisma.treasuryAccount.deleteMany(),
  ]);
}

async function grantProjectCreatePermission(userId: string) {
  await prisma.userFinancialPermission.create({
    data: {
      userId,
      permission: 'PROJECT_CREATE',
      grantedById: userId,
      reason: 'Permissão PROJECT_CREATE em fixture de teste de moderação',
    },
  });
}

async function mkUser(email: string) {
  const user = await prisma.user.create({ data: { email, name: email, approvalStatus: 'APPROVED', passwordHash: await bcrypt.hash('12345678', 10), wallet: { create: {} } } });
  await grantProjectCreatePermission(user.id);
  return user;
}
async function token(userId: string, roles: string[] = ['USER']) { return app.jwt.sign({ sub: userId, roles }); }

const validPayload = { name: 'Projeto Aurora', ticker: 'AURRP', sector: 'tech', description: 'Projeto legitimo sem links.', totalShares: 1000, initialPrice: 1, ownerSharePercent: 40, publicOfferPercent: 60, buyFeePercent: 1, sellFeePercent: 1 };

test.before(async () => { await app.ready(); });
test.after(async () => { await app.close(); await prisma.$disconnect(); });

test('bloqueia ticker reservado e parecidos', async () => {
  await resetDb(); const user = await mkUser('u1@test.local'); const tk = await token(user.id);
  for (const ticker of ['RPC', 'ADMIN', 'BANCO', 'EXCHANGE', 'ADM', 'BROKER']) {
    const res = await app.inject({ method: 'POST', url: '/api/companies/request', headers: { authorization: `Bearer ${tk}` }, payload: { ...validPayload, ticker, name: `Empresa ${ticker}` } });
    assert.equal(res.statusCode, 400); assert.match(res.body, /Ticker reservado/);
  }
});

test('bloqueia nome parecido com oficial', async () => {
  await resetDb(); const user = await mkUser('u2@test.local'); const tk = await token(user.id);
  for (const name of ['Banco Oficial','Admin Exchange','Corretor Oficial']) {
    const res = await app.inject({ method: 'POST', url: '/api/companies/request', headers: { authorization: `Bearer ${tk}` }, payload: { ...validPayload, ticker: `TST${name.length}`, name } });
    assert.equal(res.statusCode, 400); assert.match(res.body, /Nome reservado ou parecido com autoridade oficial/);
  }
});

test('bloqueia links e palavras proibidas em descrição', async () => {
  await resetDb(); const user = await mkUser('u3@test.local'); const tk = await token(user.id);
  const linkRes = await app.inject({ method: 'POST', url: '/api/companies/request', headers: { authorization: `Bearer ${tk}` }, payload: { ...validPayload, ticker: 'LINK1', description: 'acesse https://site.com' } });
  assert.equal(linkRes.statusCode, 400); assert.match(linkRes.body, /Descrições não podem conter links externos/);
  const linkRes2 = await app.inject({ method: 'POST', url: '/api/companies/request', headers: { authorization: `Bearer ${tk}` }, payload: { ...validPayload, ticker: 'LINK2', description: 'entre no discord.gg/abc' } });
  assert.equal(linkRes2.statusCode, 400);
  const badWord = await app.inject({ method: 'POST', url: '/api/companies/request', headers: { authorization: `Bearer ${tk}` }, payload: { ...validPayload, ticker: 'SAFE1', description: 'projeto de phishing' } });
  assert.equal(badWord.statusCode, 400); assert.match(badWord.body, /Descrição contém termo não permitido/);
});

test('permite projeto normal e reforça para usuário comum', async () => {
  await resetDb(); const user = await mkUser('u4@test.local'); const tk = await token(user.id, ['USER']);
  const ok = await app.inject({ method: 'POST', url: '/api/companies/request', headers: { authorization: `Bearer ${tk}` }, payload: validPayload });
  assert.equal(ok.statusCode, 201, ok.body);
});

test('Discord único no cadastro ignora diferença de maiúsculas e minúsculas', async () => {
  await resetDb();
  await prisma.role.create({ data: { key: 'USER', name: 'Usuário' } });

  const screenshot = { mimeType: 'image/png', fileName: 'cadastro.png', data: 'data:image/png;base64,aW1hZ2VtLWRlLXRlc3Rl' };
  const first = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'User One', characterName: 'Cidadao Um', discordId: 'Discord.Cad.1', characterPhone: '555-0201', screenshot, password: '12345678' } });
  assert.equal(first.statusCode, 201, first.body);

  const second = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'User Two', characterName: 'Cidadao Dois', discordId: 'discord.cad.1', characterPhone: '555-0202', screenshot, password: '12345678' } });
  assert.equal(second.statusCode, 400);
  assert.match(second.body, /Discord já cadastrado/);
});
