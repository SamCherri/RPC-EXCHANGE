import { Decimal } from '@prisma/client/runtime/library';
import { Prisma } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { RPC_MARKET_BUY_FEE_PERCENT, RPC_MARKET_SELL_FEE_PERCENT } from '../constants/fee-rules.js';
import { ensurePlatformAccount } from '../services/fee-distribution-service.js';
import { assertFinancialPermission } from '../services/registration-approval-service.js';
import { MAX_ORDER_CANCELS_PER_MINUTE, MAX_RPC_TRADES_PER_MINUTE, RPC_MARKET_MAX_OPEN_ORDERS_PER_USER } from '../config/anti-abuse-limits.js';

const MIN_AMOUNT = new Decimal('0.01');
const PRICE_SCALE = 8;
const RESERVE_SCALE = 2;
const RPC_MARKET_STATE_ID = 'RPC_MARKET_MAIN';
const HUNDRED = new Decimal(100);


const ADMIN_ROLES = ['SUPER_ADMIN', 'COIN_CHIEF_ADMIN'];

function hasAdminLiquidityRole(roles: string[]) {
  return roles.some((role) => ADMIN_ROLES.includes(role));
}

const amountSchema = z.object({
  fiatAmount: z.coerce.number().min(0.01).optional(),
  rpcAmount: z.coerce.number().min(0.01).optional(),
});

const limitOrderCreateSchema = z.object({
  side: z.enum(['BUY_RPC','SELL_RPC']),
  fiatAmount: z.coerce.number().min(0.01, 'Valor mínimo para ordem é 0,01.').optional(),
  rpcAmount: z.coerce.number().min(0.01, 'Valor mínimo para ordem é 0,01.').optional(),
  limitPrice: z.coerce.number().positive('Preço limite deve ser maior que zero.'),
});

function isRoleAllowedToProcess(roles: string[]) {
  return roles.some((role) => ADMIN_ROLES.includes(role));
}

async function creditRpcMarketFee(tx: Prisma.TransactionClient, feeAmount: Decimal, userId: string, description: string) {
  if (feeAmount.lte(0)) return;
  const platformAccount = await ensurePlatformAccount(tx);
  await tx.platformAccount.update({
    where: { id: platformAccount.id },
    data: {
      balance: { increment: feeAmount },
      totalReceivedFees: { increment: feeAmount },
    },
  });
  await tx.adminLog.create({
    data: {
      userId,
      action: 'RPC_MARKET_FEE_CREDITED',
      entity: 'PlatformAccount',
      reason: description,
      current: JSON.stringify({ feeAmount: feeAmount.toString() }),
    },
  });
}

