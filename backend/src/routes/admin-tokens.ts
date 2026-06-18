import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { cancelOrderWithRelease } from './market.js';
import { validateDescriptionAllowed, validatePublicNameAllowed, validateTickerAllowed } from '../services/content-moderation-service.js';

type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };
const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN', 'COIN_CHIEF_ADMIN'] as const;
const FORCE_DELETE_CONFIRMATION = 'EXCLUIR DEFINITIVAMENTE';

function normalizeForceDeleteConfirmation(value: string) {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}


function ensureAdmin(reply: FastifyReply, roles: string[]) {
  if (!ADMIN_ROLES.some((role) => roles.includes(role))) {
    reply.code(403).send({ message: 'Sem permissão administrativa.' });
    return false;
  }

  return true;
}

function splitShares(totalTokens: number, ownerPercent: number) {
  const ownerShares = Math.floor((totalTokens * ownerPercent) / 100);
  const publicOfferShares = totalTokens - ownerShares;
  return { ownerShares, publicOfferShares };
}



function isSuperAdmin(roles: string[]) {
  return roles.includes('SUPER_ADMIN');
}

async function getCompanyDeleteCounts(companyId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const [holdings, operations, initialOffer, marketOrders, trades, feeDistributions, capitalFlowEntries, revenueAccounts, boostAccounts, boostInjections] = await Promise.all([
    tx.companyHolding.count({ where: { companyId } }),
    tx.companyOperation.count({ where: { companyId } }),
    tx.companyInitialOffer.count({ where: { companyId } }),
    tx.marketOrder.count({ where: { companyId } }),
    tx.trade.count({ where: { companyId } }),
    tx.feeDistribution.count({ where: { companyId } }),
    tx.companyCapitalFlowEntry.count({ where: { companyId } }),
    tx.companyRevenueAccount.count({ where: { companyId } }),
    tx.companyBoostAccount.count({ where: { companyId } }),
    tx.companyBoostInjection.count({ where: { companyId } }),
  ]);

  return { holdings, operations, initialOffer, marketOrders, trades, feeDistributions, capitalFlowEntries, revenueAccounts, boostAccounts, boostInjections };
}

function hasEconomicHistory(company: {
  trades: number;
  orders: number;
  holdingsWithShares: number;
  feeDistributions: number;
  capitalFlowEntries: number;
  revenueBalance: Decimal;
  revenueFees: Decimal;
  economicOps: number;
  initialOfferMoved: boolean;
}) {
  return company.trades > 0
    || company.orders > 0
    || company.holdingsWithShares > 0
    || company.feeDistributions > 0
    || company.capitalFlowEntries > 0
    || company.revenueBalance.greaterThan(0)
    || company.revenueFees.greaterThan(0)
    || company.economicOps > 0
    || company.initialOfferMoved;
}

