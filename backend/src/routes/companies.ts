import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { MAX_COMPANY_TRADES_PER_MINUTE, MAX_PROJECT_CREATIONS_PER_DAY } from '../config/anti-abuse-limits.js';
import { COMPANY_RULES } from '../constants/company-rules.js';
import { distributeFee, ensureCompanyRevenueAccount } from '../services/fee-distribution-service.js';
import { assertFinancialPermission } from '../services/registration-approval-service.js';
import { validateDescriptionAllowed, validatePublicNameAllowed, validateTickerAllowed } from '../services/content-moderation-service.js';
import { ADMIN_ROLES, hasAnyRole } from '../lib/roles.js';

type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };

const companyRequestSchema = z.object({
  name: z.string().min(3),
  ticker: z.string().min(2).max(10),
  sector: z.string().min(2),
  description: z.string().min(5),
  totalShares: z.coerce.number().int().positive(),
  initialPrice: z.coerce.number().positive(),
  ownerSharePercent: z.coerce.number().min(0),
  publicOfferPercent: z.coerce.number().min(0),
  buyFeePercent: z.coerce.number().min(0),
  sellFeePercent: z.coerce.number().min(0),
});

const buyInitialOfferSchema = z.object({
  quantity: z.coerce.number().int().positive(),
});

function isAdmin(roles: string[]) {
  return hasAnyRole(roles, ADMIN_ROLES);
}

function assertCompanyRequestRules(input: z.infer<typeof companyRequestSchema>) {
  const sum = input.ownerSharePercent + input.publicOfferPercent;
  if (Math.abs(sum - 100) > 0.0001) {
    throw new Error('Percentual do dono + lançamento inicial deve ser exatamente 100%.');
  }

  if (input.publicOfferPercent < COMPANY_RULES.minPublicOfferPercent) {
    throw new Error(`Lançamento inicial precisa ser de no mínimo ${COMPANY_RULES.minPublicOfferPercent}%.`);
  }

  if (input.ownerSharePercent > COMPANY_RULES.maxOwnerSharePercent) {
    throw new Error(`Dono não pode manter mais de ${COMPANY_RULES.maxOwnerSharePercent}%.`);
  }

  if (input.buyFeePercent > COMPANY_RULES.maxBuyFeePercent) {
    throw new Error(`Taxa de compra não pode passar de ${COMPANY_RULES.maxBuyFeePercent}%.`);
  }

  if (input.sellFeePercent > COMPANY_RULES.maxSellFeePercent) {
    throw new Error(`Taxa de venda não pode passar de ${COMPANY_RULES.maxSellFeePercent}%.`);
  }
}

function splitShares(totalShares: number, ownerPercent: number, publicPercent: number) {
  const ownerShares = Math.floor((totalShares * ownerPercent) / 100);
  const publicOfferShares = totalShares - ownerShares;

  const recalculatedPublicPercent = Number(((publicOfferShares / totalShares) * 100).toFixed(2));
  if (Math.abs(recalculatedPublicPercent - publicPercent) > 1) {
    throw new Error('Não foi possível distribuir tokens com os percentuais informados.');
  }

  return { ownerShares, publicOfferShares };
}