async function processEligibleRpcLimitOrders(options?: { maxOrders?: number }) {
  const maxOrders = Math.min(Math.max(options?.maxOrders ?? 20, 1), 20);
  const state = await ensureMarketState();
  const [buyCandidates, sellCandidates] = await Promise.all([
    prisma.rpcLimitOrder.findMany({
      where: { status: 'OPEN', side: 'BUY_RPC', limitPrice: { gte: state.currentPrice } },
      orderBy: [{ limitPrice: 'desc' }, { createdAt: 'asc' }],
      take: 200,
    }),
    prisma.rpcLimitOrder.findMany({
      where: { status: 'OPEN', side: 'SELL_RPC', limitPrice: { lte: state.currentPrice } },
      orderBy: [{ limitPrice: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    }),
  ]);

  const eligible = [...buyCandidates, ...sellCandidates].sort((a, b) => {
    if (a.side !== b.side) return a.side === 'BUY_RPC' ? -1 : 1;
    if (a.side === 'BUY_RPC') {
      if (!a.limitPrice.eq(b.limitPrice)) return b.limitPrice.comparedTo(a.limitPrice);
    } else if (!a.limitPrice.eq(b.limitPrice)) return a.limitPrice.comparedTo(b.limitPrice);
    return a.createdAt.getTime() - b.createdAt.getTime();
  }).slice(0, maxOrders);

  let processed = 0;
  for (const candidate of eligible) {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM "RpcMarketState" WHERE id = ${RPC_MARKET_STATE_ID} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "RpcLimitOrder" WHERE id = ${candidate.id} FOR UPDATE`;
      const order = await tx.rpcLimitOrder.findUnique({ where: { id: candidate.id } });
      if (!order || order.status !== 'OPEN') return;
      const wallet = await tx.wallet.findUnique({ where: { userId: order.userId } });
      if (!wallet) return;
      const marketState = await tx.rpcMarketState.findUniqueOrThrow({ where: { id: RPC_MARKET_STATE_ID } });
      if (order.side === 'BUY_RPC') {
        if (!order.fiatAmount || order.lockedFiatAmount.lt(order.fiatAmount) || wallet.fiatLockedBalance.lt(order.lockedFiatAmount)) return;
        if (marketState.currentPrice.gt(order.limitPrice)) return;
        const feeAmount = order.fiatAmount.mul(RPC_MARKET_BUY_FEE_PERCENT).div(HUNDRED).toDecimalPlaces(2);
        const netFiatAmount = order.fiatAmount.sub(feeAmount).toDecimalPlaces(2);
        const quote = buildBuyQuote(marketState, netFiatAmount);
        const effectiveUnitPrice = order.fiatAmount.div(quote.rpcAmount).toDecimalPlaces(PRICE_SCALE);
        if (effectiveUnitPrice.gt(order.limitPrice)) return;
        const moved = await tx.wallet.updateMany({ where: { id: wallet.id, fiatLockedBalance: { gte: order.lockedFiatAmount } }, data: { fiatLockedBalance: { decrement: order.lockedFiatAmount }, rpcAvailableBalance: { increment: quote.rpcAmount } } });
        if (moved.count !== 1) return;
        await creditRpcMarketFee(tx, feeAmount, order.userId, `Taxa RPC limite BUY executada: ${order.id}`);
        await tx.rpcMarketState.update({ where: { id: RPC_MARKET_STATE_ID }, data: { fiatReserve: quote.newFiatReserve, rpcReserve: quote.newRpcReserve, currentPrice: quote.priceAfter, totalFiatVolume: { increment: netFiatAmount }, totalRpcVolume: { increment: quote.rpcAmount }, totalBuys: { increment: 1 } } });
        await tx.rpcExchangeTrade.create({ data: { userId: order.userId, side: 'BUY_RPC', fiatAmount: order.fiatAmount, rpcAmount: quote.rpcAmount, unitPrice: order.fiatAmount.div(quote.rpcAmount).toDecimalPlaces(PRICE_SCALE), priceBefore: quote.priceBefore, priceAfter: quote.priceAfter } });
        await tx.transaction.create({ data: { walletId: wallet.id, type: 'RPC_LIMIT_BUY_FILLED', amount: order.fiatAmount, description: `Ordem limite RPC BUY executada: ${order.id}` } });
        await tx.transaction.create({ data: { walletId: wallet.id, type: 'RPC_LIMIT_BUY_FEE', amount: feeAmount, description: `Taxa ordem limite RPC BUY: ${order.id}` } });
        await tx.rpcLimitOrder.update({ where: { id: order.id }, data: { status: 'FILLED', executedAt: new Date(), filledFiatAmount: order.fiatAmount, filledRpcAmount: quote.rpcAmount, lockedFiatAmount: new Decimal('0') } });
        processed += 1;
        return;
      }
      if (!order.rpcAmount || order.lockedRpcAmount.lt(order.rpcAmount) || wallet.rpcLockedBalance.lt(order.lockedRpcAmount)) return;
      if (marketState.currentPrice.lt(order.limitPrice)) return;
      const quote = buildSellQuote(marketState, order.rpcAmount);
      const feeAmount = quote.fiatAmount.mul(RPC_MARKET_SELL_FEE_PERCENT).div(HUNDRED).toDecimalPlaces(2);
      const netFiatAmount = quote.fiatAmount.sub(feeAmount).toDecimalPlaces(2);
      const effectiveUnitPrice = netFiatAmount.div(order.rpcAmount).toDecimalPlaces(PRICE_SCALE);
      if (effectiveUnitPrice.lt(order.limitPrice)) return;
      const moved = await tx.wallet.updateMany({ where: { id: wallet.id, rpcLockedBalance: { gte: order.lockedRpcAmount } }, data: { rpcLockedBalance: { decrement: order.lockedRpcAmount }, fiatAvailableBalance: { increment: netFiatAmount } } });
      if (moved.count !== 1) return;
      await creditRpcMarketFee(tx, feeAmount, order.userId, `Taxa RPC limite SELL executada: ${order.id}`);
      await tx.rpcMarketState.update({ where: { id: RPC_MARKET_STATE_ID }, data: { fiatReserve: quote.newFiatReserve, rpcReserve: quote.newRpcReserve, currentPrice: quote.priceAfter, totalFiatVolume: { increment: quote.fiatAmount }, totalRpcVolume: { increment: order.rpcAmount }, totalSells: { increment: 1 } } });
      await tx.rpcExchangeTrade.create({ data: { userId: order.userId, side: 'SELL_RPC', fiatAmount: netFiatAmount, rpcAmount: order.rpcAmount, unitPrice: netFiatAmount.div(order.rpcAmount).toDecimalPlaces(PRICE_SCALE), priceBefore: quote.priceBefore, priceAfter: quote.priceAfter } });
      await tx.transaction.create({ data: { walletId: wallet.id, type: 'RPC_LIMIT_SELL_FILLED', amount: quote.fiatAmount, description: `Ordem limite RPC SELL executada: ${order.id}` } });
      await tx.transaction.create({ data: { walletId: wallet.id, type: 'RPC_LIMIT_SELL_FEE', amount: feeAmount, description: `Taxa ordem limite RPC SELL: ${order.id}` } });
      await tx.rpcLimitOrder.update({ where: { id: order.id }, data: { status: 'FILLED', executedAt: new Date(), filledFiatAmount: quote.fiatAmount, filledRpcAmount: order.rpcAmount, lockedRpcAmount: new Decimal('0') } });
      processed += 1;
    });
  }
  return { processed };
}

function toDecimal(value: string | number | Decimal) {
  return value instanceof Decimal ? value : new Decimal(value);
}

function ensurePositive(value: Decimal, message: string) {
  if (value.lte(0)) throw new Error(message);
}

async function ensureMarketState() {
  return prisma.rpcMarketState.upsert({
    where: { id: RPC_MARKET_STATE_ID },
    update: {},
    create: {
      id: RPC_MARKET_STATE_ID,
      currentPrice: new Decimal('1.00000000'),
      fiatReserve: new Decimal('1000000.00'),
      rpcReserve: new Decimal('1000000.00'),
    },
  });
}

function buildBuyQuote(state: { currentPrice: Decimal; fiatReserve: Decimal; rpcReserve: Decimal }, fiatAmount: Decimal) {
  const k = toDecimal(state.fiatReserve).mul(state.rpcReserve);
  const newFiatReserve = toDecimal(state.fiatReserve).add(fiatAmount);
  const newRpcReserve = k.div(newFiatReserve).toDecimalPlaces(RESERVE_SCALE);
  ensurePositive(newRpcReserve, 'Liquidez RPC insuficiente para esta operação.');
  const rpcAmount = toDecimal(state.rpcReserve).sub(newRpcReserve).toDecimalPlaces(2);
  if (rpcAmount.lt(MIN_AMOUNT)) throw new Error('Operação muito pequena para execução.');
  const priceAfter = newFiatReserve.div(newRpcReserve).toDecimalPlaces(PRICE_SCALE);
  const unitPrice = fiatAmount.div(rpcAmount).toDecimalPlaces(PRICE_SCALE);
  return { rpcAmount, priceBefore: state.currentPrice, priceAfter, unitPrice, newFiatReserve, newRpcReserve };
}

function buildSellQuote(state: { currentPrice: Decimal; fiatReserve: Decimal; rpcReserve: Decimal }, rpcAmount: Decimal) {
  const k = toDecimal(state.fiatReserve).mul(state.rpcReserve);
  const newRpcReserve = toDecimal(state.rpcReserve).add(rpcAmount);
  const newFiatReserve = k.div(newRpcReserve).toDecimalPlaces(RESERVE_SCALE);
  ensurePositive(newFiatReserve, 'Liquidez fiat insuficiente para esta operação.');
  const fiatAmount = toDecimal(state.fiatReserve).sub(newFiatReserve).toDecimalPlaces(2);
  if (fiatAmount.lt(MIN_AMOUNT)) throw new Error('Operação muito pequena para execução.');
  const priceAfter = newFiatReserve.div(newRpcReserve).toDecimalPlaces(PRICE_SCALE);
  const unitPrice = fiatAmount.div(rpcAmount).toDecimalPlaces(PRICE_SCALE);
  return { fiatAmount, priceBefore: state.currentPrice, priceAfter, unitPrice, newFiatReserve, newRpcReserve };
}

export async function rpcMarketRoutes(app: FastifyInstance) {
  app.get('/rpc-market', async () => ensureMarketState());

  app.get('/rpc-market/quote-buy', async (request, reply) => {
    try {
      const query = z.object({ fiatAmount: z.coerce.number().min(0.01) }).parse(request.query ?? {});
      const fiatAmount = toDecimal(query.fiatAmount).toDecimalPlaces(2);
      const state = await ensureMarketState();
      const feeAmount = fiatAmount.mul(RPC_MARKET_BUY_FEE_PERCENT).div(HUNDRED).toDecimalPlaces(2);
      const netFiatAmount = fiatAmount.sub(feeAmount).toDecimalPlaces(2);
      const quote = buildBuyQuote(state, netFiatAmount);
      return {
        grossFiatAmount: fiatAmount,
        netFiatAmount,
        feeAmount,
        feePercent: RPC_MARKET_BUY_FEE_PERCENT,
        estimatedRpcAmount: quote.rpcAmount,
        effectiveUnitPrice: fiatAmount.div(quote.rpcAmount).toDecimalPlaces(PRICE_SCALE),
      };
    } catch (error) {
      return reply.status(400).send({ message: (error as Error).message });
    }
  });

  app.get('/rpc-market/quote-sell', async (request, reply) => {
    try {
      const query = z.object({ rpcAmount: z.coerce.number().min(0.01) }).parse(request.query ?? {});
      const rpcAmount = toDecimal(query.rpcAmount).toDecimalPlaces(2);
      const state = await ensureMarketState();
      const quote = buildSellQuote(state, rpcAmount);
      const feeAmount = quote.fiatAmount.mul(RPC_MARKET_SELL_FEE_PERCENT).div(HUNDRED).toDecimalPlaces(2);
      const netFiatAmount = quote.fiatAmount.sub(feeAmount).toDecimalPlaces(2);
      return {
        rpcAmount,
        grossFiatAmount: quote.fiatAmount,
        netFiatAmount,
        feeAmount,
        feePercent: RPC_MARKET_SELL_FEE_PERCENT,
        estimatedFiatAmount: netFiatAmount,
        grossEstimatedFiatAmount: quote.fiatAmount,
        effectiveUnitPrice: netFiatAmount.div(rpcAmount).toDecimalPlaces(PRICE_SCALE),
      };
    } catch (error) {
      return reply.status(400).send({ message: (error as Error).message });
    }
  });

  app.get('/rpc-market/trades', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query ?? {});
    const trades = await prisma.rpcExchangeTrade.findMany({ orderBy: { createdAt: 'desc' }, take: query.limit ?? 50,
      select: { id: true, side: true, fiatAmount: true, rpcAmount: true, unitPrice: true, priceBefore: true, priceAfter: true, createdAt: true } });
    return { trades };
  });

  app.post('/rpc-market/buy', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: MAX_RPC_TRADES_PER_MINUTE, timeWindow: '1 minute', errorResponseBuilder: () => ({ message: 'Muitas negociações em sequência. Aguarde um minuto e tente novamente.' }) } } }, async (request, reply) => {
    try {
      await assertFinancialPermission((request.user as { sub: string }).sub, 'RPC_MARKET_TRADE');
      const body = amountSchema.parse(request.body ?? {});
      if (body.fiatAmount == null) return reply.status(400).send({ message: 'fiatAmount é obrigatório.' });
      const grossFiatAmount = toDecimal(body.fiatAmount).toDecimalPlaces(2);
      if (grossFiatAmount.lt(MIN_AMOUNT)) return reply.status(400).send({ message: 'Valor mínimo para compra é R$ 0,01.' });

      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const wallet = await tx.wallet.findUnique({ where: { userId: (request.user as { sub: string }).sub } });
        if (!wallet) throw new Error('Carteira não encontrada.');

        await tx.rpcMarketState.upsert({ where: { id: RPC_MARKET_STATE_ID }, update: {}, create: { id: RPC_MARKET_STATE_ID, currentPrice: new Decimal('1.00000000'), fiatReserve: new Decimal('1000000.00'), rpcReserve: new Decimal('1000000.00') } });
        await tx.$queryRaw`SELECT id FROM "RpcMarketState" WHERE id = ${RPC_MARKET_STATE_ID} FOR UPDATE`;
        const state = await tx.rpcMarketState.findUniqueOrThrow({ where: { id: RPC_MARKET_STATE_ID } });

        const feeAmount = grossFiatAmount.mul(RPC_MARKET_BUY_FEE_PERCENT).div(HUNDRED).toDecimalPlaces(2);
        const netFiatAmount = grossFiatAmount.sub(feeAmount).toDecimalPlaces(2);
        const quote = buildBuyQuote(state, netFiatAmount);
        const updatedWallet = await tx.wallet.updateMany({ where: { id: wallet.id, fiatAvailableBalance: { gte: grossFiatAmount } }, data: { fiatAvailableBalance: { decrement: grossFiatAmount }, rpcAvailableBalance: { increment: quote.rpcAmount } } });
        if (updatedWallet.count !== 1) throw new Error('Saldo insuficiente.');
        await creditRpcMarketFee(tx, feeAmount, (request.user as { sub: string }).sub, 'Taxa RPC mercado BUY');
        await tx.rpcMarketState.update({ where: { id: RPC_MARKET_STATE_ID }, data: { fiatReserve: quote.newFiatReserve, rpcReserve: quote.newRpcReserve, currentPrice: quote.priceAfter, totalFiatVolume: { increment: netFiatAmount }, totalRpcVolume: { increment: quote.rpcAmount }, totalBuys: { increment: 1 } } });
        await tx.rpcExchangeTrade.create({ data: { userId: (request.user as { sub: string }).sub, side: 'BUY_RPC', fiatAmount: grossFiatAmount, rpcAmount: quote.rpcAmount, unitPrice: grossFiatAmount.div(quote.rpcAmount).toDecimalPlaces(PRICE_SCALE), priceBefore: quote.priceBefore, priceAfter: quote.priceAfter } });
        await tx.transaction.create({ data: { walletId: wallet.id, type: 'RPC_MARKET_BUY', amount: grossFiatAmount, description: 'Compra de RPC com R$ (valor bruto)' } });
        await tx.transaction.create({ data: { walletId: wallet.id, type: 'RPC_MARKET_BUY_FEE', amount: feeAmount, description: 'Taxa da Exchange na compra RPC/R$' } });
        const latestWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
        return { grossFiatAmount, netFiatAmount, feeAmount, feePercent: RPC_MARKET_BUY_FEE_PERCENT, rpcAmount: quote.rpcAmount, priceBefore: quote.priceBefore, priceAfter: quote.priceAfter, wallet: latestWallet };
      });

      try { await processEligibleRpcLimitOrders({ maxOrders: 10 }); } catch (error) { request.log.warn({ error }, 'Falha ao processar ordens limite após buy'); }
      return { message: 'RPC comprado com sucesso.', grossFiatAmount: result.grossFiatAmount, netFiatAmount: result.netFiatAmount, feeAmount: result.feeAmount, feePercent: result.feePercent, rpcAmount: result.rpcAmount, priceBefore: result.priceBefore, priceAfter: result.priceAfter, wallet: { fiatAvailableBalance: result.wallet.fiatAvailableBalance, rpcAvailableBalance: result.wallet.rpcAvailableBalance } };
    } catch (error) {
      return reply.status(400).send({ message: (error as Error).message });
    }
  });


  app.get('/rpc-market/orders/me', { preHandler: [app.authenticate] }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const orders = await prisma.rpcLimitOrder.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return { orders };
  });

  app.get('/rpc-market/order-book', async () => {
    const [buyOrders, sellOrders] = await Promise.all([
      prisma.rpcLimitOrder.findMany({ where: { side: 'BUY_RPC', status: 'OPEN' }, orderBy: [{ limitPrice: 'desc' }, { createdAt: 'asc' }], take: 50, select: { id: true, side: true, status: true, limitPrice: true, fiatAmount: true, rpcAmount: true, lockedFiatAmount: true, lockedRpcAmount: true, createdAt: true } }),
      prisma.rpcLimitOrder.findMany({ where: { side: 'SELL_RPC', status: 'OPEN' }, orderBy: [{ limitPrice: 'asc' }, { createdAt: 'asc' }], take: 50, select: { id: true, side: true, status: true, limitPrice: true, fiatAmount: true, rpcAmount: true, lockedFiatAmount: true, lockedRpcAmount: true, createdAt: true } }),
    ]);
    return { buyOrders, sellOrders };
  });

  app.post('/rpc-market/orders', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const body = limitOrderCreateSchema.parse(request.body ?? {});
      const userId = (request.user as { sub: string }).sub;
      await assertFinancialPermission(userId, 'RPC_MARKET_TRADE');
      const openOrdersCount = await prisma.rpcLimitOrder.count({ where: { userId, status: 'OPEN' } });
      if (openOrdersCount >= RPC_MARKET_MAX_OPEN_ORDERS_PER_USER) {
        return reply.status(429).send({ message: 'Limite de ordens abertas atingido. Cancele ordens antigas antes de criar novas.' });
      }
      const limitPrice = toDecimal(body.limitPrice).toDecimalPlaces(8);
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        if (!wallet) throw new Error('Carteira não encontrada.');
        if (body.side === 'BUY_RPC') {
          if (body.fiatAmount == null || body.rpcAmount != null) throw new Error('Para compra limite, envie apenas fiatAmount.');
          const fiatAmount = toDecimal(body.fiatAmount).toDecimalPlaces(2);
          if (fiatAmount.lt(new Decimal('0.01'))) throw new Error('Valor mínimo para ordem é 0,01.');
          const locked = await tx.wallet.updateMany({ where: { id: wallet.id, fiatAvailableBalance: { gte: fiatAmount } }, data: { fiatAvailableBalance: { decrement: fiatAmount }, fiatLockedBalance: { increment: fiatAmount } } });
          if (locked.count !== 1) throw new Error('Saldo insuficiente.');
          return tx.rpcLimitOrder.create({ data: { userId, side: 'BUY_RPC', fiatAmount, limitPrice, lockedFiatAmount: fiatAmount } });
        }
        if (body.rpcAmount == null || body.fiatAmount != null) throw new Error('Para venda limite, envie apenas rpcAmount.');
        const rpcAmount = toDecimal(body.rpcAmount).toDecimalPlaces(2);
        if (rpcAmount.lt(new Decimal('0.01'))) throw new Error('Valor mínimo para ordem é 0,01.');
        const locked = await tx.wallet.updateMany({ where: { id: wallet.id, rpcAvailableBalance: { gte: rpcAmount } }, data: { rpcAvailableBalance: { decrement: rpcAmount }, rpcLockedBalance: { increment: rpcAmount } } });
        if (locked.count !== 1) throw new Error('Saldo insuficiente.');
        return tx.rpcLimitOrder.create({ data: { userId, side: 'SELL_RPC', rpcAmount, limitPrice, lockedRpcAmount: rpcAmount } });
      });
      return reply.status(201).send({ message: 'Ordem limite criada com sucesso.', order: result });
    } catch (error) {
      return reply.status(400).send({ message: (error as Error).message });
    }
  });

  app.post('/rpc-market/orders/:id/cancel', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: MAX_ORDER_CANCELS_PER_MINUTE, timeWindow: '1 minute', errorResponseBuilder: () => ({ message: 'Muitas tentativas de cancelamento. Aguarde um minuto e tente novamente.' }) } } }, async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params ?? {});
      const userId = (request.user as { sub: string }).sub;
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const order = await tx.rpcLimitOrder.findUnique({ where: { id } });
        if (!order || order.userId !== userId) throw new Error('Ordem não encontrada.');
        if (order.status !== 'OPEN') throw new Error('Somente ordens OPEN podem ser canceladas.');
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        if (!wallet) throw new Error('Carteira não encontrada.');
        if (order.side === 'BUY_RPC') {
          const ok = await tx.wallet.updateMany({ where: { id: wallet.id, fiatLockedBalance: { gte: order.lockedFiatAmount } }, data: { fiatLockedBalance: { decrement: order.lockedFiatAmount }, fiatAvailableBalance: { increment: order.lockedFiatAmount } } });
          if (ok.count !== 1) throw new Error('Falha ao devolver saldo travado.');
        } else {
          const ok = await tx.wallet.updateMany({ where: { id: wallet.id, rpcLockedBalance: { gte: order.lockedRpcAmount } }, data: { rpcLockedBalance: { decrement: order.lockedRpcAmount }, rpcAvailableBalance: { increment: order.lockedRpcAmount } } });
          if (ok.count !== 1) throw new Error('Falha ao devolver saldo travado.');
        }
        return tx.rpcLimitOrder.update({ where: { id }, data: { status: 'CANCELED', canceledAt: new Date(), lockedFiatAmount: new Decimal('0'), lockedRpcAmount: new Decimal('0') } });
      });
      return { message: 'Ordem cancelada com sucesso.', order: result };
    } catch (error) {
      return reply.status(400).send({ message: (error as Error).message });
    }
  });

  app.post('/admin/rpc-market/orders/process', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const roles = ((request.user as { roles?: string[] }).roles ?? []).map((role) => role.toUpperCase());
    if (!isRoleAllowedToProcess(roles)) return reply.status(403).send({ message: 'Sem permissão.' });
    const body = z.object({ maxOrders: z.coerce.number().int().min(1).max(20).optional() }).parse(request.body ?? {});
    const result = await processEligibleRpcLimitOrders({ maxOrders: body.maxOrders ?? 20 });
    return { message: 'Processamento concluído.', ...result };
  });


  app.get('/admin/rpc-market/liquidity', { preHandler: [app.authenticate] }, async (request, reply) => {
    const roles = ((request.user as { roles?: string[] }).roles ?? []).map((role) => role.toUpperCase());
    if (!hasAdminLiquidityRole(roles)) return reply.status(403).send({ message: 'Sem permissão para gerenciar liquidez RPC/R$.' });
    const state = await ensureMarketState();
    return {
      currentPrice: state.currentPrice,
      fiatReserve: state.fiatReserve,
      rpcReserve: state.rpcReserve,
      totalFiatVolume: state.totalFiatVolume,
      totalRpcVolume: state.totalRpcVolume,
      totalBuys: state.totalBuys,
      totalSells: state.totalSells,
      updatedAt: state.updatedAt,
    };
  });

  const liquiditySchema = z.object({
    fiatAmount: z.coerce.number().min(0.01).optional(),
    rpcAmount: z.coerce.number().min(0.01).optional(),
    reason: z.string().min(10),
  }).refine((value) => (value.fiatAmount ?? 0) > 0 || (value.rpcAmount ?? 0) > 0, { message: 'Informe fiatAmount ou rpcAmount maior que zero.' });

  app.post('/admin/rpc-market/liquidity/inject', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 15, timeWindow: '1 minute' } } }, async (request, reply) => {
    const roles = ((request.user as { roles?: string[] }).roles ?? []).map((role) => role.toUpperCase());
    if (!hasAdminLiquidityRole(roles)) return reply.status(403).send({ message: 'Sem permissão para gerenciar liquidez RPC/R$.' });
    try {
      const body = liquiditySchema.parse(request.body ?? {});
      const actorUserId = (request.user as { sub: string }).sub;
      const fiatAmount = toDecimal(body.fiatAmount ?? 0).toDecimalPlaces(2);
      const rpcAmount = toDecimal(body.rpcAmount ?? 0).toDecimalPlaces(2);
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.rpcMarketState.upsert({ where: { id: RPC_MARKET_STATE_ID }, update: {}, create: { id: RPC_MARKET_STATE_ID, currentPrice: new Decimal('1.00000000'), fiatReserve: new Decimal('1000000.00'), rpcReserve: new Decimal('1000000.00') } });
        await tx.$queryRaw`SELECT id FROM "RpcMarketState" WHERE id = ${RPC_MARKET_STATE_ID} FOR UPDATE`;
        const state = await tx.rpcMarketState.findUniqueOrThrow({ where: { id: RPC_MARKET_STATE_ID } });
        const previous = { currentPrice: state.currentPrice.toString(), fiatReserve: state.fiatReserve.toString(), rpcReserve: state.rpcReserve.toString(), totalFiatVolume: state.totalFiatVolume.toString(), totalRpcVolume: state.totalRpcVolume.toString(), totalBuys: state.totalBuys, totalSells: state.totalSells, updatedAt: state.updatedAt.toISOString() };
        const nextFiat = state.fiatReserve.add(fiatAmount).toDecimalPlaces(2);
        const nextRpc = state.rpcReserve.add(rpcAmount).toDecimalPlaces(2);
        ensurePositive(nextFiat, 'Reserva R$ deve permanecer positiva.');
        ensurePositive(nextRpc, 'Reserva RPC deve permanecer positiva.');
        const nextPrice = nextFiat.div(nextRpc).toDecimalPlaces(PRICE_SCALE);
        const updated = await tx.rpcMarketState.update({ where: { id: RPC_MARKET_STATE_ID }, data: { fiatReserve: nextFiat, rpcReserve: nextRpc, currentPrice: nextPrice } });
        const current = { currentPrice: updated.currentPrice.toString(), fiatReserve: updated.fiatReserve.toString(), rpcReserve: updated.rpcReserve.toString(), totalFiatVolume: updated.totalFiatVolume.toString(), totalRpcVolume: updated.totalRpcVolume.toString(), totalBuys: updated.totalBuys, totalSells: updated.totalSells, updatedAt: updated.updatedAt.toISOString(), fiatInjected: fiatAmount.toString(), rpcInjected: rpcAmount.toString() };
        await tx.adminLog.create({ data: { userId: actorUserId, action: 'RPC_MARKET_LIQUIDITY_INJECT', entity: 'RpcMarketState', reason: body.reason.trim(), previous: JSON.stringify(previous), current: JSON.stringify(current) } });
        return updated;
      });
      return { message: 'Liquidez adicionada com sucesso.', state: result };
    } catch (error) {
      return reply.status(400).send({ message: (error as Error).message });
    }
  });

  app.post('/admin/rpc-market/liquidity/withdraw', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 15, timeWindow: '1 minute' } } }, async (request, reply) => {
    const roles = ((request.user as { roles?: string[] }).roles ?? []).map((role) => role.toUpperCase());
    if (!hasAdminLiquidityRole(roles)) return reply.status(403).send({ message: 'Sem permissão para gerenciar liquidez RPC/R$.' });
    try {
      const body = liquiditySchema.parse(request.body ?? {});
      const actorUserId = (request.user as { sub: string }).sub;
      const fiatAmount = toDecimal(body.fiatAmount ?? 0).toDecimalPlaces(2);
      const rpcAmount = toDecimal(body.rpcAmount ?? 0).toDecimalPlaces(2);
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.rpcMarketState.upsert({ where: { id: RPC_MARKET_STATE_ID }, update: {}, create: { id: RPC_MARKET_STATE_ID, currentPrice: new Decimal('1.00000000'), fiatReserve: new Decimal('1000000.00'), rpcReserve: new Decimal('1000000.00') } });
        await tx.$queryRaw`SELECT id FROM "RpcMarketState" WHERE id = ${RPC_MARKET_STATE_ID} FOR UPDATE`;
        const state = await tx.rpcMarketState.findUniqueOrThrow({ where: { id: RPC_MARKET_STATE_ID } });
        const previous = { currentPrice: state.currentPrice.toString(), fiatReserve: state.fiatReserve.toString(), rpcReserve: state.rpcReserve.toString(), totalFiatVolume: state.totalFiatVolume.toString(), totalRpcVolume: state.totalRpcVolume.toString(), totalBuys: state.totalBuys, totalSells: state.totalSells, updatedAt: state.updatedAt.toISOString() };
        const nextFiat = state.fiatReserve.sub(fiatAmount).toDecimalPlaces(2);
        const nextRpc = state.rpcReserve.sub(rpcAmount).toDecimalPlaces(2);
        ensurePositive(nextFiat, 'Reserva R$ não pode ficar menor ou igual a zero.');
        ensurePositive(nextRpc, 'Reserva RPC não pode ficar menor ou igual a zero.');
        const nextPrice = nextFiat.div(nextRpc).toDecimalPlaces(PRICE_SCALE);
        const updated = await tx.rpcMarketState.update({ where: { id: RPC_MARKET_STATE_ID }, data: { fiatReserve: nextFiat, rpcReserve: nextRpc, currentPrice: nextPrice } });
        const current = { currentPrice: updated.currentPrice.toString(), fiatReserve: updated.fiatReserve.toString(), rpcReserve: updated.rpcReserve.toString(), totalFiatVolume: updated.totalFiatVolume.toString(), totalRpcVolume: updated.totalRpcVolume.toString(), totalBuys: updated.totalBuys, totalSells: updated.totalSells, updatedAt: updated.updatedAt.toISOString(), fiatWithdrawn: fiatAmount.toString(), rpcWithdrawn: rpcAmount.toString() };
        await tx.adminLog.create({ data: { userId: actorUserId, action: 'RPC_MARKET_LIQUIDITY_WITHDRAW', entity: 'RpcMarketState', reason: body.reason.trim(), previous: JSON.stringify(previous), current: JSON.stringify(current) } });
        return updated;
      });
      return { message: 'Liquidez removida com sucesso.', state: result };
    } catch (error) {
      return reply.status(400).send({ message: (error as Error).message });
    }
  });

  app.post('/rpc-market/sell', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: MAX_RPC_TRADES_PER_MINUTE, timeWindow: '1 minute', errorResponseBuilder: () => ({ message: 'Muitas negociações em sequência. Aguarde um minuto e tente novamente.' }) } } }, async (request, reply) => {
    try {
      await assertFinancialPermission((request.user as { sub: string }).sub, 'RPC_MARKET_TRADE');
      const body = amountSchema.parse(request.body ?? {});
      if (body.rpcAmount == null) return reply.status(400).send({ message: 'rpcAmount é obrigatório.' });
      const rpcAmount = toDecimal(body.rpcAmount).toDecimalPlaces(2);
      if (rpcAmount.lt(MIN_AMOUNT)) return reply.status(400).send({ message: 'Valor mínimo para venda é 0,01 RPC.' });

      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const wallet = await tx.wallet.findUnique({ where: { userId: (request.user as { sub: string }).sub } });
        if (!wallet) throw new Error('Carteira não encontrada.');

        await tx.rpcMarketState.upsert({ where: { id: RPC_MARKET_STATE_ID }, update: {}, create: { id: RPC_MARKET_STATE_ID, currentPrice: new Decimal('1.00000000'), fiatReserve: new Decimal('1000000.00'), rpcReserve: new Decimal('1000000.00') } });
        await tx.$queryRaw`SELECT id FROM "RpcMarketState" WHERE id = ${RPC_MARKET_STATE_ID} FOR UPDATE`;
        const state = await tx.rpcMarketState.findUniqueOrThrow({ where: { id: RPC_MARKET_STATE_ID } });

        const quote = buildSellQuote(state, rpcAmount);
        const grossFiatAmount = quote.fiatAmount;
        const feeAmount = grossFiatAmount.mul(RPC_MARKET_SELL_FEE_PERCENT).div(HUNDRED).toDecimalPlaces(2);
        const netFiatAmount = grossFiatAmount.sub(feeAmount).toDecimalPlaces(2);
        const updatedWallet = await tx.wallet.updateMany({ where: { id: wallet.id, rpcAvailableBalance: { gte: rpcAmount } }, data: { rpcAvailableBalance: { decrement: rpcAmount }, fiatAvailableBalance: { increment: netFiatAmount } } });
        if (updatedWallet.count !== 1) throw new Error('Saldo insuficiente.');
        await creditRpcMarketFee(tx, feeAmount, (request.user as { sub: string }).sub, 'Taxa RPC mercado SELL');
        await tx.rpcMarketState.update({ where: { id: RPC_MARKET_STATE_ID }, data: { fiatReserve: quote.newFiatReserve, rpcReserve: quote.newRpcReserve, currentPrice: quote.priceAfter, totalFiatVolume: { increment: quote.fiatAmount }, totalRpcVolume: { increment: rpcAmount }, totalSells: { increment: 1 } } });
        await tx.rpcExchangeTrade.create({ data: { userId: (request.user as { sub: string }).sub, side: 'SELL_RPC', fiatAmount: netFiatAmount, rpcAmount, unitPrice: netFiatAmount.div(rpcAmount).toDecimalPlaces(PRICE_SCALE), priceBefore: quote.priceBefore, priceAfter: quote.priceAfter } });
        await tx.transaction.create({ data: { walletId: wallet.id, type: 'RPC_MARKET_SELL', amount: netFiatAmount, description: 'Venda de RPC por R$ (líquido)' } });
        await tx.transaction.create({ data: { walletId: wallet.id, type: 'RPC_MARKET_SELL_FEE', amount: feeAmount, description: 'Taxa da Exchange na venda RPC/R$' } });
        const latestWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
        return { grossFiatAmount, netFiatAmount, feeAmount, feePercent: RPC_MARKET_SELL_FEE_PERCENT, rpcAmount, priceBefore: quote.priceBefore, priceAfter: quote.priceAfter, wallet: latestWallet };
      });

      try { await processEligibleRpcLimitOrders({ maxOrders: 10 }); } catch (error) { request.log.warn({ error }, 'Falha ao processar ordens limite após sell'); }
      return { message: 'RPC vendido com sucesso.', grossFiatAmount: result.grossFiatAmount, netFiatAmount: result.netFiatAmount, feeAmount: result.feeAmount, feePercent: result.feePercent, rpcAmount: result.rpcAmount, priceBefore: result.priceBefore, priceAfter: result.priceAfter, wallet: { fiatAvailableBalance: result.wallet.fiatAvailableBalance, rpcAvailableBalance: result.wallet.rpcAvailableBalance } };
    } catch (error) {
      return reply.status(400).send({ message: (error as Error).message });
    }
  });
}