export async function adminTokensRoutes(app: FastifyInstance) {
  app.get('/tokens', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, roles)) return;

    const query = z.object({
      status: z.string().optional(),
      search: z.string().optional(),
      founderUserId: z.string().optional(),
    }).parse(request.query);

    const companies = await prisma.company.findMany({
      where: {
        ...(query.status ? { status: query.status as never } : {}),
        ...(query.founderUserId ? { founderUserId: query.founderUserId } : {}),
        ...(query.search ? {
          OR: [
            { ticker: { contains: query.search, mode: 'insensitive' } },
            { name: { contains: query.search, mode: 'insensitive' } },
          ],
        } : {}),
      },
      include: {
        founder: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });

    return {
      tokens: companies.map((company: { id: string; name: string; ticker: string; sector: string; status: string; founder: { id: string; name: string | null; email: string } | null; currentPrice: unknown; totalShares: number; availableOfferShares: number; createdAt: Date; approvedAt: Date | null; suspendedAt: Date | null }) => ({
        id: company.id,
        name: company.name,
        ticker: company.ticker,
        sector: company.sector,
        status: company.status,
        founder: company.founder,
        currentPrice: company.currentPrice,
        totalTokens: company.totalShares,
        availableTokens: company.availableOfferShares,
        createdAt: company.createdAt,
        approvedAt: company.approvedAt,
        suspendedAt: company.suspendedAt,
      })),
    };
  });

  app.post('/tokens', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, roles)) return;

    try {
      const body = z.object({
        founderEmail: z.string().email().optional(),
        founderUserId: z.string().min(1).optional(),
        name: z.string().min(3),
        ticker: z.string().min(2).max(10),
        description: z.string().min(5),
        sector: z.string().min(2),
        totalTokens: z.coerce.number().int().positive(),
        ownerSharePercent: z.coerce.number().min(0),
        publicOfferPercent: z.coerce.number().min(0),
        initialPrice: z.coerce.number().positive(),
        buyFeePercent: z.coerce.number().min(0),
        sellFeePercent: z.coerce.number().min(0),
      }).parse(request.body);

      validateTickerAllowed(body.ticker);
      validatePublicNameAllowed(body.name, 'company');
      validateDescriptionAllowed(body.description);

      const ticker = body.ticker.trim().toUpperCase();
      if (Math.abs((body.ownerSharePercent + body.publicOfferPercent) - 100) > 0.001) {
        throw new Error('Percentuais do criador e lançamento devem somar 100%.');
      }

      const normalizedFounderEmail = body.founderEmail?.trim().toLowerCase();
      const founder = normalizedFounderEmail
        ? await prisma.user.findUnique({ where: { email: normalizedFounderEmail } })
        : (body.founderUserId ? await prisma.user.findUnique({ where: { id: body.founderUserId } }) : null);
      const founderUserId = founder?.id ?? body.founderUserId;

      const [tickerExists, ownerRole] = await Promise.all([
        prisma.company.findUnique({ where: { ticker } }),
        prisma.role.findUnique({ where: { key: 'BUSINESS_OWNER' } }),
      ]);

      if (tickerExists) return reply.code(409).send({ message: 'Ticker já está em uso.' });
      if (!founder || !founderUserId) return reply.code(404).send({ message: 'Usuário dono do projeto não encontrado pelo e-mail informado.' });
      if (!ownerRole) return reply.code(400).send({ message: 'Role BUSINESS_OWNER não encontrada.' });

      const initialPrice = new Decimal(body.initialPrice);
      const { ownerShares, publicOfferShares } = splitShares(body.totalTokens, body.ownerSharePercent);

      const company = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.company.create({
          data: {
            name: body.name.trim(),
            ticker,
            description: body.description.trim(),
            sector: body.sector.trim(),
            founderUserId,
            status: 'ACTIVE',
            totalShares: body.totalTokens,
            circulatingShares: 0,
            ownerSharePercent: new Decimal(body.ownerSharePercent),
            publicOfferPercent: new Decimal(body.publicOfferPercent),
            ownerShares,
            publicOfferShares,
            availableOfferShares: publicOfferShares,
            initialPrice,
            currentPrice: initialPrice,
            buyFeePercent: new Decimal(body.buyFeePercent),
            sellFeePercent: new Decimal(body.sellFeePercent),
            fictitiousMarketCap: initialPrice.mul(body.totalTokens),
            approvedAt: new Date(),
          },
        });

        await tx.companyHolding.upsert({
          where: { userId_companyId: { userId: founderUserId, companyId: created.id } },
          update: {
            shares: ownerShares,
            averageBuyPrice: initialPrice,
            estimatedValue: initialPrice.mul(ownerShares),
          },
          create: {
            userId: founderUserId,
            companyId: created.id,
            shares: ownerShares,
            averageBuyPrice: initialPrice,
            estimatedValue: initialPrice.mul(ownerShares),
          },
        });

        await tx.companyInitialOffer.create({
          data: {
            companyId: created.id,
            totalShares: publicOfferShares,
            availableShares: publicOfferShares,
          },
        });

        await tx.companyRevenueAccount.create({ data: { companyId: created.id } });

        await tx.userRole.upsert({
          where: { userId_roleId: { userId: founderUserId, roleId: ownerRole.id } },
          update: {},
          create: { userId: founderUserId, roleId: ownerRole.id },
        });

        await tx.companyOperation.create({
          data: {
            companyId: created.id,
            userId: authRequest.user.sub,
            type: 'ADMIN_APPROVE',
            description: 'Token/projeto criado manualmente por administrador.',
          },
        });

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'ADMIN_TOKEN_CREATED',
            entity: `Company:${created.id}`,
            reason: 'Criação manual de token/projeto.',
            current: JSON.stringify({
              ticker: created.ticker,
              founderUserId: created.founderUserId,
              founderEmail: founder.email,
              totalTokens: created.totalShares,
            }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });

        return created;
      });

      return reply.code(201).send({ token: company });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.patch('/tokens/:id/owner', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, roles)) return;

    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const body = z.object({ founderRef: z.string().min(1).optional(), founderEmail: z.string().email().optional(), founderUserId: z.string().min(1).optional(), reason: z.string().min(2) }).parse(request.body);

      const founderRef = body.founderRef?.trim();
      const normalizedFounderEmail = body.founderEmail?.trim().toLowerCase() ?? (founderRef?.includes('@') ? founderRef.toLowerCase() : undefined);
      const founderUserId = body.founderUserId ?? (founderRef && !founderRef.includes('@') ? founderRef : undefined);
      const nextOwner = normalizedFounderEmail
        ? await prisma.user.findUnique({ where: { email: normalizedFounderEmail } })
        : (founderUserId ? await prisma.user.findUnique({ where: { id: founderUserId } }) : null);

      const [company, ownerRole] = await Promise.all([
        prisma.company.findUnique({ where: { id } }),
        prisma.role.findUnique({ where: { key: 'BUSINESS_OWNER' } }),
      ]);

      if (!company) return reply.code(404).send({ message: 'Mercado não encontrado.' });
      if (!ownerRole) return reply.code(400).send({ message: 'Role BUSINESS_OWNER não encontrada.' });
      if (!nextOwner) return reply.code(404).send({ message: 'Novo dono não encontrado pelo e-mail informado.' });

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.company.update({ where: { id }, data: { founderUserId: nextOwner.id } });
        await tx.userRole.upsert({
          where: { userId_roleId: { userId: nextOwner.id, roleId: ownerRole.id } },
          update: {},
          create: { userId: nextOwner.id, roleId: ownerRole.id },
        });

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'ADMIN_TOKEN_OWNER_UPDATED',
            entity: `Company:${company.id}`,
            reason: body.reason,
            previous: JSON.stringify({ founderUserId: company.founderUserId }),
            current: JSON.stringify({ founderUserId: nextOwner.id, founderEmail: nextOwner.email }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });
      });

      return { message: 'Responsável administrativo atualizado (sem mover tokens).' };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.patch('/tokens/:id/suspend', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, roles)) return;

    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const { reason } = z.object({ reason: z.string().min(2) }).parse(request.body);

      const company = await prisma.company.findUnique({ where: { id } });
      if (!company) return reply.code(404).send({ message: 'Mercado não encontrado.' });
      if (company.status !== 'ACTIVE') return reply.code(400).send({ message: 'Somente mercado ACTIVE pode ser pausado.' });

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.company.update({ where: { id }, data: { status: 'SUSPENDED', suspendedAt: new Date() } });
        await tx.companyOperation.create({
          data: {
            companyId: id,
            userId: authRequest.user.sub,
            type: 'ADMIN_SUSPEND',
            description: 'Mercado pausado pelo admin.',
          },
        });
        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'ADMIN_TOKEN_SUSPENDED',
            entity: `Company:${id}`,
            reason,
            previous: JSON.stringify({ status: company.status }),
            current: JSON.stringify({ status: 'SUSPENDED' }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });
      });

      return { message: 'Mercado pausado com sucesso.' };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.patch('/tokens/:id/reactivate', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, roles)) return;

    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const { reason } = z.object({ reason: z.string().min(2) }).parse(request.body);

      const company = await prisma.company.findUnique({ where: { id } });
      if (!company) return reply.code(404).send({ message: 'Mercado não encontrado.' });
      if (company.status !== 'SUSPENDED') return reply.code(400).send({ message: 'Somente mercado SUSPENDED pode ser reativado.' });

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.company.update({ where: { id }, data: { status: 'ACTIVE' } });
        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'ADMIN_TOKEN_REACTIVATED',
            entity: `Company:${id}`,
            reason,
            previous: JSON.stringify({ status: company.status }),
            current: JSON.stringify({ status: 'ACTIVE' }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });
      });

      return { message: 'Mercado reativado com sucesso.' };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.patch('/tokens/:id/close', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, roles)) return;

    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const { reason } = z.object({ reason: z.string().min(2) }).parse(request.body);

      const company = await prisma.company.findUnique({ where: { id } });
      if (!company) return reply.code(404).send({ message: 'Mercado não encontrado.' });
      if (company.status === 'CLOSED') return reply.code(400).send({ message: 'Mercado já está encerrado.' });

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const openOrders = await tx.marketOrder.findMany({
          where: {
            companyId: id,
            status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
          },
          select: { id: true },
        });

        for (const order of openOrders) {
          await cancelOrderWithRelease(tx, {
            orderId: order.id,
            canceledByUserId: authRequest.user.sub,
            reason: 'Cancelada por encerramento administrativo do mercado.',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });
        }

        await tx.company.update({ where: { id }, data: { status: 'CLOSED' } });
        await tx.companyOperation.create({
          data: {
            companyId: id,
            userId: authRequest.user.sub,
            type: 'ADMIN_SUSPEND',
            description: 'Mercado encerrado pelo admin',
          },
        });

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'ADMIN_TOKEN_CLOSED',
            entity: `Company:${id}`,
            reason,
            previous: JSON.stringify({ status: company.status, canceledOrders: openOrders.length }),
            current: JSON.stringify({ status: 'CLOSED' }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });
      });

      return { message: 'Mercado encerrado com cancelamento de ordens abertas.' };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.get('/companies/:id/delete-summary', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!isSuperAdmin(roles)) {
      return reply.code(403).send({ message: 'Somente SUPER_ADMIN pode executar exclusão definitiva forçada.' });
    }

    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const company = await prisma.company.findUnique({ where: { id }, select: { id: true, ticker: true, name: true, status: true } });
    if (!company) return reply.code(404).send({ message: 'Mercado não encontrado.' });

    const counts = await getCompanyDeleteCounts(id);
    return { company, counts };
  });

  app.delete('/companies/:id/force-delete', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!isSuperAdmin(roles)) {
      return reply.code(403).send({ message: 'Somente SUPER_ADMIN pode executar exclusão definitiva forçada.' });
    }

    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const body = z.object({
        confirmation: z.string(),
        reason: z.string().min(10, 'Motivo deve ter pelo menos 10 caracteres.'),
      }).parse(request.body);

      const normalizedConfirmation = normalizeForceDeleteConfirmation(body.confirmation);

      if (normalizedConfirmation !== FORCE_DELETE_CONFIRMATION) {
        return reply.code(400).send({ message: 'Confirmação inválida. Digite EXCLUIR DEFINITIVAMENTE.' });
      }

      const company = await prisma.company.findUnique({
        where: { id },
        select: {
          id: true,
          ticker: true,
          name: true,
          status: true,
          founderUserId: true,
          currentPrice: true,
          totalShares: true,
        },
      });
      if (!company) return reply.code(404).send({ message: 'Mercado não encontrado.' });

      const deletedCounts = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const counts = await getCompanyDeleteCounts(id, tx);

        await tx.feeDistribution.deleteMany({ where: { companyId: id } });
        await tx.companyBoostInjection.deleteMany({ where: { companyId: id } });
        await tx.companyBoostAccount.deleteMany({ where: { companyId: id } });
        await tx.companyCapitalFlowEntry.deleteMany({ where: { companyId: id } });
        await tx.companyRevenueAccount.deleteMany({ where: { companyId: id } });
        await tx.trade.deleteMany({ where: { companyId: id } });
        await tx.marketOrder.deleteMany({ where: { companyId: id } });
        await tx.companyOperation.deleteMany({ where: { companyId: id } });
        await tx.companyInitialOffer.deleteMany({ where: { companyId: id } });
        await tx.companyHolding.deleteMany({ where: { companyId: id } });

        const remainingCounts = await getCompanyDeleteCounts(id, tx);
        const hasRemainingDependencies = Object.values(remainingCounts).some((count) => count > 0);
        if (hasRemainingDependencies) {
          throw new Error(`Dependências restantes impedem exclusão: ${JSON.stringify(remainingCounts)}`);
        }

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'COMPANY_FORCE_DELETED',
            entity: 'Company',
            reason: body.reason,
            previous: JSON.stringify({
              company,
              deletedCounts: {
                feeDistributions: counts.feeDistributions,
                capitalFlowEntries: counts.capitalFlowEntries,
                boostInjections: counts.boostInjections,
                boostAccounts: counts.boostAccounts,
                revenueAccounts: counts.revenueAccounts,
                trades: counts.trades,
                marketOrders: counts.marketOrders,
                operations: counts.operations,
                initialOffers: counts.initialOffer,
                holdings: counts.holdings,
              },
            }),
            current: JSON.stringify({ deleted: true, companyId: id, confirmation: normalizedConfirmation }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });

        await tx.company.delete({ where: { id } });

        return counts;
      });

      return {
        message: 'Projeto/token excluído definitivamente.',
        company: { id: company.id, ticker: company.ticker, name: company.name },
        deletedCounts: {
          holdings: deletedCounts.holdings,
          operations: deletedCounts.operations,
          initialOffer: deletedCounts.initialOffer,
          marketOrders: deletedCounts.marketOrders,
          trades: deletedCounts.trades,
          feeDistributions: deletedCounts.feeDistributions,
          capitalFlowEntries: deletedCounts.capitalFlowEntries,
          revenueAccount: deletedCounts.revenueAccounts,
          boostAccount: deletedCounts.boostAccounts,
          boostInjections: deletedCounts.boostInjections,
        },
      };
    } catch (error) {
      request.log.error({ err: error }, 'company force delete failed');

      const err = error as Error & { code?: string; meta?: unknown };

      return reply.code(400).send({
        code: 'COMPANY_FORCE_DELETE_FAILED',
        message: err.message,
        prismaCode: err.code ?? null,
        meta: err.meta ?? null,
      });
    }
  });

  app.delete('/tokens/:id', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, roles)) return;

    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${id} FOR UPDATE`;
        const company = await tx.company.findUnique({ where: { id } });
        if (!company) return { deleted: false as const, notFound: true as const };

        const [trades, orders, holdingsWithShares, feeDistributions, capitalFlowEntries, operations, initialOffer, revenue] = await Promise.all([
          tx.trade.count({ where: { companyId: id } }),
          tx.marketOrder.count({ where: { companyId: id } }),
          tx.companyHolding.count({ where: { companyId: id, shares: { gt: 0 } } }),
          tx.feeDistribution.count({ where: { companyId: id } }),
          tx.companyCapitalFlowEntry.count({ where: { companyId: id } }),
          tx.companyOperation.findMany({ where: { companyId: id }, select: { type: true, description: true } }),
          tx.companyInitialOffer.findUnique({ where: { companyId: id } }),
          tx.companyRevenueAccount.findUnique({ where: { companyId: id } }),
        ]);

        const economicOps = operations.filter((operation: { type: string; description: string }) => !(operation.type === 'ADMIN_APPROVE' && operation.description.includes('manualmente por administrador'))).length;

        const blockedByHistory = hasEconomicHistory({
          trades,
          orders,
          holdingsWithShares,
          feeDistributions,
          capitalFlowEntries,
          revenueBalance: revenue?.balance ?? new Decimal(0),
          revenueFees: revenue?.totalReceivedFees ?? new Decimal(0),
          economicOps,
          initialOfferMoved: Boolean(initialOffer && initialOffer.availableShares < initialOffer.totalShares),
        });

        if (blockedByHistory) {
          throw new Error('Este mercado possui histórico e não pode ser excluído definitivamente. Use Encerrar mercado.');
        }

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'ADMIN_TOKEN_DELETED',
            entity: `Company:${id}`,
            reason: 'Exclusão definitiva de mercado sem histórico econômico.',
            current: JSON.stringify({ id: company.id, ticker: company.ticker, name: company.name }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });

        await tx.companyHolding.deleteMany({ where: { companyId: id, shares: { lte: 0 } } });
        await tx.companyInitialOffer.deleteMany({ where: { companyId: id } });
        await tx.companyRevenueAccount.deleteMany({ where: { companyId: id } });
        await tx.company.delete({ where: { id } });

        return { deleted: true as const, notFound: false as const };
      });

      if (result.notFound) return reply.code(404).send({ message: 'Mercado não encontrado.' });

      return { message: 'Mercado excluído definitivamente com segurança.' };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });
}
