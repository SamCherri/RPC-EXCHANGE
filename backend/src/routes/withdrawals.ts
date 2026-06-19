import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { assertFinancialPermission } from '../services/registration-approval-service.js';
import { MAX_PENDING_WITHDRAWALS_PER_USER } from '../config/anti-abuse-limits.js';
import { ADMIN_ROLES } from '../lib/roles.js';

type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };

const adminRoles = ADMIN_ROLES;

const requestWithdrawalSchema = z.object({
  amount: z.coerce.number().positive('Quantidade deve ser maior que zero.'),
  userNote: z.string().max(400).optional(),
});

const adminNoteSchema = z.object({
  adminNote: z.string().max(400).optional(),
});

function hasAdminRole(roles: string[]) {
  return adminRoles.some((role) => roles.includes(role));
}

async function generateWithdrawalCode(tx: Prisma.TransactionClient) {
  const latest = await tx.withdrawalRequest.findFirst({
    where: { code: { startsWith: 'WD-' } },
    orderBy: { createdAt: 'desc' },
    select: { code: true },
  });

  const lastNumeric = latest?.code.match(/^WD-(\d+)$/)?.[1];
  if (lastNumeric) {
    const next = Number(lastNumeric) + 1;
    return `WD-${String(next).padStart(6, '0')}`;
  }

  const random = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `SAQ-${random}`;
}

async function createWalletTransaction(tx: Prisma.TransactionClient, walletId: string, type: string, amount: Decimal, description: string) {
  await tx.transaction.create({
    data: {
      walletId,
      type,
      amount,
      description,
    },
  });
}

