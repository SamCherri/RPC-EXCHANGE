import { Prisma } from '@prisma/client';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ensurePermission, GRANULAR_PERMISSIONS } from '../services/permission-service.js';

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
      users: users.map((user: { id: string; name: string | null; email: string | null; discord: string; gamePhone: string; characterName: string | null; bankAccountNumber: string | null; roles: Array<{ role: { key: string } }>; isBlocked: boolean; wallet: { availableBalance: unknown; lockedBalance: unknown; pendingWithdrawalBalance: unknown } | null; createdAt: Date }) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        discord: user.discord,
        gamePhone: user.gamePhone,
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
        discord: user.discord,
        gamePhone: user.gamePhone,
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

  app.get('/registrations/pending', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    try { await ensurePermission(authRequest.user.sub, 'registration.review'); } catch { return reply.code(403).send({ message: 'Sem permissão para revisar cadastros.' }); }
    const users = await prisma.user.findMany({
      where: { approvalStatus: { in: ['PENDING', 'CORRECTION_REQUIRED'] } },
      select: { id: true, name: true, characterName: true, discord: true, gamePhone: true, approvalStatus: true, approvalReason: true, lastSubmittedAt: true, registrationEvidences: { where: { status: 'ACTIVE' }, select: { id: true, mimeType: true, sizeBytes: true, sha256: true, createdAt: true }, take: 1 } },
      orderBy: { lastSubmittedAt: 'asc' },
      take: 200,
    });
    return { users };
  });

  app.post('/registrations/:id/approve', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    try { await ensurePermission(authRequest.user.sub, 'registration.review'); } catch { return reply.code(403).send({ message: 'Sem permissão para revisar cadastros.' }); }
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    if (id === authRequest.user.sub) return reply.code(400).send({ message: 'Administrador não pode aprovar o próprio cadastro.' });
    const user = await prisma.user.findUnique({ where: { id }, select: { approvalStatus: true } });
    if (!user) return reply.code(404).send({ message: 'Cadastro não encontrado.' });
    if (!['PENDING', 'CORRECTION_REQUIRED', 'REJECTED'].includes(user.approvalStatus)) return reply.code(400).send({ message: 'Cadastro já decidido.' });
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { approvalStatus: 'APPROVED', approvalReason: null, approvedAt: new Date(), approvedById: authRequest.user.sub, reviewedAt: new Date() } });
      await tx.adminLog.create({ data: { action: 'APPROVE_REGISTRATION', entity: 'User', userId: authRequest.user.sub, reason: `Aprovou cadastro ${id}` } });
    });
    return { message: 'Cadastro aprovado.' };
  });

  app.post('/registrations/:id/request-correction', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    try { await ensurePermission(authRequest.user.sub, 'registration.review'); } catch { return reply.code(403).send({ message: 'Sem permissão para revisar cadastros.' }); }
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ reason: z.string().min(3) }).parse(request.body);
    if (id === authRequest.user.sub) return reply.code(400).send({ message: 'Administrador não pode revisar o próprio cadastro.' });
    const updated = await prisma.user.updateMany({ where: { id, approvalStatus: { in: ['PENDING', 'CORRECTION_REQUIRED'] } }, data: { approvalStatus: 'CORRECTION_REQUIRED', approvalReason: body.reason, reviewedAt: new Date() } });
    if (updated.count !== 1) return reply.code(400).send({ message: 'Cadastro não encontrado ou já decidido.' });
    await app.logAdmin({ action: 'REQUEST_REGISTRATION_CORRECTION', entity: 'User', userId: authRequest.user.sub, reason: body.reason, current: id });
    return { message: 'Correção solicitada.' };
  });

  app.post('/registrations/:id/reject', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    try { await ensurePermission(authRequest.user.sub, 'registration.review'); } catch { return reply.code(403).send({ message: 'Sem permissão para revisar cadastros.' }); }
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ reason: z.string().min(3) }).parse(request.body);
    if (id === authRequest.user.sub) return reply.code(400).send({ message: 'Administrador não pode rejeitar o próprio cadastro.' });
    const updated = await prisma.user.updateMany({ where: { id, approvalStatus: { in: ['PENDING', 'CORRECTION_REQUIRED'] } }, data: { approvalStatus: 'REJECTED', approvalReason: body.reason, rejectedAt: new Date(), reviewedAt: new Date() } });
    if (updated.count !== 1) return reply.code(400).send({ message: 'Cadastro não encontrado ou já decidido.' });
    await app.logAdmin({ action: 'REJECT_REGISTRATION', entity: 'User', userId: authRequest.user.sub, reason: body.reason, current: id });
    return { message: 'Cadastro rejeitado.' };
  });

  app.post('/registrations/:id/suspend', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    try { await ensurePermission(authRequest.user.sub, 'registration.review'); } catch { return reply.code(403).send({ message: 'Sem permissão para suspender cadastros.' }); }
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ reason: z.string().min(3) }).parse(request.body);
    if (id === authRequest.user.sub) return reply.code(400).send({ message: 'Administrador não pode suspender o próprio cadastro.' });
    await prisma.user.update({ where: { id }, data: { approvalStatus: 'SUSPENDED', approvalReason: body.reason, reviewedAt: new Date() } });
    await app.logAdmin({ action: 'SUSPEND_REGISTRATION', entity: 'User', userId: authRequest.user.sub, reason: body.reason, current: id });
    return { message: 'Cadastro suspenso.' };
  });

  app.get('/profile-change-requests', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    try { await ensurePermission(authRequest.user.sub, 'registration.review'); } catch { return reply.code(403).send({ message: 'Sem permissão para revisar perfil.' }); }
    const requests = await prisma.profileChangeRequest.findMany({ where: { status: 'PENDING' }, include: { user: { select: { id: true, name: true, discord: true, gamePhone: true, characterName: true } } }, orderBy: { createdAt: 'asc' }, take: 200 });
    return { requests };
  });

  app.post('/profile-change-requests/:id/approve', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    try { await ensurePermission(authRequest.user.sub, 'registration.review'); } catch { return reply.code(403).send({ message: 'Sem permissão para revisar perfil.' }); }
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const change = await prisma.profileChangeRequest.findUnique({ where: { id } });
    if (!change || change.status !== 'PENDING') return reply.code(400).send({ message: 'Solicitação não encontrada ou já decidida.' });
    if (change.userId === authRequest.user.sub) return reply.code(400).send({ message: 'Administrador não pode aprovar a própria solicitação.' });
    await prisma.$transaction(async (tx) => {
      const data = change.field === 'CHARACTER_NAME' ? { characterName: change.requestedValue } : change.field === 'DISCORD' ? { discord: change.requestedValue } : { gamePhone: change.requestedValue };
      await tx.user.update({ where: { id: change.userId }, data });
      await tx.profileChangeRequest.update({ where: { id }, data: { status: 'APPROVED', reviewedById: authRequest.user.sub, reviewedAt: new Date() } });
      await tx.adminLog.create({ data: { action: 'APPROVE_PROFILE_CHANGE', entity: 'ProfileChangeRequest', userId: authRequest.user.sub, previous: change.currentValue, current: change.requestedValue } });
    });
    return { message: 'Alteração aprovada.' };
  });

  app.post('/profile-change-requests/:id/reject', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    try { await ensurePermission(authRequest.user.sub, 'registration.review'); } catch { return reply.code(403).send({ message: 'Sem permissão para revisar perfil.' }); }
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ reason: z.string().min(3) }).parse(request.body);
    const updated = await prisma.profileChangeRequest.updateMany({ where: { id, status: 'PENDING', userId: { not: authRequest.user.sub } }, data: { status: 'REJECTED', reason: body.reason, reviewedById: authRequest.user.sub, reviewedAt: new Date() } });
    if (updated.count !== 1) return reply.code(400).send({ message: 'Solicitação não encontrada, própria ou já decidida.' });
    await app.logAdmin({ action: 'REJECT_PROFILE_CHANGE', entity: 'ProfileChangeRequest', userId: authRequest.user.sub, reason: body.reason, current: id });
    return { message: 'Alteração rejeitada.' };
  });

  app.get('/financial-permissions', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    if (!(authRequest.user.roles ?? []).includes('SUPER_ADMIN')) return reply.code(403).send({ message: 'Somente SUPER_ADMIN pode listar permissões granulares.' });
    const users = await prisma.user.findMany({ where: { grantedPermissions: { some: { permission: { key: { in: [...GRANULAR_PERMISSIONS] } } } } }, select: { id: true, name: true, discord: true, grantedPermissions: { select: { permission: { select: { key: true } }, reason: true, createdAt: true } } } });
    return { permissions: GRANULAR_PERMISSIONS, users };
  });

  app.post('/financial-permissions/grant', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    if (!(authRequest.user.roles ?? []).includes('SUPER_ADMIN')) return reply.code(403).send({ message: 'Somente SUPER_ADMIN pode conceder permissões granulares.' });
    const body = z.object({ userId: z.string().min(1), permissionKey: z.enum(GRANULAR_PERMISSIONS), reason: z.string().min(3) }).parse(request.body);
    if (body.userId === authRequest.user.sub) return reply.code(400).send({ message: 'SUPER_ADMIN não deve conceder permissão granular a si mesmo por este fluxo.' });
    const permission = await prisma.permission.upsert({ where: { key: body.permissionKey }, update: {}, create: { key: body.permissionKey } });
    await prisma.userPermission.upsert({ where: { userId_permissionId: { userId: body.userId, permissionId: permission.id } }, update: { reason: body.reason, grantedById: authRequest.user.sub }, create: { userId: body.userId, permissionId: permission.id, reason: body.reason, grantedById: authRequest.user.sub } });
    await app.logAdmin({ action: 'GRANT_FINANCIAL_PERMISSION', entity: 'UserPermission', userId: authRequest.user.sub, reason: body.reason, current: JSON.stringify({ userId: body.userId, permissionKey: body.permissionKey }) });
    return { message: 'Permissão concedida.' };
  });

  app.post('/financial-permissions/revoke', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    if (!(authRequest.user.roles ?? []).includes('SUPER_ADMIN')) return reply.code(403).send({ message: 'Somente SUPER_ADMIN pode retirar permissões granulares.' });
    const body = z.object({ userId: z.string().min(1), permissionKey: z.enum(GRANULAR_PERMISSIONS), reason: z.string().min(3) }).parse(request.body);
    const permission = await prisma.permission.findUnique({ where: { key: body.permissionKey } });
    if (permission) await prisma.userPermission.deleteMany({ where: { userId: body.userId, permissionId: permission.id } });
    await app.logAdmin({ action: 'REVOKE_FINANCIAL_PERMISSION', entity: 'UserPermission', userId: authRequest.user.sub, reason: body.reason, previous: JSON.stringify({ userId: body.userId, permissionKey: body.permissionKey }) });
    return { message: 'Permissão retirada.' };
  });

}
