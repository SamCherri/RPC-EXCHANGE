import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { changeUserPassword, loginUser, registerUser, updateUserProfile } from '../services/auth-service.js';
import { prisma } from '../lib/prisma.js';
import { replaceActiveRegistrationEvidence } from '../services/registration-evidence-service.js';

type PublicUserInput = { id: string; name: string; characterName: string | null; discord: string; gamePhone: string; email: string | null; approvalStatus?: string; approvalReason?: string | null; roles?: Array<{ role: { key: string } }>; isBlocked?: boolean; createdAt?: Date };

function publicUser(user: PublicUserInput) {
  return {
    id: user.id,
    name: user.name,
    characterName: user.characterName,
    discord: user.discord,
    gamePhone: user.gamePhone,
    approvalStatus: user.approvalStatus,
    approvalReason: user.approvalReason,
    roles: user.roles?.map((item) => item.role.key) ?? undefined,
    isBlocked: user.isBlocked,
    createdAt: user.createdAt,
  };
}

const evidenceSchema = z.object({
  fileName: z.string().max(160).optional(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  dataBase64: z.string().min(20),
});

function walletPayload(user: { approvalStatus: string; wallet: any }) {
  if (user.approvalStatus !== 'APPROVED') return null;
  return user.wallet ? {
    fiatAvailableBalance: user.wallet.fiatAvailableBalance,
    fiatLockedBalance: user.wallet.fiatLockedBalance,
    fiatPendingWithdrawalBalance: user.wallet.fiatPendingWithdrawalBalance,
    rpcAvailableBalance: user.wallet.rpcAvailableBalance,
    rpcLockedBalance: user.wallet.rpcLockedBalance,
    availableBalance: user.wallet.availableBalance,
    lockedBalance: user.wallet.lockedBalance,
    pendingWithdrawalBalance: user.wallet.pendingWithdrawalBalance,
  } : { fiatAvailableBalance: '0', fiatLockedBalance: '0', fiatPendingWithdrawalBalance: '0', rpcAvailableBalance: '0', rpcLockedBalance: '0', availableBalance: '0', lockedBalance: '0', pendingWithdrawalBalance: '0' };
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', { config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 10, timeWindow: '1 minute' } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const schema = z.object({ name: z.string().min(3), characterName: z.string().min(3), discord: z.string().min(2), gamePhone: z.string().min(3), password: z.string().min(8), evidence: evidenceSchema });
    try {
      const body = schema.parse(request.body);
      const user = await registerUser(body.name, body.characterName, body.discord, body.gamePhone, body.password, body.evidence);
      await app.logAdmin({ action: 'CREATE_ACCOUNT_PENDING_REVIEW', entity: 'User', userId: user.id, reason: 'Cadastro inicial por Discord aguardando comprovante SunCity' });
      return reply.code(201).send(publicUser(user));
    } catch (error) {
      if (error instanceof ZodError) return reply.code(400).send({ message: error.issues[0]?.message ?? 'Dados de cadastro inválidos.' });
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = z.object({ sub: z.string() }).parse(request.user);
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { wallet: true, roles: { include: { role: true } } } });
    if (!user) return reply.code(401).send({ message: 'Não autenticado.' });
    return { user: publicUser(user), wallet: walletPayload(user) };
  });

  app.get('/auth/registration-status', { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = z.object({ sub: z.string() }).parse(request.user);
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { approvalStatus: true, approvalReason: true, reviewedAt: true, lastSubmittedAt: true } });
    if (!user) return reply.code(401).send({ message: 'Não autenticado.' });
    return user;
  });

  app.put('/auth/registration-resubmit', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    const payload = z.object({ sub: z.string() }).parse(request.user);
    const schema = z.object({ name: z.string().min(3), characterName: z.string().min(3), discord: z.string().min(2), gamePhone: z.string().min(3), evidence: evidenceSchema });
    try {
      const body = schema.parse(request.body);
      const existing = await prisma.user.findUniqueOrThrow({ where: { id: payload.sub } });
      if (!['PENDING', 'CORRECTION_REQUIRED', 'REJECTED'].includes(existing.approvalStatus)) return reply.code(400).send({ message: 'Cadastro não está em estado de correção.' });
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: payload.sub }, data: { name: body.name.trim(), characterName: body.characterName.trim(), discord: body.discord.trim().replace(/^@+/, '').toLowerCase(), gamePhone: body.gamePhone.trim(), approvalStatus: 'PENDING', approvalReason: 'Correção reenviada para análise.', lastSubmittedAt: new Date() } });
        await replaceActiveRegistrationEvidence(payload.sub, body.evidence, tx);
      });
      await app.logAdmin({ action: 'RESUBMIT_REGISTRATION', entity: 'User', userId: payload.sub, reason: 'Jogador reenviou cadastro corrigido' });
      return { message: 'Cadastro reenviado para análise.' };
    } catch (error) {
      if (error instanceof ZodError) return reply.code(400).send({ message: error.issues[0]?.message ?? 'Dados inválidos.' });
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.get('/auth/registration-evidence/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = z.object({ sub: z.string(), roles: z.array(z.string()).optional() }).parse(request.user);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const evidence = await prisma.registrationEvidence.findUnique({ where: { id }, include: { user: { select: { id: true } } } });
    if (!evidence) return reply.code(404).send({ message: 'Comprovante não encontrado.' });
    const isAdmin = (payload.roles ?? []).some((role) => ['ADMIN', 'SUPER_ADMIN', 'COIN_CHIEF_ADMIN'].includes(role));
    if (evidence.userId !== payload.sub && !isAdmin) return reply.code(403).send({ message: 'Sem acesso ao comprovante.' });
    if (isAdmin && evidence.userId !== payload.sub) await app.logAdmin({ action: 'VIEW_REGISTRATION_EVIDENCE', entity: 'RegistrationEvidence', userId: payload.sub, reason: `Visualizou comprovante ${id}` });
    return reply.header('Content-Type', evidence.mimeType).send(Buffer.from(evidence.content));
  });

  app.put('/auth/profile', { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = z.object({ sub: z.string() }).parse(request.user);
    const schema = z.object({ name: z.string().min(3), characterName: z.string().min(3), discord: z.string().min(2), gamePhone: z.string().min(3) });
    try {
      const body = schema.parse(request.body);
      const result = await updateUserProfile(payload.sub, body);
      await app.logAdmin({ action: 'UPDATE_OWN_PROFILE', entity: 'User', userId: payload.sub, reason: result.pendingSensitiveChanges ? 'Jogador solicitou alteração sensível de perfil' : 'Jogador editou nome do próprio perfil' });
      return { user: publicUser(result.user), pendingSensitiveChanges: result.pendingSensitiveChanges };
    } catch (error) {
      if (error instanceof ZodError) return reply.code(400).send({ message: error.issues[0]?.message ?? 'Dados de perfil inválidos.' });
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.put('/auth/change-password', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 5, timeWindow: '1 minute' } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = z.object({ sub: z.string() }).parse(request.user);
    const schema = z.object({ currentPassword: z.string().min(8), newPassword: z.string().min(8), confirmPassword: z.string().min(8) }).refine((data) => data.newPassword === data.confirmPassword, { message: 'Confirmação de senha não confere.', path: ['confirmPassword'] });
    try {
      const body = schema.parse(request.body);
      await changeUserPassword(payload.sub, body.currentPassword, body.newPassword);
      return { message: 'Senha alterada com sucesso.' };
    } catch (error) {
      if (error instanceof ZodError) return reply.code(400).send({ message: error.issues[0]?.message ?? 'Dados de senha inválidos.' });
      return reply.code((error as Error).message === 'Senha atual inválida.' ? 401 : 400).send({ message: (error as Error).message });
    }
  });

  app.post('/auth/login', { config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 8, timeWindow: '1 minute' } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const schema = z.object({ discord: z.string().min(2), password: z.string().min(8) });
    try {
      const body = schema.parse(request.body);
      const user = await loginUser(body.discord, body.password);
      const roles = user.roles.map((item: { role: { key: string } }) => item.role.key);
      const token = await reply.jwtSign({ sub: user.id, roles }, { expiresIn: roles.some((role: string) => ['ADMIN', 'SUPER_ADMIN', 'COIN_CHIEF_ADMIN'].includes(role)) ? '2h' : '8h' });
      await app.logAdmin({ action: 'LOGIN', entity: 'User', userId: user.id, reason: 'Login bem-sucedido por Discord/e-mail legado' });
      return { token, user: { ...publicUser(user), roles } };
    } catch (error) {
      if (error instanceof ZodError) return reply.code(400).send({ message: 'Dados de login inválidos.' });
      const message = (error as Error).message;
      if (message === 'Credenciais inválidas.' || message === 'Muitas tentativas inválidas. Tente novamente mais tarde.') return reply.code(401).send({ message });
      return reply.code(400).send({ message });
    }
  });
}
