import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { distributeFee } from '../services/fee-distribution-service.js';
import { assertFinancialPermission } from '../services/registration-approval-service.js';
import { COMPANY_MARKET_MAX_OPEN_ORDERS_PER_USER, MAX_COMPANY_TRADES_PER_MINUTE, MAX_ORDER_CANCELS_PER_MINUTE } from '../config/anti-abuse-limits.js';

type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };

type Tx = Prisma.TransactionClient;

const createOrderSchema = z.object({
  companyId: z.string().min(1),
  type: z.enum(['BUY', 'SELL']),
  mode: z.literal('LIMIT'),
  quantity: z.coerce.number().int().positive(),
  limitPrice: z.coerce.number().positive(),
});

const marketOrderSchema = z.object({
  quantity: z.coerce.number().int().positive(),
  slippagePercent: z.coerce.number().min(0).max(100),
});

const cancelOrderParams = z.object({ id: z.string().min(1) });
const companyParams = z.object({ companyId: z.string().min(1) });

const ZERO = new Decimal(0);

const MARKET_TRANSACTION_OPTIONS = {
  maxWait: 10000,
  timeout: 20000,
};

function toDecimal(value: number | string | Decimal) {
  return value instanceof Decimal ? value : new Decimal(value);
}

function statusFromRemaining(order: { quantity: number; remainingQuantity: number }) {
  if (order.remainingQuantity <= 0) return 'FILLED' as const;
  if (order.remainingQuantity < order.quantity) return 'PARTIALLY_FILLED' as const;
  return 'OPEN' as const;
}

async function getCompanyOrThrow(tx: Tx, companyId: string) {
  const company = await tx.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error('Projeto/token inexistente.');
  if (company.status !== 'ACTIVE') {
    if (company.status === 'CLOSED') {
      throw new Error('Este mercado foi encerrado e não aceita novas ordens.');
    }
    throw new Error('Mercado não disponível para negociação.');
  }
  return company;
}

async function ensureWallet(tx: Tx, userId: string) {
  return tx.wallet.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}

async function getHolding(tx: Tx, userId: string, companyId: string) {
  return tx.companyHolding.findUnique({ where: { userId_companyId: { userId, companyId } } });
}

export async function cancelOrderWithRelease(
  tx: Tx,
  input: {
    orderId: string;
    canceledByUserId: string;
    reason?: string;
    ip?: string | null;
    userAgent?: string | null;
  },
) {
  const order = await tx.marketOrder.findUnique({ where: { id: input.orderId } });
  if (!order) throw new Error('Ordem não encontrada.');
  if (!['OPEN', 'PARTIALLY_FILLED'].includes(order.status)) return order;

  if (order.type === 'BUY' && order.lockedCash.greaterThan(0)) {
    const wallet = await ensureWallet(tx, order.userId);
    await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        rpcLockedBalance: wallet.rpcLockedBalance.sub(order.lockedCash),
        rpcAvailableBalance: wallet.rpcAvailableBalance.add(order.lockedCash),
      },
    });
  }

  if (order.type === 'SELL' && order.lockedShares > 0) {
    const holding = await getHolding(tx, order.userId, order.companyId);
    if (holding) {
      await tx.companyHolding.update({
        where: { id: holding.id },
        data: { shares: holding.shares + order.lockedShares },
      });
    } else {
      await tx.companyHolding.create({
        data: {
          userId: order.userId,
          companyId: order.companyId,
          shares: order.lockedShares,
          averageBuyPrice: ZERO,
          estimatedValue: ZERO,
        },
      });
    }
  }

  const updated = await tx.marketOrder.update({
    where: { id: order.id },
    data: {
      status: 'CANCELED',
      canceledAt: new Date(),
      lockedCash: ZERO,
      lockedShares: 0,
    },
  });

  await tx.companyOperation.create({
    data: {
      companyId: order.companyId,
      userId: input.canceledByUserId,
      type: 'MARKET_ORDER_CANCEL',
      quantity: order.remainingQuantity,
      unitPrice: order.limitPrice,
      description: `Ordem ${order.id} cancelada`,
    },
  });

  await tx.adminLog.create({
    data: {
      userId: input.canceledByUserId,
      action: 'MARKET_ORDER_CANCEL',
      entity: 'MarketOrder',
      reason: input.reason ?? `Cancelamento da ordem ${order.id}`,
      current: JSON.stringify({ orderId: order.id }),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });

  return updated;
}

