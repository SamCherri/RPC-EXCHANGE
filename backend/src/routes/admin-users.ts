import { Prisma } from '@prisma/client';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };

const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN', 'COIN_CHIEF_ADMIN'] as const;

function ensureAdmin(reply: FastifyReply, roles: string[]) {
  if (!ADMIN_ROLES.some((role) => roles.includes(role))) {
    reply.code(403).send({ message: 'Sem permissão administrativa.' });
    return false;
  }

  return true;
}

function ensureSuperAdminControl(reply: FastifyReply, actorRoles: string[], targetRoles: string[]) {
  const actorIsSuper = actorRoles.includes('SUPER_ADMIN');
  const touchingSuperAdmin = targetRoles.includes('SUPER_ADMIN');

  if (touchingSuperAdmin && !actorIsSuper) {
    reply.code(403).send({ message: 'Somente SUPER_ADMIN pode alterar role SUPER_ADMIN.' });
    return false;
  }

  return true;
}

export async function adminUsersRoutes(app: FastifyInstance) {
  app.get('/users', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, roles)) return;

    const query = z.object({
      search: z.string().optional(),
      role: z.string().optional(),
      status: z.enum(['ACTIVE', 'BLOCKED']).optional(),
    }).parse(request.query);

    const users = await prisma.user.findMany({
      where: {
        ...(query.search ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { discord: { contains: query.search, mode: 'insensitive' } },
            { gamePhone: { contains: query.search, mode: 'insensitive' } },
            { email: { contains: query.search, mode: 'insensitive' } },
            { characterName: { contains: query.search, mode: 'insensitive' } },
            { bankAccountNumber: { contains: query.search, mode: 'insensitive' } },
          ],
        } : {}),
        ...(query.status ? { isBlocked: query.status === 'BLOCKED' } : {}),
        ...(query.role ? { roles: { some: { role: { key: query.role } } } } : {}),
      },
      include: {
        roles: { include: { role: true } },
        wallet: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });

    return {
      users: users.map((user: { id: string; name: string | null; email: string | null; characterName: string | null; bankAccountNumber: string | null; roles: Array<{ role: { key: string } }>; isBlocked: boolean; wallet: { availableBalance: unknown; lockedBalance: unknown; pendingWithdrawalBalance: unknown } | null; createdAt: Date }) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        characterName: user.characterName,
        bankAccountNumber: user.bankAccountNumber,
        roles: user.roles.map((role: { role: { key: string } }) => role.role.key),
        isBlocked: user.isBlocked,
        wallet: {
          availableBalance: user.wallet?.availableBalance ?? 0,
          lockedBalance: user.wallet?.lockedBalance ?? 0,
          pendingWithdrawalBalance: user.wallet?.pendingWithdrawalBalance ?? 0,
        },
        createdAt: user.createdAt,
      })),
    };
  });

  app.get('/users/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, roles)) return;

    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        roles: { include: { role: true } },
        wallet: true,
        companies: { select: { id: true, name: true, ticker: true, status: true, createdAt: true } },
        holdings: {
          include: { company: { select: { id: true, ticker: true, name: true, status: true } } },
          orderBy: { updatedAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!user) return reply.code(404).send({ message: 'Usuário não encontrado.' });

    const [brokerAccount, latestTransactions, latestWithdrawals, latestAdminLogs] = await Promise.all([
      prisma.brokerAccount.findUnique({ where: { userId: id } }),
      user.wallet
        ? prisma.transaction.findMany({ where: { walletId: user.wallet.id }, orderBy: { createdAt: 'desc' }, take: 20 })
        : Promise.resolve([]),
      prisma.withdrawalRequest.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.adminLog.findMany({
        where: {
          OR: [
            { userId: id },
            { entity: { contains: id } },
            { current: { contains: id } },
            { previous: { contains: id } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        characterName: user.characterName,
        bankAccountNumber: user.bankAccountNumber,
        isBlocked: user.isBlocked,
        createdAt: user.createdAt,
      },
      roles: user.roles.map((role: { role: { key: string } }) => role.role.key),
      wallet: user.wallet,
      brokerAccount,
      projects: user.companies,
      holdings: user.holdings,
      latestTransactions,
      latestWithdrawals,
      latestAdminLogs,
    };
  });

  app.patch('/users/:id/roles', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 25, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const actorRoles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, actorRoles)) return;

    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const body = z.object({ roles: z.array(z.string()).min(1) }).parse(request.body);
      const normalizedRoles = Array.from(new Set(body.roles.map((role: string) => role.trim().toUpperCase())));
      if (!normalizedRoles.includes('USER')) normalizedRoles.push('USER');

      if (!ensureSuperAdminControl(reply, actorRoles, normalizedRoles)) return;

      const [targetUser, dbRoles] = await Promise.all([
        prisma.user.findUnique({ where: { id }, include: { roles: { include: { role: true } } } }),
        prisma.role.findMany({ where: { key: { in: normalizedRoles } } }),
      ]);

      if (!targetUser) return reply.code(404).send({ message: 'Usuário não encontrado.' });
      if (dbRoles.length !== normalizedRoles.length) {
        return reply.code(400).send({ message: 'Uma ou mais roles são inválidas.' });
      }

      const currentRoleKeys = targetUser.roles.map((role: { role: { key: string } }) => role.role.key);
      const removingSuperAdmin = currentRoleKeys.includes('SUPER_ADMIN') && !normalizedRoles.includes('SUPER_ADMIN');
      if (removingSuperAdmin) {
        if (!actorRoles.includes('SUPER_ADMIN')) {
          return reply.code(403).send({ message: 'Somente SUPER_ADMIN pode alterar role SUPER_ADMIN.' });
        }

        const superAdmins = await prisma.userRole.count({ where: { role: { key: 'SUPER_ADMIN' } } });
        if (superAdmins <= 1) {
          return reply.code(400).send({ message: 'Não é permitido remover o último SUPER_ADMIN do sistema.' });
        }
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({
          data: dbRoles.map((role: { id: string }) => ({ userId: id, roleId: role.id })),
        });

        if (normalizedRoles.includes('VIRTUAL_BROKER')) {
          await tx.brokerAccount.upsert({
            where: { userId: id },
            update: {},
            create: { userId: id },
          });
        }

        await tx.adminLog.create({
          data: {
            userId: authRequest.user.sub,
            action: 'ADMIN_USER_ROLES_UPDATED',
            entity: `User:${id}`,
            previous: JSON.stringify({ roles: currentRoleKeys }),
            current: JSON.stringify({ roles: normalizedRoles }),
            reason: 'Alteração administrativa de permissões.',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
        });
      });

      return { message: 'Permissões atualizadas com sucesso.' };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.patch('/users/:id/block', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 25, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const actorRoles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, actorRoles)) return;

    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const { reason } = z.object({ reason: z.string().min(2) }).parse(request.body);

      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) return reply.code(404).send({ message: 'Usuário não encontrado.' });

      await prisma.user.update({ where: { id }, data: { isBlocked: true } });
      await prisma.adminLog.create({
        data: {
          userId: authRequest.user.sub,
          action: 'ADMIN_USER_BLOCKED',
          entity: `User:${id}`,
          previous: JSON.stringify({ isBlocked: user.isBlocked }),
          current: JSON.stringify({ isBlocked: true }),
          reason,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        },
      });

      return { message: 'Usuário bloqueado com sucesso.' };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.patch('/users/:id/unblock', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 25, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const actorRoles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, actorRoles)) return;

    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const { reason } = z.object({ reason: z.string().min(2) }).parse(request.body);

      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) return reply.code(404).send({ message: 'Usuário não encontrado.' });

      await prisma.user.update({ where: { id }, data: { isBlocked: false } });
      await prisma.adminLog.create({
        data: {
          userId: authRequest.user.sub,
          action: 'ADMIN_USER_UNBLOCKED',
          entity: `User:${id}`,
          previous: JSON.stringify({ isBlocked: user.isBlocked }),
          current: JSON.stringify({ isBlocked: false }),
          reason,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        },
      });

      return { message: 'Usuário desbloqueado com sucesso.' };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });
}
