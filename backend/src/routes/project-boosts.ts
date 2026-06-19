import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ADMIN_ROLES } from '../lib/roles.js';

type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };

const OWNER_SOURCES = ['PERSONAL_WALLET', 'PROJECT_REVENUE'] as const;
const ADMIN_SOURCES = ['ADMIN_ADJUSTMENT', 'PROJECT_REVENUE'] as const;

const isAdmin = (roles: string[]) => ADMIN_ROLES.some((role) => roles.includes(role));
const activeOnly = (status: string) => status === 'ACTIVE';

export async function projectBoostRoutes(app: FastifyInstance) {
  app.get('/project-boosts/my-projects', { preHandler: [app.authenticate] }, async (request) => {
    const auth = request as AuthRequest;
    const companies = await prisma.company.findMany({ where: { founderUserId: auth.user.sub, status: 'ACTIVE' }, include: { boostAccount: true, revenueAccount: true } });
    return { companies };
  });

  app.get('/project-boosts/companies/:companyId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const auth = request as AuthRequest;
    const { companyId } = request.params as { companyId: string };
    const accessProbe = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { founderUserId: true } });
    const canBoost = accessProbe.founderUserId === auth.user.sub || isAdmin(auth.user.roles ?? []);
    if (!canBoost) return reply.code(403).send({ message: 'Sem permissão para visualizar impulsões deste projeto.' });

    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, include: { boostAccount: true, revenueAccount: true, boostInjections: { orderBy: { createdAt: 'desc' }, take: 50 } } });
    return { company, canBoost };
  });

  app.post('/project-boosts/companies/:companyId/boost', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const auth = request as AuthRequest;
    const { companyId } = request.params as { companyId: string };
    const body = z.object({ amountRpc: z.coerce.number().positive(), source: z.enum(OWNER_SOURCES), reason: z.string().min(3) }).parse(request.body);

    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { founderUserId: true, status: true } });
    if (company.founderUserId !== auth.user.sub) return reply.code(403).send({ message: 'Você só pode impulsionar seu próprio projeto.' });
    if (!activeOnly(company.status)) return reply.code(400).send({ message: 'A moeda precisa estar ACTIVE para impulsão.' });

    const result = await boostCompany({ tx: prisma, companyId, actorUserId: auth.user.sub, amountRpc: body.amountRpc, source: body.source, reason: body.reason, ip: request.ip, userAgent: request.headers['user-agent'] ?? null, enforceOwner: true });
    return { message: 'Moeda impulsionada com sucesso.', ...result };
  });

  app.get('/admin/project-boosts', { preHandler: [app.authenticate] }, async (request, reply) => {
    const auth = request as AuthRequest;
    const roles = auth.user.roles ?? [];
    if (!isAdmin(roles)) return reply.code(403).send({ message: 'Sem permissão.' });
    const injections = await prisma.companyBoostInjection.findMany({ take: 200, orderBy: { createdAt: 'desc' }, include: { company: { select: { ticker: true, name: true } }, user: { select: { email: true } } } });
    return { injections };
  });

  app.post('/admin/project-boosts/companies/:companyId/boost', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const auth = request as AuthRequest;
    const roles = auth.user.roles ?? [];
    if (!isAdmin(roles)) return reply.code(403).send({ message: 'Sem permissão.' });
    const body = z.object({ amountRpc: z.coerce.number().positive(), source: z.enum(ADMIN_SOURCES).default('ADMIN_ADJUSTMENT'), reason: z.string().min(3) }).parse(request.body);
    const { companyId } = request.params as { companyId: string };
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { status: true } });
    if (!activeOnly(company.status)) return reply.code(400).send({ message: 'A moeda precisa estar ACTIVE para impulsão.' });
    const result = await boostCompany({ tx: prisma, companyId, actorUserId: auth.user.sub, amountRpc: body.amountRpc, source: body.source, reason: body.reason, ip: request.ip, userAgent: request.headers['user-agent'] ?? null, enforceOwner: false });
    return { message: 'Boost administrativo concluído.', ...result };
  });
}

