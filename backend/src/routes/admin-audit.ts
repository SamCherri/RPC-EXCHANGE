import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { CsvColumn, toCsv as toCsvFromColumns } from '../services/csv-export-service.js';
import { ADMIN_REPORT_ROLES, ADMIN_ROLES, hasAnyRole } from '../lib/roles.js';

type AuthRequest = FastifyRequest & { user: { roles?: string[] } };

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

function checkAdmin(reply: FastifyReply, request: FastifyRequest) {
  const roles = (request as AuthRequest).user.roles ?? [];
  const allowed = ADMIN_ROLES.some((role) => roles.includes(role));
  if (!allowed) {
    reply.code(403).send({ message: 'Sem permissão para auditoria administrativa.' });
    return false;
  }
  return true;
}

function canViewAdminReports(roles: string[]) {
  return roles.some((role) => ADMIN_REPORT_ROLES.includes(role));
}


const EXPORT_LIMIT = 5000;

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';

  let normalized: string;
  if (value instanceof Date) normalized = value.toISOString();
  else if (typeof value === 'object') normalized = JSON.stringify(value);
  else normalized = String(value);

  const escaped = normalized.replace(/"/g, '""');
  if (/[",;\n\r]/u.test(normalized)) return `"${escaped}"`;
  return escaped;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map((row) => row.map((value) => escapeCsvValue(value)).join(','));
  return `${lines.join('\n')}\n`;
}

function dateRange(from?: string, to?: string) {
  const createdAt: { gte?: Date; lte?: Date } = {};
  if (from) createdAt.gte = new Date(from);
  if (to) createdAt.lte = new Date(to);
  return Object.keys(createdAt).length > 0 ? createdAt : undefined;
}

export async function adminAuditRoutes(app: FastifyInstance) {
  app.get('/audit/logs', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!checkAdmin(reply, request)) return;
    const query = z.object({ action: z.string().optional(), entity: z.string().optional(), userId: z.string().optional(), search: z.string().optional(), from: z.string().optional(), to: z.string().optional() }).merge(paginationSchema).parse(request.query);
    const where = {
      ...(query.action ? { action: query.action } : {}), ...(query.entity ? { entity: query.entity } : {}), ...(query.userId ? { userId: query.userId } : {}),
      ...(query.search ? { OR: [{ reason: { contains: query.search, mode: 'insensitive' as const } }, { action: { contains: query.search, mode: 'insensitive' as const } }, { entity: { contains: query.search, mode: 'insensitive' as const } }] } : {}),
      ...(dateRange(query.from, query.to) ? { createdAt: dateRange(query.from, query.to) } : {}),
    };
    const [total, items] = await Promise.all([prisma.adminLog.count({ where }), prisma.adminLog.findMany({ where, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize })]);
    return { items, pagination: { page: query.page, pageSize: query.pageSize, total } };
  });

  app.get('/audit/transactions', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!checkAdmin(reply, request)) return;
    const query = z.object({ userId: z.string().optional(), walletId: z.string().optional(), type: z.string().optional(), search: z.string().optional(), from: z.string().optional(), to: z.string().optional() }).merge(paginationSchema).parse(request.query);
    const where: {
      walletId?: string | { in: string[] };
      type?: string;
      description?: { contains: string; mode: 'insensitive' };
      createdAt?: { gte?: Date; lte?: Date };
    } = {
      ...(query.walletId ? { walletId: query.walletId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.search ? { description: { contains: query.search, mode: 'insensitive' as const } } : {}),
      ...(dateRange(query.from, query.to) ? { createdAt: dateRange(query.from, query.to) } : {}),
    };

    if (query.userId) {
      const walletsFromUser = await prisma.wallet.findMany({
        where: { userId: query.userId },
        select: { id: true },
      });

      const walletIdsFromUser = walletsFromUser.map((wallet: { id: string }) => wallet.id);

      if (walletIdsFromUser.length === 0) {
        return { items: [], pagination: { page: query.page, pageSize: query.pageSize, total: 0 } };
      }

      if (query.walletId) {
        if (!walletIdsFromUser.includes(query.walletId)) {
          return { items: [], pagination: { page: query.page, pageSize: query.pageSize, total: 0 } };
        }
      } else {
        where.walletId = { in: walletIdsFromUser };
      }
    }

    const [total, items] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    const walletIds = [...new Set(items.map((item: { walletId: string }) => item.walletId))];
    const wallets = await prisma.wallet.findMany({
      where: { id: { in: walletIds } },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    const walletMap = new Map(wallets.map((wallet: { id: string }) => [wallet.id, wallet] as const));

    return {
      items: items.map((item: { walletId: string }) => ({ ...item, wallet: walletMap.get(item.walletId) ?? null })),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  });

  app.get('/audit/transfers', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!checkAdmin(reply, request)) return;
    const query = z.object({ type: z.enum(['ISSUANCE_TO_TREASURY','TREASURY_TO_BROKER','BROKER_TO_USER','USER_TRADE','ADJUSTMENT']).optional(), senderId: z.string().optional(), receiverId: z.string().optional(), search: z.string().optional(), from: z.string().optional(), to: z.string().optional() }).merge(paginationSchema).parse(request.query);
    const where = { ...(query.type ? { type: query.type } : {}), ...(query.senderId ? { senderId: query.senderId } : {}), ...(query.receiverId ? { receiverId: query.receiverId } : {}), ...(query.search ? { reason: { contains: query.search, mode: 'insensitive' as const } } : {}), ...(dateRange(query.from, query.to) ? { createdAt: dateRange(query.from, query.to) } : {}) };
    const [total, items] = await Promise.all([prisma.coinTransfer.count({ where }), prisma.coinTransfer.findMany({ where, include: { sender: { select: { id: true, name: true, email: true } }, receiver: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize })]);
    return { items, pagination: { page: query.page, pageSize: query.pageSize, total } };
  });

  app.get('/audit/withdrawals', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!checkAdmin(reply, request)) return;
    const query = z.object({ status: z.enum(['PENDING','PROCESSING','COMPLETED','REJECTED','CANCELED']).optional(), userId: z.string().optional(), code: z.string().optional(), search: z.string().optional(), from: z.string().optional(), to: z.string().optional() }).merge(paginationSchema).parse(request.query);
    const where = { ...(query.status ? { status: query.status } : {}), ...(query.userId ? { userId: query.userId } : {}), ...(query.code ? { code: { contains: query.code, mode: 'insensitive' as const } } : {}), ...(query.search ? { OR: [{ adminNote: { contains: query.search, mode: 'insensitive' as const } }, { userNote: { contains: query.search, mode: 'insensitive' as const } }] } : {}), ...(dateRange(query.from, query.to) ? { createdAt: dateRange(query.from, query.to) } : {}) };
    const [total, items] = await Promise.all([prisma.withdrawalRequest.count({ where }), prisma.withdrawalRequest.findMany({ where, include: { user: { select: { id: true, name: true, email: true } }, reviewedBy: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize })]);
    return { items, pagination: { page: query.page, pageSize: query.pageSize, total } };
  });

  app.get('/audit/orders', { preHandler: [app.authenticate] }, async (request, reply) => { /* similar */
    if (!checkAdmin(reply, request)) return;
    const query = z.object({ status: z.enum(['OPEN','PARTIALLY_FILLED','FILLED','CANCELED','REJECTED']).optional(), type: z.enum(['BUY','SELL']).optional(), mode: z.enum(['LIMIT','MARKET']).optional(), companyId: z.string().optional(), userId: z.string().optional(), search: z.string().optional(), from: z.string().optional(), to: z.string().optional() }).merge(paginationSchema).parse(request.query);
    const where = { ...(query.status ? { status: query.status } : {}), ...(query.type ? { type: query.type } : {}), ...(query.mode ? { mode: query.mode } : {}), ...(query.companyId ? { companyId: query.companyId } : {}), ...(query.userId ? { userId: query.userId } : {}), ...(query.search ? { OR: [{ user: { name: { contains: query.search, mode: 'insensitive' as const } } }, { company: { name: { contains: query.search, mode: 'insensitive' as const } } }, { company: { ticker: { contains: query.search, mode: 'insensitive' as const } } }] } : {}), ...(dateRange(query.from, query.to) ? { createdAt: dateRange(query.from, query.to) } : {}) };
    const [total, items] = await Promise.all([prisma.marketOrder.count({ where }), prisma.marketOrder.findMany({ where, include: { user: { select: { id: true, name: true, email: true } }, company: { select: { id: true, name: true, ticker: true } } }, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize })]);
    return { items, pagination: { page: query.page, pageSize: query.pageSize, total } };
  });

  app.get('/audit/trades', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!checkAdmin(reply, request)) return;
    const query = z.object({ companyId: z.string().optional(), buyerId: z.string().optional(), sellerId: z.string().optional(), search: z.string().optional(), from: z.string().optional(), to: z.string().optional() }).merge(paginationSchema).parse(request.query);
    const where = { ...(query.companyId ? { companyId: query.companyId } : {}), ...(query.buyerId ? { buyerId: query.buyerId } : {}), ...(query.sellerId ? { sellerId: query.sellerId } : {}), ...(query.search ? { OR: [{ buyer: { name: { contains: query.search, mode: 'insensitive' as const } } }, { seller: { name: { contains: query.search, mode: 'insensitive' as const } } }, { company: { ticker: { contains: query.search, mode: 'insensitive' as const } } }] } : {}), ...(dateRange(query.from, query.to) ? { createdAt: dateRange(query.from, query.to) } : {}) };
    const [total, items] = await Promise.all([prisma.trade.count({ where }), prisma.trade.findMany({ where, include: { company: { select: { id: true, ticker: true, name: true } }, buyer: { select: { id: true, name: true, email: true } }, seller: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize })]);
    return { items, pagination: { page: query.page, pageSize: query.pageSize, total } };
  });


  app.get('/reports/export/:type', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!checkAdmin(reply, request)) return;

    const params = z.object({ type: z.enum(['transactions', 'transfers', 'withdrawals', 'orders', 'trades', 'company-revenues', 'user-report', 'broker-report']) }).parse(request.params);
    const query = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      userId: z.string().optional(),
      walletId: z.string().optional(),
      companyId: z.string().optional(),
      type: z.string().optional(),
      mode: z.string().optional(),
      status: z.string().optional(),
      search: z.string().optional(),
      senderId: z.string().optional(),
      receiverId: z.string().optional(),
      buyerId: z.string().optional(),
      sellerId: z.string().optional(),
      code: z.string().optional(),
    }).parse(request.query);

    const range = dateRange(query.from, query.to);
    const take = EXPORT_LIMIT;

    let headers: string[] = [];
    let rows: unknown[][] = [];

    if (params.type === 'transactions') {
      const where: { walletId?: string | { in: string[] }; type?: string; description?: { contains: string; mode: 'insensitive' }; createdAt?: { gte?: Date; lte?: Date } } = {
        ...(query.walletId ? { walletId: query.walletId } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.search ? { description: { contains: query.search, mode: 'insensitive' as const } } : {}),
        ...(range ? { createdAt: range } : {}),
      };
      if (query.userId) {
        const walletsFromUser = await prisma.wallet.findMany({ where: { userId: query.userId }, select: { id: true } });
        const walletIdsFromUser = walletsFromUser.map((wallet: { id: string }) => wallet.id);
        if (walletIdsFromUser.length === 0) {
          headers = ['id', 'walletId', 'userId', 'userName', 'userEmail', 'type', 'amount', 'description', 'createdAt'];
          rows = [];
        } else if (query.walletId && !walletIdsFromUser.includes(query.walletId)) {
          headers = ['id', 'walletId', 'userId', 'userName', 'userEmail', 'type', 'amount', 'description', 'createdAt'];
          rows = [];
        } else if (!query.walletId) {
          where.walletId = { in: walletIdsFromUser };
        }
      }
      if (headers.length === 0) {
        const items = await prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, take });
        const walletIds = [...new Set(items.map((item: { walletId: string }) => item.walletId))];
        const wallets = await prisma.wallet.findMany({ where: { id: { in: walletIds } }, include: { user: { select: { id: true, name: true, email: true } } } });
        type WalletWithUser = { id: string; user: { id: string; name: string; email: string } | null };
        const walletMap = new Map<string, WalletWithUser>(wallets.map((wallet: WalletWithUser) => [wallet.id, wallet]));
        headers = ['id', 'walletId', 'userId', 'userName', 'userEmail', 'type', 'amount', 'description', 'createdAt'];
        rows = items.map((item: { id: string; walletId: string; type: string; amount: unknown; description: unknown; createdAt: Date }) => {
          const wallet = walletMap.get(item.walletId);
          return [item.id, item.walletId, wallet?.user?.id ?? '', wallet?.user?.name ?? '', wallet?.user?.email ?? '', item.type, item.amount, item.description, item.createdAt];
        });
      }
    } else if (params.type === 'transfers') {
      const items = await prisma.coinTransfer.findMany({ where: { ...(query.type ? { type: query.type as any } : {}), ...(query.senderId ? { senderId: query.senderId } : {}), ...(query.receiverId ? { receiverId: query.receiverId } : {}), ...(query.search ? { reason: { contains: query.search, mode: 'insensitive' as const } } : {}), ...(range ? { createdAt: range } : {}) }, include: { sender: { select: { id: true, name: true, email: true } }, receiver: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' }, take });
      headers = ['id', 'type', 'senderId', 'senderName', 'senderEmail', 'receiverId', 'receiverName', 'receiverEmail', 'amount', 'reason', 'previousValue', 'newValue', 'createdAt'];
      rows = items.map((item: any) => [item.id, item.type, item.senderId, item.sender?.name, item.sender?.email, item.receiverId, item.receiver?.name, item.receiver?.email, item.amount, item.reason, item.previousValue, item.newValue, item.createdAt]);
    } else if (params.type === 'withdrawals') {
      const items = await prisma.withdrawalRequest.findMany({ where: { ...(query.userId ? { userId: query.userId } : {}), ...(query.status ? { status: query.status as any } : {}), ...(query.code ? { code: { contains: query.code, mode: 'insensitive' as const } } : {}), ...(query.search ? { OR: [{ userNote: { contains: query.search, mode: 'insensitive' as const } }, { adminNote: { contains: query.search, mode: 'insensitive' as const } }] } : {}), ...(range ? { createdAt: range } : {}) }, include: { user: { select: { id: true, name: true, email: true } }, reviewedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take });
      headers = ['id', 'code', 'userId', 'userName', 'userEmail', 'amount', 'status', 'userNote', 'adminNote', 'reviewedById', 'reviewedByName', 'requestedAt', 'completedAt', 'rejectedAt', 'createdAt'];
      rows = items.map((item: any) => [item.id, item.code, item.userId, item.user?.name, item.user?.email, item.amount, item.status, item.userNote, item.adminNote, item.reviewedById, item.reviewedBy?.name, item.requestedAt, item.completedAt, item.rejectedAt, item.createdAt]);
    } else if (params.type === 'orders') {
      const items = await prisma.marketOrder.findMany({ where: { ...(query.companyId ? { companyId: query.companyId } : {}), ...(query.userId ? { userId: query.userId } : {}), ...(query.type ? { type: query.type as any } : {}), ...(query.mode ? { mode: query.mode as any } : {}), ...(query.status ? { status: query.status as any } : {}), ...(query.search ? { OR: [{ user: { name: { contains: query.search, mode: 'insensitive' as const } } }, { company: { name: { contains: query.search, mode: 'insensitive' as const } } }, { company: { ticker: { contains: query.search, mode: 'insensitive' as const } } }] } : {}), ...(range ? { createdAt: range } : {}) }, include: { user: { select: { id: true, name: true, email: true } }, company: { select: { id: true, ticker: true, name: true } } }, orderBy: { createdAt: 'desc' }, take });
      headers = ['id', 'companyId', 'ticker', 'companyName', 'userId', 'userName', 'userEmail', 'type', 'mode', 'status', 'quantity', 'remainingQuantity', 'limitPrice', 'lockedCash', 'lockedShares', 'createdAt', 'executedAt', 'canceledAt'];
      rows = items.map((item: any) => [item.id, item.companyId, item.company?.ticker, item.company?.name, item.userId, item.user?.name, item.user?.email, item.type, item.mode, item.status, item.quantity, item.remainingQuantity, item.limitPrice, item.lockedCash, item.lockedShares, item.createdAt, item.executedAt, item.canceledAt]);
    } else if (params.type === 'trades') {
      const items = await prisma.trade.findMany({ where: { ...(query.companyId ? { companyId: query.companyId } : {}), ...(query.buyerId ? { buyerId: query.buyerId } : {}), ...(query.sellerId ? { sellerId: query.sellerId } : {}), ...(query.search ? { OR: [{ buyer: { name: { contains: query.search, mode: 'insensitive' as const } } }, { seller: { name: { contains: query.search, mode: 'insensitive' as const } } }, { company: { ticker: { contains: query.search, mode: 'insensitive' as const } } }] } : {}), ...(range ? { createdAt: range } : {}) }, include: { company: { select: { id: true, ticker: true, name: true } }, buyer: { select: { id: true, name: true, email: true } }, seller: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' }, take });
      headers = ['id', 'companyId', 'ticker', 'companyName', 'buyerId', 'buyerName', 'buyerEmail', 'sellerId', 'sellerName', 'sellerEmail', 'quantity', 'unitPrice', 'grossAmount', 'buyFeeAmount', 'sellFeeAmount', 'createdAt'];
      rows = items.map((item: any) => [item.id, item.companyId, item.company?.ticker, item.company?.name, item.buyerId, item.buyer?.name, item.buyer?.email, item.sellerId, item.seller?.name, item.seller?.email, item.quantity, item.unitPrice, item.grossAmount, item.buyFeeAmount, item.sellFeeAmount, item.createdAt]);
    } else if (params.type === 'company-revenues') {
      const items = await prisma.companyRevenueAccount.findMany({ where: { ...(query.companyId ? { companyId: query.companyId } : {}), ...(query.status ? { company: { status: query.status as any } } : {}), ...(query.search ? { OR: [{ company: { ticker: { contains: query.search, mode: 'insensitive' as const } } }, { company: { name: { contains: query.search, mode: 'insensitive' as const } } }, { company: { founder: { name: { contains: query.search, mode: 'insensitive' as const } } } }] } : {}) }, include: { company: { include: { founder: { select: { id: true, name: true, email: true } } } } }, orderBy: { updatedAt: 'desc' }, take });
      headers = ['companyId', 'ticker', 'companyName', 'ownerId', 'ownerName', 'ownerEmail', 'status', 'balance', 'totalReceivedFees', 'totalWithdrawn', 'totalUsedForBoost', 'currentPrice'];
      rows = items.map((item: any) => [item.companyId, item.company?.ticker, item.company?.name, item.company?.founder?.id, item.company?.founder?.name, item.company?.founder?.email, item.company?.status, item.balance, item.totalReceivedFees, item.totalWithdrawn, item.totalUsedForBoost, item.company?.currentPrice]);
    } else if (params.type === 'user-report') {
      if (!query.userId) return reply.code(400).send({ message: 'Informe userId para exportar relatório de usuário.' });
      const user = await prisma.user.findUnique({ where: { id: query.userId }, select: { id: true, name: true, email: true } });
      if (!user) return reply.code(404).send({ message: 'Usuário não encontrado.' });
      const wallet = await prisma.wallet.findUnique({ where: { userId: query.userId } });
      const transactions = await prisma.transaction.findMany({ where: { ...(wallet ? { walletId: wallet.id } : { walletId: '__NO_WALLET__' }), ...(range ? { createdAt: range } : {}) }, orderBy: { createdAt: 'desc' }, take: 50 });
      const transfers = await prisma.coinTransfer.findMany({ where: { OR: [{ senderId: query.userId }, { receiverId: query.userId }], ...(range ? { createdAt: range } : {}) }, orderBy: { createdAt: 'desc' }, take: 50 });
      const withdrawals = await prisma.withdrawalRequest.findMany({ where: { userId: query.userId, ...(range ? { createdAt: range } : {}) }, orderBy: { createdAt: 'desc' }, take: 50 });
      const orders = await prisma.marketOrder.findMany({ where: { userId: query.userId, ...(range ? { createdAt: range } : {}) }, orderBy: { createdAt: 'desc' }, take: 50 });
      const holdings = await prisma.companyHolding.findMany({ where: { userId: query.userId }, include: { company: { select: { ticker: true, name: true } } } });
      headers = ['section', 'key', 'value'];
      rows = [['user', 'id', user.id], ['user', 'name', user.name], ['user', 'email', user.email], ['wallet', 'availableBalance', wallet?.availableBalance ?? 0], ...transactions.map((t: any) => ['transaction', t.id, JSON.stringify({ type: t.type, amount: t.amount, createdAt: t.createdAt })]), ...transfers.map((t: any) => ['transfer', t.id, JSON.stringify({ type: t.type, amount: t.amount, createdAt: t.createdAt })]), ...withdrawals.map((w: any) => ['withdrawal', w.id, JSON.stringify({ status: w.status, amount: w.amount, createdAt: w.createdAt })]), ...orders.map((o: any) => ['order', o.id, JSON.stringify({ status: o.status, type: o.type, quantity: o.quantity, createdAt: o.createdAt })]), ...holdings.map((h: any) => ['holding', h.id, JSON.stringify({ ticker: h.company?.ticker, shares: h.shares })])];
    } else if (params.type === 'broker-report') {
      if (!query.userId) return reply.code(400).send({ message: 'Informe userId para exportar relatório de corretor.' });
      const user = await prisma.user.findUnique({
        where: { id: query.userId },
        select: { id: true, name: true, email: true, roles: { select: { role: { select: { key: true } } } } },
      });
      if (!user) return reply.code(404).send({ message: 'Corretor não encontrado.' });
      const userRoles = user.roles.map((item: { role: { key: string } }) => item.role.key);
      if (!userRoles.includes('VIRTUAL_BROKER')) return reply.code(400).send({ message: 'Usuário não é corretor.' });
      const brokerAccount = await prisma.brokerAccount.findUnique({ where: { userId: query.userId } });
      const transfers = await prisma.coinTransfer.findMany({ where: { OR: [{ senderId: query.userId }, { receiverId: query.userId }], ...(range ? { createdAt: range } : {}) }, orderBy: { createdAt: 'desc' }, take: 50 });
      headers = ['section', 'key', 'value'];
      rows = [['broker', 'id', user.id], ['broker', 'name', user.name], ['broker', 'email', user.email], ['brokerAccount', 'available', brokerAccount?.available ?? 0], ['brokerAccount', 'receivedTotal', brokerAccount?.receivedTotal ?? 0], ...transfers.map((t: any) => ['transfer', t.id, JSON.stringify({ type: t.type, amount: t.amount, createdAt: t.createdAt, senderId: t.senderId, receiverId: t.receiverId })])];
    }

    const csv = toCsv(headers, rows);
    const filenameDate = new Date().toISOString().slice(0, 10);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="rpc-exchange-${params.type}-${filenameDate}.csv"`);
    return reply.send(csv);
  });



  app.get('/reports/users/:userId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const roles = ((request as AuthRequest).user.roles ?? []).map((role) => role.toUpperCase());
    if (!canViewAdminReports(roles)) return reply.status(403).send({ message: 'Sem permissão.' });

    const params = z.object({ userId: z.string().min(1) }).parse(request.params);
    const query = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(request.query);
    const range = dateRange(query.from, query.to);

    const user = await prisma.user.findUnique({
      where: { id: params.userId },
      select: { id: true, name: true, email: true, characterName: true, bankAccountNumber: true, isBlocked: true, createdAt: true, roles: { select: { role: { select: { key: true } } } } },
    });

    if (!user) {
      return reply.code(404).send({ message: 'Usuário não encontrado.' });
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId: params.userId } });

    const transactionsWhere = { ...(wallet ? { walletId: wallet.id } : { walletId: '__NO_WALLET__' }), ...(range ? { createdAt: range } : {}) };
    const withdrawalsWhere = { userId: params.userId, ...(range ? { createdAt: range } : {}) };
    const ordersWhere = { userId: params.userId, ...(range ? { createdAt: range } : {}) };
    const holdingsWhere = { userId: params.userId };
    const adminLogsWhere = { OR: [{ userId: params.userId }, { previous: { contains: params.userId } }, { current: { contains: params.userId } }], ...(range ? { createdAt: range } : {}) };

    const [recentTransactions, recentWithdrawals, rpcTrades, rpcLimitOrders, recentOrders, holdings, adminLogs] = await Promise.all([
      prisma.transaction.findMany({ where: transactionsWhere, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.withdrawalRequest.findMany({ where: withdrawalsWhere, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.rpcExchangeTrade.findMany({ where: { userId: params.userId, ...(range ? { createdAt: range } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.rpcLimitOrder.findMany({ where: { userId: params.userId, ...(range ? { createdAt: range } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.marketOrder.findMany({ where: ordersWhere, include: { company: { select: { id: true, name: true, ticker: true, status: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.companyHolding.findMany({ where: holdingsWhere, include: { company: { select: { id: true, name: true, ticker: true, status: true, currentPrice: true } } }, orderBy: { updatedAt: 'desc' }, take: 100 }),
      prisma.adminLog.findMany({ where: adminLogsWhere, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);

    return {
      user: {
        id: user.id,
        characterName: user.characterName,
        bankAccountNumber: user.bankAccountNumber,
        name: user.name,
        email: user.email,
        blockedAt: user.isBlocked ? user.createdAt : null,
        blockedReason: null,
        createdAt: user.createdAt,
        roles: user.roles.map((item: { role: { key: string } }) => item.role.key),
      },
      wallet: {
        fiatAvailableBalance: wallet?.fiatAvailableBalance ?? 0,
        fiatLockedBalance: wallet?.fiatLockedBalance ?? 0,
        rpcAvailableBalance: wallet?.rpcAvailableBalance ?? 0,
        rpcLockedBalance: wallet?.rpcLockedBalance ?? 0,
      },
      activity: { transactions: recentTransactions, withdrawals: recentWithdrawals, rpcTrades, rpcLimitOrders, marketOrders: recentOrders, companyHoldings: holdings, adminLogs },
    };
  });

  app.get('/reports/users/:userId.csv', { preHandler: [app.authenticate] }, async (request, reply) => {
    const roles = ((request as AuthRequest).user.roles ?? []).map((role) => role.toUpperCase());
    if (!canViewAdminReports(roles)) return reply.status(403).send({ message: 'Sem permissão.' });
    const params = z.object({ userId: z.string().min(1) }).parse(request.params);
    const reportRequest = await app.inject({ method: 'GET', url: `/api/admin/reports/users/${params.userId}`, headers: { authorization: request.headers.authorization ?? '' } });
    if (reportRequest.statusCode !== 200) return reply.code(reportRequest.statusCode).send(reportRequest.json());
    const report = reportRequest.json() as any;
    const rows: Array<Record<string, unknown>> = [
      { section: 'user', key: 'id', value: report.user.id },
      { section: 'user', key: 'email', value: report.user.email },
      { section: 'wallet', key: 'fiatAvailableBalance', value: report.wallet.fiatAvailableBalance },
      { section: 'wallet', key: 'rpcAvailableBalance', value: report.wallet.rpcAvailableBalance },
      { section: 'summary', key: 'transactionsCount', value: report.activity.transactions.length },
      { section: 'summary', key: 'withdrawalsCount', value: report.activity.withdrawals.length },
    ];
    const csv = toCsvFromColumns(rows, [{ key: 'section', header: 'section' }, { key: 'key', header: 'key' }, { key: 'value', header: 'value' }]);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="user-report.csv"');
    return reply.send(csv);
  });

  app.get('/reports/brokers/:brokerId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const roles = ((request as AuthRequest).user.roles ?? []).map((role) => role.toUpperCase());
    if (!canViewAdminReports(roles)) return reply.status(403).send({ message: 'Sem permissão.' });

    const params = z.object({ brokerId: z.string().min(1) }).parse(request.params);
    const query = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(request.query);
    const range = dateRange(query.from, query.to);

    const user = await prisma.user.findUnique({
      where: { id: params.brokerId },
      select: {
        id: true,
        name: true,
        email: true,
        roles: { select: { role: { select: { key: true } } } },
      },
    });

    if (!user) {
      return reply.code(404).send({ message: 'Corretor não encontrado.' });
    }

    const userRoles = user.roles.map((item: { role: { key: string } }) => item.role.key);
    if (!userRoles.includes('VIRTUAL_BROKER')) {
      return reply.code(404).send({ message: 'Corretor não encontrado.' });
    }

    const brokerAccount = await prisma.brokerAccount.findUnique({ where: { userId: params.brokerId } });
    const brokerTransfersToUsersWhere = { senderId: params.brokerId, type: 'BROKER_TO_USER' as const, ...(range ? { createdAt: range } : {}) };
    const treasuryToBrokerWhere = { receiverId: params.brokerId, type: 'TREASURY_TO_BROKER' as const, ...(range ? { createdAt: range } : {}) };
    const brokerTransfersWhere = { OR: [{ senderId: params.brokerId }, { receiverId: params.brokerId }], ...(range ? { createdAt: range } : {}) };
    const adminLogsWhere = { OR: [{ userId: params.brokerId }, { previous: { contains: params.brokerId } }, { current: { contains: params.brokerId } }], ...(range ? { createdAt: range } : {}) };
    const wallet = await prisma.wallet.findUnique({ where: { userId: params.brokerId } });

    const [receivedFromTreasury, sentToUsers, transfersToUsersCount, usersServedDistinct, lastTransfer, recentTransfers, adminLogs, transactions] = await Promise.all([
      prisma.coinTransfer.aggregate({ where: treasuryToBrokerWhere, _sum: { amount: true } }),
      prisma.coinTransfer.aggregate({ where: brokerTransfersToUsersWhere, _sum: { amount: true } }),
      prisma.coinTransfer.count({ where: brokerTransfersToUsersWhere }),
      prisma.coinTransfer.findMany({ where: brokerTransfersToUsersWhere, select: { receiverId: true }, distinct: ['receiverId'] }),
      prisma.coinTransfer.findFirst({ where: brokerTransfersWhere, orderBy: { createdAt: 'desc' } }),
      prisma.coinTransfer.findMany({ where: brokerTransfersWhere, include: { sender: { select: { id: true, name: true, email: true } }, receiver: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.adminLog.findMany({ where: adminLogsWhere, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.transaction.findMany({ where: { ...(wallet ? { walletId: wallet.id } : { walletId: '__NO_WALLET__' }), ...(range ? { createdAt: range } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);

    return {
      broker: {
        id: user.id,
        name: user.name,
        email: user.email,
        roles: userRoles,
      },
      characterName: null,
      brokerAccount,
      activity: {
        adminLogs,
        coinTransfers: recentTransfers,
        transactions,
        usersServed: usersServedDistinct.filter((item: { receiverId: string | null }) => item.receiverId).map((item: { receiverId: string | null }) => item.receiverId),
        summary: { receivedFromTreasury: receivedFromTreasury._sum.amount ?? 0, sentToUsers: sentToUsers._sum.amount ?? 0, transfersToUsersCount, lastTransferAt: lastTransfer?.createdAt ?? null },
      },
    };
  });
  app.get('/reports/brokers/:brokerId.csv', { preHandler: [app.authenticate] }, async (request, reply) => {
    const roles = ((request as AuthRequest).user.roles ?? []).map((role) => role.toUpperCase());
    if (!canViewAdminReports(roles)) return reply.status(403).send({ message: 'Sem permissão.' });
    const params = z.object({ brokerId: z.string().min(1) }).parse(request.params);
    const brokerResponse = await app.inject({ method: 'GET', url: `/api/admin/reports/brokers/${params.brokerId}`, headers: { authorization: request.headers.authorization ?? '' } });
    if (brokerResponse.statusCode !== 200) return reply.code(brokerResponse.statusCode).send(brokerResponse.json());
    const report = brokerResponse.json() as any;
    const rows: Array<Record<string, unknown>> = [
      { section: 'broker', key: 'id', value: report.broker?.id ?? '' },
      { section: 'broker', key: 'email', value: report.broker?.email ?? '' },
      { section: 'brokerAccount', key: 'available', value: report.brokerAccount?.available ?? '' },
      { section: 'summary', key: 'coinTransfers', value: report.activity?.coinTransfers?.length ?? 0 },
    ];
    const csv = toCsvFromColumns(rows, [{ key: 'section', header: 'section' }, { key: 'key', header: 'key' }, { key: 'value', header: 'value' }]);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="broker-report.csv"');
    return reply.send(csv);
  });

  app.get('/reports/admin-logs.csv', { preHandler: [app.authenticate] }, async (request, reply) => {
    const roles = ((request as AuthRequest).user.roles ?? []).map((role) => role.toUpperCase());
    if (!canViewAdminReports(roles)) return reply.status(403).send({ message: 'Sem permissão.' });
    const q = z.object({ from: z.string().optional(), to: z.string().optional(), action: z.string().optional(), userId: z.string().optional(), limit: z.coerce.number().int().min(1).max(5000).default(1000) }).parse(request.query ?? {});
    const logs = await prisma.adminLog.findMany({ where: { ...(q.action ? { action: q.action } : {}), ...(q.userId ? { userId: q.userId } : {}), ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}) }, orderBy: { createdAt: 'desc' }, take: q.limit });
    const columns: CsvColumn[] = [{ key: 'createdAt', header: 'createdAt' }, { key: 'userId', header: 'userId' }, { key: 'action', header: 'action' }, { key: 'entity', header: 'entity' }, { key: 'reason', header: 'reason' }, { key: 'ip', header: 'ip' }, { key: 'userAgent', header: 'userAgent' }, { key: 'previous', header: 'previous' }, { key: 'current', header: 'current' }];
    const csv = toCsvFromColumns(logs as Array<Record<string, unknown>>, columns);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="admin-logs.csv"');
    return reply.send(csv);
  });
  app.get('/reports/overview', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!checkAdmin(reply, request)) return;
    const [users, brokers, active, suspended, closed, wallets, treasury, platform, pendingWithdrawals, openOrders, traded, companyFees] = await Promise.all([
      prisma.user.count(), prisma.user.count({ where: { roles: { some: { role: { key: 'VIRTUAL_BROKER' } } } } }), prisma.company.count({ where: { status: 'ACTIVE' } }), prisma.company.count({ where: { status: 'SUSPENDED' } }), prisma.company.count({ where: { status: 'CLOSED' } }), prisma.wallet.aggregate({ _sum: { availableBalance: true, lockedBalance: true, pendingWithdrawalBalance: true } }), prisma.treasuryAccount.findFirst(), prisma.platformAccount.findFirst(), prisma.withdrawalRequest.count({ where: { status: 'PENDING' } }), prisma.marketOrder.count({ where: { status: { in: ['OPEN', 'PARTIALLY_FILLED'] } } }), prisma.trade.aggregate({ _sum: { grossAmount: true } }), prisma.companyRevenueAccount.aggregate({ _sum: { totalReceivedFees: true } }),
    ]);
    return { totalUsers: users, totalBrokers: brokers, totalTokensActive: active, totalTokensSuspended: suspended, totalTokensClosed: closed, totalWalletAvailable: wallets._sum.availableBalance ?? 0, totalWalletLocked: wallets._sum.lockedBalance ?? 0, totalPendingWithdrawalsBalance: wallets._sum.pendingWithdrawalBalance ?? 0, treasuryBalance: treasury?.balance ?? 0, platformBalance: platform?.balance ?? 0, totalPlatformReceivedFees: platform?.totalReceivedFees ?? 0, totalProjectReceivedFees: companyFees._sum.totalReceivedFees ?? 0, pendingWithdrawalsCount: pendingWithdrawals, openOrdersCount: openOrders, totalTradedVolume: traded._sum.grossAmount ?? 0 };
  });

  app.get('/reports/company-revenues', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!checkAdmin(reply, request)) return;
    const items = await prisma.companyRevenueAccount.findMany({ include: { company: { include: { founder: { select: { id: true, name: true, email: true } } } } }, orderBy: { updatedAt: 'desc' } });
    return { items: items.map((item: { companyId: string; company: { name: string; ticker: string; founder: { id: string; name: string | null; email: string } | null; status: string; currentPrice: unknown }; balance: unknown; totalReceivedFees: unknown; totalWithdrawn: unknown }) => ({ companyId: item.companyId, token: item.company.name, ticker: item.company.ticker, owner: item.company.founder, balance: item.balance, totalReceivedFees: item.totalReceivedFees, totalWithdrawn: item.totalWithdrawn, status: item.company.status, currentPrice: item.company.currentPrice })) };
  });

  app.get('/reports/platform-account', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!checkAdmin(reply, request)) return;
    const item = await prisma.platformAccount.findFirst();
    return { balance: item?.balance ?? 0, totalReceivedFees: item?.totalReceivedFees ?? 0, totalWithdrawn: item?.totalWithdrawn ?? 0, createdAt: item?.createdAt ?? null, updatedAt: item?.updatedAt ?? null };
  });
}