export async function companyRoutes(app: FastifyInstance) {
  app.post('/companies/request', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;

    try {
      const body = companyRequestSchema.parse(request.body);
      await assertFinancialPermission(authRequest.user.sub, 'PROJECT_CREATE');
      assertCompanyRequestRules(body);
      const roles = authRequest.user.roles ?? [];
      const isAdminUser = isAdmin(roles);
      if (!isAdminUser) {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const createdCount = await prisma.company.count({
          where: {
            founderUserId: authRequest.user.sub,
            createdAt: { gte: since },
          },
        });
        if (createdCount >= MAX_PROJECT_CREATIONS_PER_DAY) {
          return reply.status(429).send({ message: 'Limite diário de criação de projetos atingido.' });
        }
      }

      validateTickerAllowed(body.ticker);
      validatePublicNameAllowed(body.name, 'company');
      validateDescriptionAllowed(body.description);

      const ticker = body.ticker.trim().toUpperCase();
      const existing = await prisma.company.findUnique({ where: { ticker } });
      if (existing) {
        return reply.code(409).send({ message: 'Ticker já está em uso.' });
      }

      const { ownerShares, publicOfferShares } = splitShares(body.totalShares, body.ownerSharePercent, body.publicOfferPercent);
      const initialPrice = new Decimal(body.initialPrice);

      const company = await prisma.company.create({
        data: {
          name: body.name.trim(),
          ticker,
          sector: body.sector.trim(),
          description: body.description.trim(),
          founderUserId: authRequest.user.sub,
          totalShares: body.totalShares,
          circulatingShares: 0,
          ownerSharePercent: new Decimal(body.ownerSharePercent),
          publicOfferPercent: new Decimal(body.publicOfferPercent),
          ownerShares,
          publicOfferShares,
          availableOfferShares: 0,
          initialPrice,
          currentPrice: initialPrice,
          buyFeePercent: new Decimal(body.buyFeePercent),
          sellFeePercent: new Decimal(body.sellFeePercent),
          fictitiousMarketCap: initialPrice.mul(body.totalShares),
        },
      });

      await prisma.adminLog.create({
        data: {
          userId: authRequest.user.sub,
          action: 'COMPANY_REQUEST_CREATED',
          entity: 'Company',
          reason: 'Solicitação de projeto/token',
          current: JSON.stringify({ companyId: company.id, ticker: company.ticker }),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        },
      });

      return reply.code(201).send({ company });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.get('/companies', { preHandler: [app.authenticate] }, async () => {
    const companies = await prisma.company.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        ticker: true,
        sector: true,
        initialPrice: true,
        currentPrice: true,
        status: true,
        availableOfferShares: true,
        totalShares: true,
        ownerSharePercent: true,
        publicOfferPercent: true,
        buyFeePercent: true,
        sellFeePercent: true,
      },
    });

    return { companies };
  });

  app.get('/companies/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);

    const company = await prisma.company.findUnique({
      where: { id: params.id },
      include: {
        founder: { select: { id: true, name: true, email: true } },
        initialOffer: true,
      },
    });

    if (!company || company.status !== 'ACTIVE') {
      return reply.code(404).send({ message: 'Projeto/token não disponível.' });
    }

    return { company };
  });

  app.get('/admin/companies/pending', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!isAdmin(roles)) {
      return reply.code(403).send({ message: 'Sem permissão para listar listagens pendentes.' });
    }

    const companies = await prisma.company.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { founder: { select: { id: true, name: true, email: true } } },
    });

    return { companies };
  });

  app.post('/admin/companies/:id/approve', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!isAdmin(roles)) {
      return reply.code(403).send({ message: 'Sem permissão para aprovar listagem.' });
    }

    const params = z.object({ id: z.string().min(1) }).parse(request.params);

    try {
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const company = await tx.company.findUnique({ where: { id: params.id } });
        if (!company) throw new Error('Projeto/token não encontrado.');
        if (company.status !== 'PENDING') throw new Error('Somente listagens pendentes podem ser aprovadas.');

        const updated = await tx.company.update({
          where: { id: company.id },
          data: {
            status: 'ACTIVE',
            approvedAt: new Date(),
            availableOfferShares: company.publicOfferShares,
          },
        });

        await tx.companyHolding.upsert({
          where: { userId_companyId: { userId: company.founderUserId, companyId: company.id } },
          update: {
            shares: company.ownerShares,
            estimatedValue: new Decimal(company.ownerShares).mul(company.initialPrice),
            averageBuyPrice: company.initialPrice,
          },
          create: {
            userId: company.founderUserId,
            companyId: company.id,
            shares: company.ownerShares,
            estimatedValue: new Decimal(company.ownerShares).mul(company.initialPrice),
            averageBuyPrice: company.initialPrice,
          },
        });

        await tx.companyInitialOffer.upsert({
          where: { companyId: company.id },
          update: { totalShares: company.publicOfferShares, availableShares: company.publicOfferShares },
          create: { companyId: company.id, totalShares: company.publicOfferShares, availableShares: company.publicOfferShares },
        });

        await ensureCompanyRevenueAccount(tx, company.id);

        const businessOwnerRole = await tx.role.findUnique({ where: { key: 'BUSINESS_OWNER' } });
        if (!businessOwnerRole) throw new Error('Role BUSINESS_OWNER não encontrada. Contate um administrador do sistema.');

        await tx.userRole.upsert({
          where: { userId_roleId: { userId: company.founderUserId, roleId: businessOwnerRole.id } },
          update: {},
          create: { userId: company.founderUserId, roleId: businessOwnerRole.id },
        });

        await tx.companyOperation.create({
          data: {
            companyId: company.id,
            userId: authRequest.user.sub,
            type: 'ADMIN_APPROVE',
            description: 'Listagem aprovada e lançamento inicial habilitado.',
          },
        });

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'COMPANY_APPROVED',
            entity: 'Company',
            reason: 'Aprovação administrativa de listagem',
            previous: JSON.stringify({ status: company.status }),
            current: JSON.stringify({ status: 'ACTIVE', companyId: company.id, ownerShares: company.ownerShares, publicOfferShares: company.publicOfferShares, founderGrantedRole: 'BUSINESS_OWNER' }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });

        return updated;
      });

      return { company: result };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.post('/admin/companies/:id/reject', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!isAdmin(roles)) {
      return reply.code(403).send({ message: 'Sem permissão para rejeitar listagem.' });
    }

    const params = z.object({ id: z.string().min(1) }).parse(request.params);

    try {
      const company = await prisma.company.findUnique({ where: { id: params.id } });
      if (!company) return reply.code(404).send({ message: 'Projeto/token não encontrado.' });
      if (company.status !== 'PENDING') return reply.code(400).send({ message: 'Somente listagens pendentes podem ser rejeitadas.' });

      const updated = await prisma.company.update({ where: { id: company.id }, data: { status: 'REJECTED', rejectedAt: new Date() } });

      await prisma.companyOperation.create({
        data: {
          companyId: company.id,
          userId: authRequest.user.sub,
          type: 'ADMIN_REJECT',
          description: 'Listagem rejeitada pelo administrador.',
        },
      });

      await prisma.adminLog.create({
        data: {
          userId: authRequest.user.sub,
          action: 'COMPANY_REJECTED',
          entity: 'Company',
          previous: JSON.stringify({ status: company.status }),
          current: JSON.stringify({ status: 'REJECTED', companyId: company.id }),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        },
      });

      return { company: updated };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.post('/admin/companies/:id/suspend', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!isAdmin(roles)) {
      return reply.code(403).send({ message: 'Sem permissão para suspender mercado.' });
    }

    const params = z.object({ id: z.string().min(1) }).parse(request.params);

    const company = await prisma.company.findUnique({ where: { id: params.id } });
    if (!company) return reply.code(404).send({ message: 'Projeto/token não encontrado.' });
    if (company.status !== 'ACTIVE') return reply.code(400).send({ message: 'Somente mercado ativo pode ser suspenso.' });

    const updated = await prisma.company.update({ where: { id: company.id }, data: { status: 'SUSPENDED', suspendedAt: new Date() } });

    await prisma.companyOperation.create({
      data: {
        companyId: company.id,
        userId: authRequest.user.sub,
        type: 'ADMIN_SUSPEND',
        description: 'Mercado suspenso pelo administrador.',
      },
    });

    await prisma.adminLog.create({
      data: {
        userId: authRequest.user.sub,
        action: 'COMPANY_SUSPENDED',
        entity: 'Company',
        previous: JSON.stringify({ status: company.status }),
        current: JSON.stringify({ status: 'SUSPENDED', companyId: company.id }),
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      },
    });

    return { company: updated };
  });

  app.post('/companies/:id/buy-initial-offer', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: MAX_COMPANY_TRADES_PER_MINUTE, timeWindow: '1 minute', errorResponseBuilder: () => ({ message: 'Muitas negociações em sequência. Aguarde um minuto e tente novamente.' }) } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const params = z.object({ id: z.string().min(1) }).parse(request.params);

    try {
      await assertFinancialPermission(authRequest.user.sub, 'COMPANY_MARKET_TRADE');
      const body = buyInitialOfferSchema.parse(request.body);

      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${params.id} FOR UPDATE`;
        const company = await tx.company.findUnique({ where: { id: params.id } });
        if (!company || company.status !== 'ACTIVE') {
          throw new Error('Mercado não está ativo para compra de lançamento inicial.');
        }

        const wallet = await tx.wallet.upsert({
          where: { userId: authRequest.user.sub },
          update: {},
          create: { userId: authRequest.user.sub },
        });

        const offer = await tx.companyInitialOffer.findUnique({ where: { companyId: company.id } });
        if (!offer || offer.availableShares <= 0) {
          throw new Error('Lançamento inicial indisponível.');
        }

        if (body.quantity > offer.availableShares) {
          throw new Error('Quantidade solicitada maior que tokens disponíveis no lançamento inicial.');
        }

        const quantity = new Decimal(body.quantity);
        const grossAmount = company.initialPrice.mul(quantity);
        const feeAmount = grossAmount.mul(company.buyFeePercent).div(100);
        const totalAmount = grossAmount.add(feeAmount);

        if (wallet.rpcAvailableBalance.lessThan(totalAmount)) {
          throw new Error('Saldo RPC insuficiente para comprar no lançamento.');
        }

        const walletNext = wallet.rpcAvailableBalance.sub(totalAmount);
        const priceBefore = company.currentPrice;
        const priceIncrease = grossAmount.div(new Decimal(company.totalShares));
        const priceAfter = priceBefore.add(priceIncrease);
        const nextMarketCap = priceAfter.mul(new Decimal(company.totalShares));

        await tx.wallet.update({ where: { id: wallet.id }, data: { rpcAvailableBalance: walletNext } });

        const currentHolding = await tx.companyHolding.findUnique({ where: { userId_companyId: { userId: authRequest.user.sub, companyId: company.id } } });

        const newShares = (currentHolding?.shares ?? 0) + body.quantity;
        const prevCost = new Decimal(currentHolding?.shares ?? 0).mul(currentHolding?.averageBuyPrice ?? new Decimal(0));
        const newCost = prevCost.add(grossAmount);
        const nextAveragePrice = newShares > 0 ? newCost.div(new Decimal(newShares)) : new Decimal(0);

        await tx.companyHolding.upsert({
          where: { userId_companyId: { userId: authRequest.user.sub, companyId: company.id } },
          update: {
            shares: newShares,
            averageBuyPrice: nextAveragePrice,
            estimatedValue: new Decimal(newShares).mul(priceAfter),
          },
          create: {
            userId: authRequest.user.sub,
            companyId: company.id,
            shares: body.quantity,
            averageBuyPrice: company.initialPrice,
            estimatedValue: quantity.mul(priceAfter),
          },
        });

        await tx.companyInitialOffer.update({ where: { companyId: company.id }, data: { availableShares: offer.availableShares - body.quantity } });
        await tx.company.update({
          where: { id: company.id },
          data: {
            availableOfferShares: company.availableOfferShares - body.quantity,
            circulatingShares: company.circulatingShares + body.quantity,
            currentPrice: priceAfter,
            fictitiousMarketCap: nextMarketCap,
          },
        });

        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'COMPANY_INITIAL_OFFER_BUY',
            amount: totalAmount,
            description: `Compra de ${body.quantity} tokens no lançamento inicial de ${company.ticker}`,
          },
        });

        const operation = await tx.companyOperation.create({
          data: {
            companyId: company.id,
            userId: authRequest.user.sub,
            type: 'INITIAL_OFFER_BUY',
            quantity: body.quantity,
            unitPrice: company.initialPrice,
            grossAmount,
            feeAmount,
            totalAmount,
            description: `Compra no lançamento inicial (${company.ticker}) com ajuste de preço automático.`,
          },
        });

        await distributeFee(tx, {
          companyId: company.id,
          operationId: operation.id,
          payerUserId: authRequest.user.sub,
          sourceType: 'INITIAL_OFFER_BUY',
          totalFeeAmount: feeAmount,
        });

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'COMPANY_INITIAL_OFFER_BUY',
            entity: 'CompanyOperation',
            reason: `Compra de ${body.quantity} tokens (${company.ticker})`,
            previous: JSON.stringify({ wallet: wallet.rpcAvailableBalance.toString(), availableOfferShares: offer.availableShares }),
            current: JSON.stringify({ wallet: walletNext.toString(), availableOfferShares: offer.availableShares - body.quantity, totalAmount: totalAmount.toString(), priceBefore: priceBefore.toString(), priceAfter: priceAfter.toString() }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });

        return {
          operation,
          balance: walletNext,
          totalAmount,
          feeAmount,
          grossAmount,
          priceBefore,
          priceAfter,
          priceIncrease,
          currentPrice: priceAfter,
          marketCapAfter: nextMarketCap,
        };
      });

      return reply.code(201).send(result);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.get('/me/holdings', { preHandler: [app.authenticate] }, async (request) => {
    const authRequest = request as AuthRequest;

    const [wallet, holdings] = await Promise.all([
      prisma.wallet.findUnique({ where: { userId: authRequest.user.sub } }),
      prisma.companyHolding.findMany({
        where: { userId: authRequest.user.sub, shares: { gt: 0 }, company: { status: 'ACTIVE' } },
        include: {
          company: {
            select: {
              id: true,
              name: true,
              ticker: true,
              currentPrice: true,
              initialPrice: true,
            },
          },
        },
      }),
    ]);

    const data = holdings.map((holding: (typeof holdings)[number]) => ({
      companyId: holding.companyId,
      companyName: holding.company.name,
      ticker: holding.company.ticker,
      quantity: holding.shares,
      averageBuyPrice: holding.averageBuyPrice,
      estimatedValue: new Decimal(holding.shares).mul(holding.company.currentPrice),
      currentPrice: holding.company.currentPrice,
    }));

    return {
      wallet: {
        fiatAvailableBalance: wallet?.fiatAvailableBalance ?? new Decimal(0),
        fiatLockedBalance: wallet?.fiatLockedBalance ?? new Decimal(0),
        fiatPendingWithdrawalBalance: wallet?.fiatPendingWithdrawalBalance ?? new Decimal(0),
        rpcAvailableBalance: wallet?.rpcAvailableBalance ?? new Decimal(0),
        rpcLockedBalance: wallet?.rpcLockedBalance ?? new Decimal(0),
        availableBalance: wallet?.availableBalance ?? new Decimal(0),
        lockedBalance: wallet?.lockedBalance ?? new Decimal(0),
        pendingWithdrawalBalance: wallet?.pendingWithdrawalBalance ?? new Decimal(0),
      },
      holdings: data,
      totalCompanies: data.length,
    };
  });
}