async function boostCompany({ tx, companyId, actorUserId, amountRpc, source, reason, ip, userAgent, enforceOwner }: { tx: typeof prisma; companyId: string; actorUserId: string; amountRpc: number; source: (typeof OWNER_SOURCES)[number] | (typeof ADMIN_SOURCES)[number]; reason: string; ip: string; userAgent: string | null; enforceOwner: boolean }) {
  return tx.$transaction(async (db: Prisma.TransactionClient) => {
    await db.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`;
    const company = await db.company.findUniqueOrThrow({ where: { id: companyId } });
    if (enforceOwner && company.founderUserId !== actorUserId) throw new Error('Você só pode impulsionar seu próprio projeto.');
    if (!activeOnly(company.status)) throw new Error('A moeda precisa estar ACTIVE para impulsão.');

    const amount = new Decimal(amountRpc);
    const priceBefore = new Decimal(company.currentPrice);
    const increase = amount.div(new Decimal(company.totalShares));
    const priceAfter = priceBefore.add(increase).toDecimalPlaces(8);
    if (!priceAfter.greaterThan(priceBefore)) throw new Error('Valor insuficiente para alterar o preço da moeda. Aumente o valor da injeção.');
    const capBefore = new Decimal(company.fictitiousMarketCap);
    const capAfter = priceAfter.mul(company.totalShares).toDecimalPlaces(8);

    if (source === 'PERSONAL_WALLET') {
      const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: actorUserId } });
      if (new Decimal(wallet.availableBalance).lessThan(amount)) throw new Error('Saldo insuficiente na carteira pessoal.');
      await db.wallet.update({ where: { id: wallet.id }, data: { availableBalance: new Decimal(wallet.availableBalance).sub(amount) } });
      await db.transaction.create({ data: { walletId: wallet.id, type: 'PROJECT_BOOST_PERSONAL', amount, description: `Impulsão do projeto ${company.ticker}` } });
    }

    if (source === 'PROJECT_REVENUE') {
      const revenue = await db.companyRevenueAccount.findUniqueOrThrow({ where: { companyId: company.id } });
      if (new Decimal(revenue.balance).lessThan(amount)) throw new Error('Saldo insuficiente na receita do projeto.');
      await db.companyRevenueAccount.update({ where: { id: revenue.id }, data: { balance: new Decimal(revenue.balance).sub(amount), totalUsedForBoost: new Decimal(revenue.totalUsedForBoost).add(amount) } });
    }

    await db.companyBoostAccount.upsert({ where: { companyId: company.id }, create: { companyId: company.id, rpcBalance: amount, totalInjectedRpc: amount }, update: { rpcBalance: { increment: amount }, totalInjectedRpc: { increment: amount } } });
    await db.company.update({ where: { id: company.id }, data: { currentPrice: priceAfter, fictitiousMarketCap: capAfter } });
    await db.companyBoostInjection.create({ data: { companyId: company.id, userId: actorUserId, source: source as any, amountRpc: amount, priceBefore, priceAfter, marketCapBefore: capBefore, marketCapAfter: capAfter, reason } });
    await db.companyOperation.create({ data: { companyId: company.id, userId: actorUserId, type: 'PROJECT_BOOST', unitPrice: priceAfter, grossAmount: amount, totalAmount: amount, description: `Impulsão via ${source}. ${reason}` } });
    await db.adminLog.create({ data: { userId: actorUserId, action: 'PROJECT_BOOST', entity: 'Company', reason, previous: JSON.stringify({ companyId: company.id, priceBefore: priceBefore.toString(), marketCapBefore: capBefore.toString() }), current: JSON.stringify({ source, amount: amount.toString(), priceAfter: priceAfter.toString(), marketCapAfter: capAfter.toString() }), ip, userAgent } });

    return { priceBefore: priceBefore.toString(), priceAfter: priceAfter.toString(), amountRpc: amount.toString(), source };
  });
}