export async function withdrawalsRoutes(app: FastifyInstance) {
  app.get('/withdrawals/me', { preHandler: [app.authenticate] }, async (request) => {
    const authRequest = request as AuthRequest;

    const withdrawals = await prisma.withdrawalRequest.findMany({
      where: { userId: authRequest.user.sub },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return { withdrawals };
  });

  app.post('/withdrawals', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;

    try {
      await assertFinancialPermission(authRequest.user.sub, 'WITHDRAWAL_REQUEST');
      const body = requestWithdrawalSchema.parse(request.body);

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const wallet = await tx.wallet.findUnique({ where: { userId: authRequest.user.sub } });
        if (!wallet) {
          throw new Error('Carteira não encontrada.');
        }

        const pendingCount = await tx.withdrawalRequest.count({ where: { userId: authRequest.user.sub, status: { in: ['PENDING', 'PROCESSING'] } } });
        if (pendingCount >= MAX_PENDING_WITHDRAWALS_PER_USER) {
          throw new Error('Você já possui saques pendentes. Aguarde a conclusão antes de solicitar outro.');
        }

        const amount = new Decimal(body.amount);

        if (wallet.fiatAvailableBalance.lessThan(amount)) {
          throw new Error('Saldo em R$ insuficiente para saque.');
        }

        const walletMutation = await tx.wallet.updateMany({
          where: {
            id: wallet.id,
            fiatAvailableBalance: { gte: amount },
          },
          data: {
            fiatAvailableBalance: { decrement: amount },
            fiatPendingWithdrawalBalance: { increment: amount },
          },
        });

        if (walletMutation.count !== 1) {
          throw new Error('Saldo em R$ insuficiente para saque.');
        }

        const code = await generateWithdrawalCode(tx);

        const withdrawal = await tx.withdrawalRequest.create({
          data: {
            code,
            userId: authRequest.user.sub,
            amount,
            status: 'PENDING',
            userNote: body.userNote?.trim() || null,
          },
        });

        const updatedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });

        await createWalletTransaction(tx, wallet.id, 'WITHDRAWAL_LOCK', amount, 'R$ bloqueado para saque');

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'WITHDRAWAL_REQUEST_CREATED',
            entity: 'WithdrawalRequest',
            reason: body.userNote ?? 'Solicitação de saque criada pelo usuário.',
            previous: JSON.stringify({
              fiatAvailableBalance: wallet.fiatAvailableBalance.toString(),
              fiatPendingWithdrawalBalance: wallet.fiatPendingWithdrawalBalance.toString(),
            }),
            current: JSON.stringify({
              code,
              fiatAvailableBalance: updatedWallet.fiatAvailableBalance.toString(),
              fiatPendingWithdrawalBalance: updatedWallet.fiatPendingWithdrawalBalance.toString(),
              amount: amount.toString(),
            }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });

        return withdrawal;
      });

      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.post('/withdrawals/:id/cancel', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 15, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const params = z.object({ id: z.string().min(1) }).parse(request.params);

    try {
      const canceled = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const withdrawal = await tx.withdrawalRequest.findUnique({ where: { id: params.id } });

        if (!withdrawal || withdrawal.userId !== authRequest.user.sub) {
          throw new Error('Solicitação de saque não encontrada para este usuário.');
        }

        if (withdrawal.status !== 'PENDING') {
          throw new Error('Somente solicitações pendentes podem ser canceladas.');
        }

        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: authRequest.user.sub } });

        const nextPending = wallet.fiatPendingWithdrawalBalance.sub(withdrawal.amount);
        const nextAvailable = wallet.fiatAvailableBalance.add(withdrawal.amount);

        if (nextPending.lessThan(0) || nextAvailable.lessThan(0)) {
          throw new Error('Operação inválida de saldo ao cancelar saque.');
        }

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            fiatPendingWithdrawalBalance: nextPending,
            fiatAvailableBalance: nextAvailable,
          },
        });

        const updated = await tx.withdrawalRequest.update({
          where: { id: withdrawal.id },
          data: {
            status: 'CANCELED',
            canceledAt: new Date(),
          },
        });

        await createWalletTransaction(tx, wallet.id, 'WITHDRAWAL_CANCELED', withdrawal.amount, 'Saque cancelado');

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'WITHDRAWAL_REQUEST_CANCELED_BY_USER',
            entity: 'WithdrawalRequest',
            reason: 'Solicitação cancelada pelo usuário.',
            previous: JSON.stringify({
              status: withdrawal.status,
              fiatAvailableBalance: wallet.fiatAvailableBalance.toString(),
              fiatPendingWithdrawalBalance: wallet.fiatPendingWithdrawalBalance.toString(),
            }),
            current: JSON.stringify({
              status: 'CANCELED',
              fiatAvailableBalance: nextAvailable.toString(),
              fiatPendingWithdrawalBalance: nextPending.toString(),
            }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });

        return updated;
      });

      return canceled;
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.get('/admin/withdrawals', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];

    if (!hasAdminRole(roles)) {
      return reply.code(403).send({ message: 'Sem permissão para visualizar saques.' });
    }

    const query = z.object({
      status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELED']).optional(),
      userRef: z.string().min(1).optional(),
      userEmail: z.string().email().optional(),
      code: z.string().min(2).optional(),
    }).parse(request.query);

    const withdrawals = await prisma.withdrawalRequest.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.code ? { code: { contains: query.code, mode: 'insensitive' } } : {}),
        ...((query.userRef || query.userEmail) ? { user: { OR: [
          ...(query.userEmail ? [{ email: query.userEmail.toLowerCase() }] : []),
          ...(query.userRef ? [
            { bankAccountNumber: { contains: query.userRef, mode: 'insensitive' as const } },
            { characterName: { contains: query.userRef, mode: 'insensitive' as const } },
            { name: { contains: query.userRef, mode: 'insensitive' as const } },
            { email: { contains: query.userRef.toLowerCase(), mode: 'insensitive' as const } },
          ] : []),
        ] } } : {}),
      },
      include: {
        user: { select: { id: true, name: true, email: true, characterName: true, bankAccountNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return { withdrawals };
  });

  app.post('/admin/withdrawals/:id/mark-processing', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 25, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];

    if (!hasAdminRole(roles)) {
      return reply.code(403).send({ message: 'Sem permissão para processar saques.' });
    }

    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = adminNoteSchema.parse(request.body);

    const withdrawalOwnerCheck = await prisma.withdrawalRequest.findUnique({ where: { id: params.id }, select: { userId: true } });
    if (withdrawalOwnerCheck?.userId === authRequest.user.sub) {
      return reply.code(403).send({ message: 'Administrador não pode revisar o próprio saque.' });
    }

    try {
      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const withdrawal = await tx.withdrawalRequest.findUnique({ where: { id: params.id } });
        if (!withdrawal) throw new Error('Saque não encontrado.');
        if (withdrawal.status !== 'PENDING') throw new Error('Somente saque pendente pode ser marcado em processamento.');
        if (withdrawal.userId === authRequest.user.sub) throw new Error('Administrador não pode revisar o próprio saque.');

        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: withdrawal.userId } });

        const next = await tx.withdrawalRequest.update({
          where: { id: withdrawal.id },
          data: {
            status: 'PROCESSING',
            processingAt: new Date(),
            reviewedById: authRequest.user.sub,
            adminNote: body.adminNote?.trim() || null,
          },
        });

        await createWalletTransaction(tx, wallet.id, 'WITHDRAWAL_PROCESSING', withdrawal.amount, 'Saque em processamento');

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'WITHDRAWAL_MARKED_PROCESSING',
            entity: 'WithdrawalRequest',
            reason: body.adminNote ?? 'Saque marcado em processamento.',
            previous: JSON.stringify({ status: withdrawal.status }),
            current: JSON.stringify({ status: next.status, reviewedById: authRequest.user.sub }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });

        return next;
      });

      return updated;
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.post('/admin/withdrawals/:id/complete', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 25, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];

    if (!hasAdminRole(roles)) {
      return reply.code(403).send({ message: 'Sem permissão para concluir saques.' });
    }

    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = adminNoteSchema.parse(request.body);

    const withdrawalOwnerCheck = await prisma.withdrawalRequest.findUnique({ where: { id: params.id }, select: { userId: true } });
    if (withdrawalOwnerCheck?.userId === authRequest.user.sub) {
      return reply.code(403).send({ message: 'Administrador não pode revisar o próprio saque.' });
    }

    try {
      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const withdrawal = await tx.withdrawalRequest.findUnique({ where: { id: params.id } });
        if (!withdrawal) throw new Error('Saque não encontrado.');
        if (withdrawal.userId === authRequest.user.sub) throw new Error('Administrador não pode revisar o próprio saque.');

        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: withdrawal.userId } });
        const transition = await tx.withdrawalRequest.updateMany({
          where: {
            id: withdrawal.id,
            status: { in: ['PENDING', 'PROCESSING'] },
          },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            reviewedById: authRequest.user.sub,
            adminNote: body.adminNote?.trim() || null,
          },
        });

        if (transition.count !== 1) {
          throw new Error('Somente saque pendente ou em processamento pode ser concluído.');
        }

        const walletMutation = await tx.wallet.updateMany({
          where: {
            id: wallet.id,
            fiatPendingWithdrawalBalance: { gte: withdrawal.amount },
          },
          data: { fiatPendingWithdrawalBalance: { decrement: withdrawal.amount } },
        });

        if (walletMutation.count !== 1) {
          throw new Error('Saldo pendente insuficiente para concluir saque.');
        }

        const updatedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
        const next = await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: withdrawal.id } });

        await createWalletTransaction(tx, wallet.id, 'WITHDRAWAL_COMPLETED', withdrawal.amount, 'Saque concluído');

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'WITHDRAWAL_COMPLETED',
            entity: 'WithdrawalRequest',
            reason: body.adminNote ?? 'Saque concluído no painel administrativo.',
            previous: JSON.stringify({ status: withdrawal.status, fiatPendingWithdrawalBalance: wallet.fiatPendingWithdrawalBalance.toString() }),
            current: JSON.stringify({ status: next.status, fiatPendingWithdrawalBalance: updatedWallet.fiatPendingWithdrawalBalance.toString() }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });

        return next;
      });

      return updated;
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.post('/admin/withdrawals/:id/reject', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 25, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];

    if (!hasAdminRole(roles)) {
      return reply.code(403).send({ message: 'Sem permissão para rejeitar saques.' });
    }

    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = adminNoteSchema.parse(request.body);

    const withdrawalOwnerCheck = await prisma.withdrawalRequest.findUnique({ where: { id: params.id }, select: { userId: true } });
    if (withdrawalOwnerCheck?.userId === authRequest.user.sub) {
      return reply.code(403).send({ message: 'Administrador não pode revisar o próprio saque.' });
    }

    try {
      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const withdrawal = await tx.withdrawalRequest.findUnique({ where: { id: params.id } });
        if (!withdrawal) throw new Error('Saque não encontrado.');
        if (withdrawal.userId === authRequest.user.sub) throw new Error('Administrador não pode revisar o próprio saque.');

        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: withdrawal.userId } });
        const transition = await tx.withdrawalRequest.updateMany({
          where: {
            id: withdrawal.id,
            status: { in: ['PENDING', 'PROCESSING'] },
          },
          data: {
            status: 'REJECTED',
            rejectedAt: new Date(),
            reviewedById: authRequest.user.sub,
            adminNote: body.adminNote?.trim() || null,
          },
        });

        if (transition.count !== 1) {
          throw new Error('Somente saque pendente ou em processamento pode ser rejeitado.');
        }

        const walletMutation = await tx.wallet.updateMany({
          where: {
            id: wallet.id,
            fiatPendingWithdrawalBalance: { gte: withdrawal.amount },
          },
          data: {
            fiatPendingWithdrawalBalance: { decrement: withdrawal.amount },
            fiatAvailableBalance: { increment: withdrawal.amount },
          },
        });

        if (walletMutation.count !== 1) {
          throw new Error('Operação inválida de saldo ao rejeitar saque.');
        }

        const updatedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
        const next = await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: withdrawal.id } });

        await createWalletTransaction(tx, wallet.id, 'WITHDRAWAL_REJECTED', withdrawal.amount, 'Saque rejeitado');

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'WITHDRAWAL_REJECTED',
            entity: 'WithdrawalRequest',
            reason: body.adminNote ?? 'Saque rejeitado no painel administrativo.',
            previous: JSON.stringify({
              status: withdrawal.status,
              fiatAvailableBalance: wallet.fiatAvailableBalance.toString(),
              fiatPendingWithdrawalBalance: wallet.fiatPendingWithdrawalBalance.toString(),
            }),
            current: JSON.stringify({
              status: next.status,
              fiatAvailableBalance: updatedWallet.fiatAvailableBalance.toString(),
              fiatPendingWithdrawalBalance: updatedWallet.fiatPendingWithdrawalBalance.toString(),
            }),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });

        return next;
      });

      return updated;
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });
}
