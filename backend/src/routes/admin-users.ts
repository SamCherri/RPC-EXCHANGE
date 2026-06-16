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
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        characterName: user.characterName,
        bankAccountNumber: user.bankAccountNumber,
        discordId: user.discordId,
        characterPhone: user.characterPhone,
        approvalStatus: user.approvalStatus,
        approvalNote: user.approvalNote,
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
        registrationProof: true,
        financialPermissions: true,
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
      registrationProof: user.registrationProof ? { id: user.registrationProof.id, mimeType: user.registrationProof.mimeType, fileName: user.registrationProof.fileName, checksum: user.registrationProof.checksum, updatedAt: user.registrationProof.updatedAt } : null,
      financialPermissions: user.financialPermissions,
      wallet: user.wallet,
      brokerAccount,
      projects: user.companies,
      holdings: user.holdings,
      latestTransactions,
      latestWithdrawals,
      latestAdminLogs,
    };
  });


  app.get('/users/pending-registrations', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, roles)) return;
    const users = await prisma.user.findMany({
      where: { approvalStatus: { in: ['PENDING', 'NEEDS_CORRECTION'] } },
      include: { registrationProof: { select: { id: true, mimeType: true, fileName: true, checksum: true, updatedAt: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return { users };
  });

  app.get('/users/:id/registration-proof', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, roles)) return;
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const proof = await prisma.registrationProof.findUnique({ where: { userId: id } });
    if (!proof) return reply.code(404).send({ message: 'Comprovante não encontrado.' });
    return reply.header('Content-Type', proof.mimeType).send(Buffer.from(proof.data, 'base64'));
  });

  app.patch('/users/:id/approval', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!ensureAdmin(reply, roles)) return;
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ status: z.enum(['APPROVED', 'NEEDS_CORRECTION', 'REJECTED']), note: z.string().min(3).optional() }).parse(request.body);
    const previous = await prisma.user.findUnique({ where: { id }, select: { approvalStatus: true, approvalNote: true } });
    if (!previous) return reply.code(404).send({ message: 'Usuário não encontrado.' });
    const updated = await prisma.user.update({ where: { id }, data: { approvalStatus: body.status, approvalNote: body.note ?? null, approvedAt: body.status === 'APPROVED' ? new Date() : null, approvedById: body.status === 'APPROVED' ? authRequest.user.sub : null } });
    await prisma.adminLog.create({ data: { userId: authRequest.user.sub, action: 'ADMIN_REGISTRATION_REVIEWED', entity: `User:${id}`, previous: JSON.stringify(previous), current: JSON.stringify({ approvalStatus: updated.approvalStatus, approvalNote: updated.approvalNote }), reason: body.note ?? 'Revisão de cadastro', ip: request.ip, userAgent: request.headers['user-agent'] ?? null } });
    return { message: 'Status de cadastro atualizado.', user: updated };
  });

  app.patch('/users/:id/financial-permissions', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!roles.includes('SUPER_ADMIN')) return reply.code(403).send({ message: 'Somente SUPER_ADMIN concede permissões financeiras.' });
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ permissions: z.array(z.enum(['RPC_MARKET_TRADE', 'COMPANY_MARKET_TRADE', 'PROJECT_CREATE', 'WITHDRAWAL_REQUEST', 'BROKER_TRANSFER'])), reason: z.string().min(5) }).parse(request.body);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ message: 'Usuário não encontrado.' });
    await prisma.$transaction(async (tx) => {
      const requested = new Set(body.permissions);
      const existing = await tx.userFinancialPermission.findMany({ where: { userId: id } });
      for (const grant of existing) {
        if (!requested.has(grant.permission) && !grant.revokedAt) await tx.userFinancialPermission.update({ where: { id: grant.id }, data: { revokedAt: new Date(), reason: body.reason } });
      }
      for (const permission of requested) {
        await tx.userFinancialPermission.upsert({ where: { userId_permission: { userId: id, permission } }, update: { revokedAt: null, grantedById: authRequest.user.sub, reason: body.reason }, create: { userId: id, permission, grantedById: authRequest.user.sub, reason: body.reason } });
      }
      await tx.adminLog.create({ data: { userId: authRequest.user.sub, action: 'ADMIN_FINANCIAL_PERMISSIONS_UPDATED', entity: `User:${id}`, current: JSON.stringify({ permissions: body.permissions }), reason: body.reason, ip: request.ip, userAgent: request.headers['user-agent'] ?? null } });
    });
    const financialPermissions = await prisma.userFinancialPermission.findMany({ where: { userId: id } });
    return { message: 'Permissões financeiras atualizadas.', financialPermissions };
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