async function addSharesToBuyer(
  tx: Tx,
  input: { userId: string; companyId: string; quantity: number; tradeGrossAmount: Decimal; currentPrice: Decimal },
) {
  const currentHolding = await getHolding(tx, input.userId, input.companyId);
  const newShares = (currentHolding?.shares ?? 0) + input.quantity;
  const previousCost = toDecimal(currentHolding?.shares ?? 0).mul(currentHolding?.averageBuyPrice ?? ZERO);
  const newCost = previousCost.add(input.tradeGrossAmount);
  const nextAveragePrice = newShares > 0 ? newCost.div(new Decimal(newShares)) : ZERO;

  await tx.companyHolding.upsert({
    where: { userId_companyId: { userId: input.userId, companyId: input.companyId } },
    update: {
      shares: newShares,
      averageBuyPrice: nextAveragePrice,
      estimatedValue: new Decimal(newShares).mul(input.currentPrice),
    },
    create: {
      userId: input.userId,
      companyId: input.companyId,
      shares: input.quantity,
      averageBuyPrice: nextAveragePrice,
      estimatedValue: new Decimal(input.quantity).mul(input.currentPrice),
    },
  });
}

async function subtractSharesFromSeller(tx: Tx, input: { userId: string; companyId: string; quantity: number; currentPrice: Decimal }) {
  const holding = await getHolding(tx, input.userId, input.companyId);
  if (!holding || holding.shares < input.quantity) {
    throw new Error('Usuário vendedor não possui tokens suficientes.');
  }

  const nextShares = holding.shares - input.quantity;
  await tx.companyHolding.update({
    where: { id: holding.id },
    data: {
      shares: nextShares,
      estimatedValue: new Decimal(nextShares).mul(input.currentPrice),
    },
  });
}

