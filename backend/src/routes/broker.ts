import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertFinancialPermission } from '../services/registration-approval-service.js';
import { normalizeDiscord } from '../services/auth-service.js';
import { prisma } from '../lib/prisma.js';
import { hasSuperAdminRole } from '../lib/roles.js';

type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };

const transferSchema = z
  .object({
    userEmail: z.string().email().optional(),
    userId: z.string().min(1).optional(),
    userRef: z.string().min(1).optional(),
    amount: z.coerce.number().positive(),
    reason: z.string().min(3),
  })
  .refine((data) => Boolean(data.userEmail || data.userId || data.userRef), {
    message: 'Informe o Discord, ID interno, personagem, nome ou referência legada do usuário.',
    path: ['userRef'],
  });

function requireBroker(reply: FastifyReply, roles: string[]) {
  const isBroker = roles.includes('VIRTUAL_BROKER') || hasSuperAdminRole(roles);
  if (!isBroker) {
    reply.code(403).send({ message: 'Somente corretor virtual pode acessar esta rota.' });
    return false;
  }
  return true;
}

async function resolveUniqueUserByRef(tx: Prisma.TransactionClient, ref: string) {
  const trimmedRef = ref.trim();
  const normalizedDiscord = normalizeDiscord(trimmedRef);
  if (normalizedDiscord) {
    const discordUser = await tx.user.findFirst({
      where: { discordId: { equals: normalizedDiscord, mode: 'insensitive' } },
      include: { wallet: true },
    });
    if (discordUser) return discordUser;
  }

  const candidates = await tx.user.findMany({
    where: {
      OR: [
        { bankAccountNumber: { equals: trimmedRef } },
        { characterName: { equals: trimmedRef, mode: 'insensitive' } },
        { name: { equals: trimmedRef, mode: 'insensitive' } },
        { email: { equals: trimmedRef.toLowerCase(), mode: 'insensitive' } },
      ],
    },
    include: { wallet: true },
    take: 2,
  });

  if (candidates.length === 0) throw new Error('Usuário não encontrado.');
  if (candidates.length > 1) throw new Error('Referência ambígua. Use o Discord exato do usuário.');
  return candidates[0];
}

export async function brokerRoutes(app: FastifyInstance) {
  app.get('/broker/balance', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];

    if (!requireBroker(reply, roles)) return;

    const broker = await prisma.brokerAccount.upsert({
      where: { userId: authRequest.user.sub },
      update: {},
      create: { userId: authRequest.user.sub },
    });

    return {
      available: broker.available,
      receivedTotal: broker.receivedTotal,
    };
  });

  app.get('/broker/history', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];

    if (!requireBroker(reply, roles)) return;

    const transfers = await prisma.coinTransfer.findMany({
      where: {
        OR: [{ senderId: authRequest.user.sub }, { receiverId: authRequest.user.sub }],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return { transfers };
  });

  app.post('/broker/transfer-to-user', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];

    if (!requireBroker(reply, roles)) return;

    try {
      await assertFinancialPermission(authRequest.user.sub, 'BROKER_TRANSFER');
      const body = transferSchema.parse(request.body);

      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const broker = await tx.brokerAccount.upsert({
        where: { userId: authRequest.user.sub },
        update: {},
        create: { userId: authRequest.user.sub },
      });

      const amount = new Decimal(body.amount);

      if (broker.available.lessThan(amount)) {
        throw new Error('Saldo insuficiente no corretor.');
      }

      const normalizedEmail = body.userEmail?.trim().toLowerCase();
      const normalizedRef = body.userRef?.trim();
      const targetUser = body.userId
        ? await tx.user.findUnique({ where: { id: body.userId }, include: { wallet: true } })
        : normalizedEmail
          ? await tx.user.findUnique({ where: { email: normalizedEmail }, include: { wallet: true } })
          : await resolveUniqueUserByRef(tx, normalizedRef ?? '');
      if (!targetUser) {
        throw new Error('Usuário de destino não encontrado.');
      }

      const wallet = targetUser.wallet ?? await tx.wallet.create({ data: { userId: targetUser.id } });

      const brokerPrevious = broker.available;
      const brokerNext = broker.available.sub(amount);
      const userPrevious = wallet.fiatAvailableBalance;
      const userNext = wallet.fiatAvailableBalance.add(amount);

      const transfer = await tx.coinTransfer.create({
        data: {
          type: 'BROKER_TO_USER',
          senderId: authRequest.user.sub,
          receiverId: targetUser.id,
          amount,
          reason: body.reason,
          previousValue: brokerPrevious,
          newValue: brokerNext,
        },
      });

      await tx.brokerAccount.update({ where: { id: broker.id }, data: { available: brokerNext } });
      await tx.wallet.update({ where: { id: wallet.id }, data: { fiatAvailableBalance: userNext } });

      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'BROKER_FIAT_TRANSFER_IN',
          amount,
          description: `Recebido do corretor virtual em R$ (${authRequest.user.sub}) - ${body.reason}`,
        },
      });

      await tx.adminLog.create({
        data: {
          userId: authRequest.user.sub,
          action: 'BROKER_TRANSFER_TO_USER',
          entity: 'Wallet',
          reason: body.reason,
          previous: JSON.stringify({ brokerBalance: brokerPrevious.toString(), userBalance: userPrevious.toString() }),
          current: JSON.stringify({
            brokerBalance: brokerNext.toString(),
            userBalance: userNext.toString(),
            amount: amount.toString(),
            targetUserId: targetUser.id,
            targetUserEmail: targetUser.email,
          }),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        },
      });

      return {
        transfer,
        brokerBalance: brokerNext,
        userBalance: userNext,
      };
    });

      return reply.code(201).send(result);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });
}
