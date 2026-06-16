import test from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL é obrigatório para testes de integração.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const [{ buildApp }, { prisma }] = await Promise.all([
  import('../src/app.js'),
  import('../src/lib/prisma.js'),
]);

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
    prisma.userRole.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.testModeReport.deleteMany(),
    prisma.testModeTrade.deleteMany(),
    prisma.testModeWallet.deleteMany(),
    prisma.testModeMarketState.deleteMany(),
    prisma.user.deleteMany(),
    prisma.platformAccount.deleteMany(),
    prisma.treasuryAccount.deleteMany(),
  ]);
}

test('JWT_SECRET obrigatório em produção', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwt = process.env.JWT_SECRET;
  const originalWeb = process.env.WEB_ORIGIN;
  let app: ReturnType<typeof buildApp> | null = null;
  try {
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'https://example.com';
    delete process.env.JWT_SECRET;
    app = buildApp();
    await assert.rejects(() => app.ready(), /JWT_SECRET é obrigatório em produção/);
  } finally {
    if (app) await app.close().catch(() => undefined);
    process.env.NODE_ENV = originalNodeEnv;
    process.env.JWT_SECRET = originalJwt;
    process.env.WEB_ORIGIN = originalWeb;
  }
});

test('WEB_ORIGIN obrigatório em produção', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwt = process.env.JWT_SECRET;
  const originalWeb = process.env.WEB_ORIGIN;
  try {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'secret';
    process.env.WEB_ORIGIN = '   ';
    assert.throws(() => buildApp(), /WEB_ORIGIN é obrigatório em produção/);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.JWT_SECRET = originalJwt;
    process.env.WEB_ORIGIN = originalWeb;
  }
});

test('login inválido bloqueia temporariamente e login válido zera contador', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const app = buildApp();
  try {
    await app.ready();
    await resetDb();

    const role = await prisma.role.create({ data: { key: 'USER', name: 'USER' } });
    const ok = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'User Teste', characterName: 'Personagem', bankAccountNumber: '12345', discordId: 'discord-lock', characterPhone: '555-0100', screenshot: { mimeType: 'image/png', fileName: 'cadastro.png', data: 'data:image/png;base64,aW1hZ2VtLWRlLXRlc3Rl' }, email: 'lock@test.local', password: '12345678' } });
    assert.equal(ok.statusCode, 201, ok.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'lock@test.local' } });
    assert.equal(role.key, 'USER');

    for (let i = 0; i < 4; i++) {
      const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lock@test.local', password: 'senha-errada' } });
      assert.equal(bad.statusCode, 401);
      assert.equal(bad.json().message, 'Credenciais inválidas.');
    }

    const locked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lock@test.local', password: 'senha-errada' } });
    assert.equal(locked.statusCode, 401);
    assert.equal(locked.json().message, 'Muitas tentativas inválidas. Tente novamente mais tarde.');

    const unlockedNow = await prisma.user.update({ where: { id: user.id }, data: { loginLockedUntil: new Date(Date.now() - 1000) } });
    assert.ok(unlockedNow);

    const success = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lock@test.local', password: '12345678' } });
    assert.equal(success.statusCode, 200, success.body);

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(refreshed.failedLoginAttempts, 0);
    assert.equal(refreshed.loginLockedUntil, null);
  } finally {
    await app.close().catch(() => undefined);
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('rate limit retorna 429 em endpoint sensível', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwt = process.env.JWT_SECRET;
  const originalWeb = process.env.WEB_ORIGIN;
  process.env.NODE_ENV = 'development';
  const app = buildApp();
  try {
    await app.ready();
    let limitedResponse: Awaited<ReturnType<typeof app.inject>> | null = null;
    for (let i = 0; i < 12; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'nao-existe@test.local', password: '12345678' },
      });
      if (response.statusCode === 429) {
        limitedResponse = response;
        break;
      }
    }
    assert.ok(limitedResponse, 'Esperava receber HTTP 429 após excesso de tentativas.');
    const limitedBody = limitedResponse!.json() as { statusCode?: number; error?: string; message?: string };
    assert.equal(limitedResponse!.statusCode, 429);
    assert.equal(limitedBody.message, 'Muitas tentativas. Aguarde alguns instantes e tente novamente.');
    assert.equal(limitedBody.statusCode, 429);
    assert.equal(limitedBody.error, 'Too Many Requests');
  } finally {
    await app.close().catch(() => undefined);
    process.env.NODE_ENV = originalNodeEnv;
    process.env.JWT_SECRET = originalJwt;
    process.env.WEB_ORIGIN = originalWeb;
  }
});