async function runMatching(tx: Tx, takerOrderId: string, meta: { ip?: string; userAgent?: string }) {
  const taker = await tx.marketOrder.findUnique({ where: { id: takerOrderId } });
  if (!taker) throw new Error('Ordem não encontrada para matching.');

  const company = await getCompanyOrThrow(tx, taker.companyId);

  const initialOppositeOrders = await tx.marketOrder.findMany({
    where: {
      companyId: taker.companyId,
      type: taker.type === 'BUY' ? 'SELL' : 'BUY',
      mode: 'LIMIT',
      status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
      remainingQuantity: { gt: 0 },
      ...(taker.type === 'BUY' && taker.mode === 'LIMIT' ? { limitPrice: { lte: taker.limitPrice! } } : {}),
      ...(taker.type === 'SELL' && taker.mode === 'LIMIT' ? { limitPrice: { gte: taker.limitPrice! } } : {}),
    },
    orderBy:
      taker.type === 'BUY'
        ? [{ limitPrice: 'asc' }, { createdAt: 'asc' }]
        : [{ limitPrice: 'desc' }, { createdAt: 'asc' }],
  });

  if (initialOppositeOrders.length === 0 && taker.mode === 'MARKET') {
    throw new Error('Livro sem liquidez para executar ordem a mercado.');
  }

  const bestPrice = initialOppositeOrders[0]?.limitPrice ?? null;

  let maxBuyPrice: Decimal | null = null;
  let minSellPrice: Decimal | null = null;

  if (taker.mode === 'MARKET' && bestPrice && taker.slippagePercent) {
    const factor = toDecimal(taker.slippagePercent).div(100);
    if (taker.type === 'BUY') {
      maxBuyPrice = bestPrice.mul(new Decimal(1).add(factor));
    } else {
      minSellPrice = bestPrice.mul(new Decimal(1).sub(factor));
    }
  }

  for (const restingOrder of initialOppositeOrders) {
    if (taker.remainingQuantity <= 0) break;

    const takerFresh = await tx.marketOrder.findUnique({ where: { id: taker.id } });
    if (!takerFresh || takerFresh.remainingQuantity <= 0) break;
    taker.remainingQuantity = takerFresh.remainingQuantity;
    taker.lockedCash = takerFresh.lockedCash;
    taker.lockedShares = takerFresh.lockedShares;

    const maker = await tx.marketOrder.findUnique({ where: { id: restingOrder.id } });
    if (!maker || maker.remainingQuantity <= 0) continue;
    if (maker.userId === taker.userId) continue;

    const unitPrice = maker.limitPrice;
    if (!unitPrice) continue;

    if (maxBuyPrice && unitPrice.greaterThan(maxBuyPrice)) {
      if (taker.remainingQuantity === taker.quantity) {
        throw new Error('Slippage excedido para compra a mercado.');
      }
      break;
    }

    if (minSellPrice && unitPrice.lessThan(minSellPrice)) {
      if (taker.remainingQuantity === taker.quantity) {
        throw new Error('Slippage excedido para venda a mercado.');
      }
      break;
    }

    const tradeQuantity = Math.min(taker.remainingQuantity, maker.remainingQuantity);
    const quantityDecimal = new Decimal(tradeQuantity);
    const grossAmount = unitPrice.mul(quantityDecimal);
    const buyFeeAmount = grossAmount.mul(company.buyFeePercent).div(100);
    const sellFeeAmount = grossAmount.mul(company.sellFeePercent).div(100);
    const buyerTotalPay = grossAmount.add(buyFeeAmount);
    const sellerNetReceive = grossAmount.sub(sellFeeAmount);

    const buyerId = taker.type === 'BUY' ? taker.userId : maker.userId;
    const sellerId = taker.type === 'SELL' ? taker.userId : maker.userId;

    const buyerWallet = await ensureWallet(tx, buyerId);
    const sellerWallet = await ensureWallet(tx, sellerId);

    const buyerIsTaker = taker.type === 'BUY';
    const sellerIsTaker = taker.type === 'SELL';

    if (buyerIsTaker) {
      if (taker.mode === 'LIMIT') {
        const reserveCheck = await tx.wallet.findUnique({ where: { id: buyerWallet.id }, select: { rpcLockedBalance: true } });
        if (!reserveCheck || reserveCheck.rpcLockedBalance.lessThan(buyerTotalPay)) {
          throw new Error('Saldo bloqueado insuficiente para concluir a ordem de compra.');
        }
        const debited = await tx.wallet.updateMany({
          where: { id: buyerWallet.id, rpcLockedBalance: { gte: buyerTotalPay } },
          data: { rpcLockedBalance: { decrement: buyerTotalPay } },
        });
        if (debited.count !== 1) throw new Error('Falha de consistência ao debitar saldo bloqueado do comprador.');
      } else {
        const buyerCash = await tx.wallet.findUnique({ where: { id: buyerWallet.id }, select: { rpcAvailableBalance: true } });
        if (!buyerCash || buyerCash.rpcAvailableBalance.lessThan(buyerTotalPay)) {
          if (taker.remainingQuantity === taker.quantity) throw new Error('Saldo RPC insuficiente para compra a mercado.');
          break;
        }
        const debited = await tx.wallet.updateMany({
          where: { id: buyerWallet.id, rpcAvailableBalance: { gte: buyerTotalPay } },
          data: { rpcAvailableBalance: { decrement: buyerTotalPay } },
        });
        if (debited.count !== 1) {
          if (taker.remainingQuantity === taker.quantity) throw new Error('Saldo RPC insuficiente para compra a mercado.');
          break;
        }
      }
    } else {
      if (maker.lockedCash.lessThan(buyerTotalPay)) {
        throw new Error('Saldo bloqueado do comprador em ordem limite está inconsistente.');
      }
      const debited = await tx.wallet.updateMany({
        where: { id: buyerWallet.id, rpcLockedBalance: { gte: buyerTotalPay } },
        data: { rpcLockedBalance: { decrement: buyerTotalPay } },
      });
      if (debited.count !== 1) throw new Error('Saldo bloqueado do comprador em ordem limite está inconsistente.');
    }

    if (sellerIsTaker) {
      await subtractSharesFromSeller(tx, {
        userId: sellerId,
        companyId: company.id,
        quantity: tradeQuantity,
        currentPrice: company.currentPrice,
      });
    } else {
      if (maker.lockedShares < tradeQuantity) {
        throw new Error('Tokens bloqueados da ordem limite estão inconsistentes.');
      }
    }

    await tx.wallet.update({
      where: { id: sellerWallet.id },
      data: { rpcAvailableBalance: { increment: sellerNetReceive } },
    });

    await addSharesToBuyer(tx, {
      userId: buyerId,
      companyId: company.id,
      quantity: tradeQuantity,
      tradeGrossAmount: grossAmount,
      currentPrice: unitPrice,
    });

    const takerRemaining = taker.remainingQuantity - tradeQuantity;
    const makerRemaining = maker.remainingQuantity - tradeQuantity;

    const takerOrderUpdateData = {
      remainingQuantity: takerRemaining,
      status: statusFromRemaining({ quantity: taker.quantity, remainingQuantity: takerRemaining }),
      executedAt: takerRemaining === 0 ? new Date() : null,
      lockedCash: taker.type === 'BUY' && taker.mode === 'LIMIT' ? taker.lockedCash.sub(buyerTotalPay) : taker.lockedCash,
      lockedShares: taker.type === 'SELL' && taker.mode === 'LIMIT' ? taker.lockedShares - tradeQuantity : taker.lockedShares,
    };

    const makerOrderUpdateData = {
      remainingQuantity: makerRemaining,
      status: statusFromRemaining({ quantity: maker.quantity, remainingQuantity: makerRemaining }),
      executedAt: makerRemaining === 0 ? new Date() : null,
      lockedCash: maker.type === 'BUY' ? maker.lockedCash.sub(buyerTotalPay) : maker.lockedCash,
      lockedShares: maker.type === 'SELL' ? maker.lockedShares - tradeQuantity : maker.lockedShares,
    };

    taker.remainingQuantity = takerRemaining;
    taker.lockedCash = toDecimal(takerOrderUpdateData.lockedCash as Decimal);
    taker.lockedShares = (takerOrderUpdateData.lockedShares as number) ?? taker.lockedShares;

    if (takerOrderUpdateData.lockedCash.lessThan(0) || (takerOrderUpdateData.lockedShares as number) < 0) {
      throw new Error('Consistência inválida na ordem taker: bloqueios negativos.');
    }

    if (makerOrderUpdateData.lockedCash.lessThan(0) || (makerOrderUpdateData.lockedShares as number) < 0) {
      throw new Error('Consistência inválida na ordem maker: bloqueios negativos.');
    }

    await tx.marketOrder.update({ where: { id: taker.id }, data: takerOrderUpdateData });
    await tx.marketOrder.update({ where: { id: maker.id }, data: makerOrderUpdateData });

    const trade = await tx.trade.create({
      data: {
        companyId: company.id,
        buyerId,
        sellerId,
        buyOrderId: taker.type === 'BUY' ? taker.id : maker.id,
        sellOrderId: taker.type === 'SELL' ? taker.id : maker.id,
        quantity: tradeQuantity,
        unitPrice,
        grossAmount,
        buyFeeAmount,
        sellFeeAmount,
      },
    });

    await distributeFee(tx, {
      companyId: company.id,
      tradeId: trade.id,
      sourceType: 'MARKET_TRADE_TOTAL_FEE',
      totalFeeAmount: buyFeeAmount.add(sellFeeAmount),
    });

    await tx.company.update({
      where: { id: company.id },
      data: {
        currentPrice: unitPrice,
        fictitiousMarketCap: unitPrice.mul(company.totalShares),
      },
    });

    await tx.transaction.create({
      data: {
        walletId: buyerWallet.id,
        type: 'MARKET_TRADE_BUY',
        amount: buyerTotalPay,
        description: `Compra de ${tradeQuantity} token(s) de ${company.ticker} a ${unitPrice.toString()} por token`,
      },
    });

    await tx.transaction.create({
      data: {
        walletId: sellerWallet.id,
        type: 'MARKET_TRADE_SELL',
        amount: sellerNetReceive,
        description: `Venda de ${tradeQuantity} token(s) de ${company.ticker} a ${unitPrice.toString()} por token`,
      },
    });

    await tx.companyOperation.create({
      data: {
        companyId: company.id,
        userId: taker.userId,
        type: 'MARKET_TRADE_EXECUTED',
        quantity: tradeQuantity,
        unitPrice,
        grossAmount,
        feeAmount: buyFeeAmount.add(sellFeeAmount),
        totalAmount: buyerTotalPay,
        description: `Trade executado entre comprador ${buyerId} e vendedor ${sellerId}.`,
      },
    });

    await tx.adminLog.create({
      data: {
        userId: taker.userId,
        action: 'MARKET_TRADE_EXECUTED',
        entity: 'Trade',
        reason: `Trade executado para ${company.ticker}`,
        current: JSON.stringify({ tradeId: trade.id, companyId: company.id, quantity: tradeQuantity, unitPrice: unitPrice.toString() }),
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
  }

  if (taker.mode === 'MARKET') {
    const finalStatus = taker.remainingQuantity === 0 ? 'FILLED' : taker.remainingQuantity < taker.quantity ? 'PARTIALLY_FILLED' : 'REJECTED';
    await tx.marketOrder.update({
      where: { id: taker.id },
      data: {
        status: finalStatus,
        executedAt: new Date(),
      },
    });
  }

  const refreshed = await tx.marketOrder.findUnique({ where: { id: taker.id } });
  if (refreshed && refreshed.mode === 'LIMIT' && refreshed.type === 'BUY' && refreshed.remainingQuantity === 0 && refreshed.lockedCash.greaterThan(0)) {
    const buyerWallet = await ensureWallet(tx, refreshed.userId);
    const refunded = await tx.wallet.updateMany({
      where: { id: buyerWallet.id, rpcLockedBalance: { gte: refreshed.lockedCash } },
      data: {
        rpcLockedBalance: { decrement: refreshed.lockedCash },
        rpcAvailableBalance: { increment: refreshed.lockedCash },
      },
    });
    if (refunded.count !== 1) throw new Error('Falha de consistência no reembolso de sobra da ordem limite de compra.');
    await tx.marketOrder.update({ where: { id: refreshed.id }, data: { lockedCash: ZERO } });
  }
}

export async function marketRoutes(app: FastifyInstance) {
  app.post('/market/orders', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;

    try {
      await assertFinancialPermission(authRequest.user.sub, 'COMPANY_MARKET_TRADE');
      const body = createOrderSchema.parse(request.body);
      const openOrdersCount = await prisma.marketOrder.count({
        where: {
          userId: authRequest.user.sub,
          status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
        },
      });
      if (openOrdersCount >= COMPANY_MARKET_MAX_OPEN_ORDERS_PER_USER) {
        return reply.status(429).send({
          message: 'Limite de ordens abertas atingido. Cancele ordens antigas antes de criar novas.',
        });
      }

      const order = await prisma.$transaction(async (tx: Tx) => {
        const company = await getCompanyOrThrow(tx, body.companyId);
        const wallet = await ensureWallet(tx, authRequest.user.sub);

        const limitPrice = new Decimal(body.limitPrice);
        const gross = limitPrice.mul(body.quantity);

        let lockedCash = ZERO;
        let lockedShares = 0;

        if (body.type === 'BUY') {
          const fee = gross.mul(company.buyFeePercent).div(100);
          lockedCash = gross.add(fee);

          if (wallet.rpcAvailableBalance.lessThan(lockedCash)) {
            throw new Error('Saldo insuficiente para bloquear ordem limitada de compra.');
          }

          await tx.wallet.update({
            where: { id: wallet.id },
            data: {
              rpcAvailableBalance: wallet.rpcAvailableBalance.sub(lockedCash),
              rpcLockedBalance: wallet.rpcLockedBalance.add(lockedCash),
            },
          });
        }

        if (body.type === 'SELL') {
          const holding = await getHolding(tx, authRequest.user.sub, body.companyId);
          if (!holding || holding.shares < body.quantity) {
            throw new Error('Você não possui tokens suficientes para criar ordem de venda.');
          }

          lockedShares = body.quantity;
          await tx.companyHolding.update({
            where: { id: holding.id },
            data: {
              shares: holding.shares - body.quantity,
            },
          });
        }

        const created = await tx.marketOrder.create({
          data: {
            companyId: body.companyId,
            userId: authRequest.user.sub,
            type: body.type,
            mode: 'LIMIT',
            quantity: body.quantity,
            remainingQuantity: body.quantity,
            limitPrice,
            lockedCash,
            lockedShares,
            status: 'OPEN',
          },
        });

        await tx.companyOperation.create({
          data: {
            companyId: body.companyId,
            userId: authRequest.user.sub,
            type: 'MARKET_ORDER_CREATE',
            quantity: body.quantity,
            unitPrice: limitPrice,
            totalAmount: lockedCash,
            description: `Ordem limitada ${body.type} criada`,
          },
        });

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'MARKET_ORDER_CREATE',
            entity: 'MarketOrder',
            reason: `Ordem limitada ${body.type}`,
            current: JSON.stringify({ companyId: body.companyId, quantity: body.quantity, limitPrice: body.limitPrice, type: body.type }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });

        await runMatching(tx, created.id, { ip: request.ip, userAgent: request.headers['user-agent'] ?? undefined });
        return tx.marketOrder.findUnique({ where: { id: created.id } });
      }, MARKET_TRANSACTION_OPTIONS);

      return reply.code(201).send({ order });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.get('/market/orders/me', { preHandler: [app.authenticate] }, async (request) => {
    const authRequest = request as AuthRequest;

    const orders = await prisma.marketOrder.findMany({
      where: { userId: authRequest.user.sub },
      include: {
        company: { select: { id: true, name: true, ticker: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return { orders };
  });

  app.get('/market/companies/:companyId/order-book', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { companyId } = companyParams.parse(request.params);
      const company = await prisma.company.findUnique({ where: { id: companyId }, select: { status: true } });
      if (!company || company.status !== 'ACTIVE') {
        throw new Error('Mercado não disponível.');
      }

      const [buyOrders, sellOrders] = await Promise.all([
        prisma.marketOrder.findMany({
          where: { companyId, type: 'BUY', mode: 'LIMIT', status: { in: ['OPEN', 'PARTIALLY_FILLED'] }, remainingQuantity: { gt: 0 } },
          orderBy: [{ limitPrice: 'desc' }, { createdAt: 'asc' }],
        }),
        prisma.marketOrder.findMany({
          where: { companyId, type: 'SELL', mode: 'LIMIT', status: { in: ['OPEN', 'PARTIALLY_FILLED'] }, remainingQuantity: { gt: 0 } },
          orderBy: [{ limitPrice: 'asc' }, { createdAt: 'asc' }],
        }),
      ]);

      return { buyOrders, sellOrders };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.post('/market/orders/:id/cancel', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: MAX_ORDER_CANCELS_PER_MINUTE, timeWindow: '1 minute', errorResponseBuilder: () => ({ message: 'Muitas tentativas de cancelamento. Aguarde um minuto e tente novamente.' }) } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;

    try {
      const { id } = cancelOrderParams.parse(request.params);
      const canceled = await prisma.$transaction(async (tx: Tx) => {
        const order = await tx.marketOrder.findUnique({ where: { id } });
        if (!order) throw new Error('Ordem não encontrada.');
        if (order.userId !== authRequest.user.sub) throw new Error('Sem permissão para cancelar esta ordem.');
        if (!['OPEN', 'PARTIALLY_FILLED'].includes(order.status)) throw new Error('Somente ordens abertas podem ser canceladas.');
        return cancelOrderWithRelease(tx, {
          orderId: order.id,
          canceledByUserId: authRequest.user.sub,
          reason: `Cancelamento da ordem ${order.id}`,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      }, MARKET_TRANSACTION_OPTIONS);

      return { order: canceled };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.post('/market/companies/:companyId/buy-market', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: MAX_COMPANY_TRADES_PER_MINUTE, timeWindow: '1 minute', errorResponseBuilder: () => ({ message: 'Muitas negociações em sequência. Aguarde um minuto e tente novamente.' }) } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;

    try {
      await assertFinancialPermission(authRequest.user.sub, 'COMPANY_MARKET_TRADE');
      const { companyId } = companyParams.parse(request.params);
      const body = marketOrderSchema.parse(request.body);

      const result = await prisma.$transaction(async (tx: Tx) => {
        await getCompanyOrThrow(tx, companyId);

        const order = await tx.marketOrder.create({
          data: {
            companyId,
            userId: authRequest.user.sub,
            type: 'BUY',
            mode: 'MARKET',
            quantity: body.quantity,
            remainingQuantity: body.quantity,
            slippagePercent: body.slippagePercent,
            status: 'OPEN',
          },
        });

        await runMatching(tx, order.id, { ip: request.ip, userAgent: request.headers['user-agent'] ?? undefined });
        return tx.marketOrder.findUnique({ where: { id: order.id } });
      }, MARKET_TRANSACTION_OPTIONS);

      return reply.code(201).send({ order: result });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.post('/market/companies/:companyId/sell-market', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: MAX_COMPANY_TRADES_PER_MINUTE, timeWindow: '1 minute', errorResponseBuilder: () => ({ message: 'Muitas negociações em sequência. Aguarde um minuto e tente novamente.' }) } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;

    try {
      await assertFinancialPermission(authRequest.user.sub, 'COMPANY_MARKET_TRADE');
      const { companyId } = companyParams.parse(request.params);
      const body = marketOrderSchema.parse(request.body);

      const result = await prisma.$transaction(async (tx: Tx) => {
        await getCompanyOrThrow(tx, companyId);

        const holding = await getHolding(tx, authRequest.user.sub, companyId);
        if (!holding || holding.shares < body.quantity) {
          throw new Error('Você não possui tokens suficientes para venda a mercado.');
        }

        const order = await tx.marketOrder.create({
          data: {
            companyId,
            userId: authRequest.user.sub,
            type: 'SELL',
            mode: 'MARKET',
            quantity: body.quantity,
            remainingQuantity: body.quantity,
            slippagePercent: body.slippagePercent,
            status: 'OPEN',
          },
        });

        await runMatching(tx, order.id, { ip: request.ip, userAgent: request.headers['user-agent'] ?? undefined });
        return tx.marketOrder.findUnique({ where: { id: order.id } });
      }, MARKET_TRANSACTION_OPTIONS);

      return reply.code(201).send({ order: result });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.get('/market/companies/:companyId/trades', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { companyId } = companyParams.parse(request.params);
      const company = await prisma.company.findUnique({ where: { id: companyId }, select: { status: true } });
      if (!company || company.status !== 'ACTIVE') {
        throw new Error('Mercado não disponível.');
      }

      const trades = await prisma.trade.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      return { trades };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });
}
