import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { loginUser, registerUser } from '../services/auth-service.js';
import { prisma } from '../lib/prisma.js';
import { REGISTRATION_PROOF_BODY_LIMIT_BYTES, normalizeRegistrationProof } from '../services/registration-proof-service.js';
import { ADMIN_ROLES, hasAnyRole } from '../lib/roles.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', { bodyLimit: REGISTRATION_PROOF_BODY_LIMIT_BYTES, config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 5, timeWindow: '1 minute' } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const schema = z.object({
      name: z.string().min(3),
      characterName: z.string().min(3),
      discordId: z.string().min(2),
      characterPhone: z.string().min(3),
      screenshot: z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), fileName: z.string().optional(), data: z.string().min(20) }),
      password: z.string().min(8),
      passwordConfirmation: z.string().min(8).optional(),
    });

    try {
      const body = schema.parse(request.body);
      if (body.passwordConfirmation !== undefined && body.passwordConfirmation !== body.password) {
        return reply.code(400).send({ message: 'A confirmação de senha não confere.' });
      }
      const proof = normalizeRegistrationProof(body.screenshot);
      const user = await registerUser(body.name, body.characterName, body.discordId, body.characterPhone, body.password, {
        mimeType: proof.mimeType,
        fileName: proof.fileName,
        data: proof.data,
        checksum: proof.checksum,
      });
      await app.logAdmin({ action: 'CREATE_ACCOUNT', entity: 'User', userId: user.id, reason: 'Cadastro inicial' });

      return reply.code(201).send({
        id: user.id,
        name: user.name,
        characterName: user.characterName,
        discordId: user.discordId,
        characterPhone: user.characterPhone,
        approvalStatus: user.approvalStatus,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        const firstIssue = error.issues[0];
        return reply.code(400).send({ message: firstIssue?.message ?? 'Dados de cadastro inválidos.' });
      }
      return reply.code(400).send({ message: (error as Error).message });
    }
  });



  app.get('/auth/me', { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const schema = z.object({ sub: z.string() });
    const payload = schema.parse(request.user);

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        wallet: true,
        roles: { include: { role: true } },
      },
    });

    if (!user) {
      return reply.code(401).send({ message: 'Não autenticado.' });
    }

    const roles = user.roles.map((item: { role: { key: string } }) => item.role.key);

    return {
      user: {
        id: user.id,
        name: user.name,
        characterName: user.characterName,
        discordId: user.discordId,
        characterPhone: user.characterPhone,
        approvalStatus: user.approvalStatus,
        roles,
        isBlocked: user.isBlocked,
        createdAt: user.createdAt,
      },
      wallet: user.wallet
        ? {
            fiatAvailableBalance: user.wallet.fiatAvailableBalance,
            fiatLockedBalance: user.wallet.fiatLockedBalance,
            fiatPendingWithdrawalBalance: user.wallet.fiatPendingWithdrawalBalance,
            rpcAvailableBalance: user.wallet.rpcAvailableBalance,
            rpcLockedBalance: user.wallet.rpcLockedBalance,
            availableBalance: user.wallet.availableBalance,
            lockedBalance: user.wallet.lockedBalance,
            pendingWithdrawalBalance: user.wallet.pendingWithdrawalBalance,
          }
        : {
            fiatAvailableBalance: '0',
            fiatLockedBalance: '0',
            fiatPendingWithdrawalBalance: '0',
            rpcAvailableBalance: '0',
            rpcLockedBalance: '0',
            availableBalance: '0',
            lockedBalance: '0',
            pendingWithdrawalBalance: '0',
          },
    };
  });

  app.post('/auth/login', { config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 8, timeWindow: '1 minute' } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const schema = z.object({ discordId: z.string().min(2), password: z.string().min(8) });

    try {
      const body = schema.parse(request.body);
      const user = await loginUser(body.discordId, body.password);
      const roles = user.roles.map((item: { role: { key: string } }) => item.role.key);

      const expiresIn = roles.some((role: string) => ADMIN_ROLES.includes(role)) ? '2h' : '8h';
      const token = await reply.jwtSign({ sub: user.id, roles }, { expiresIn });
      await app.logAdmin({ action: 'LOGIN', entity: 'User', userId: user.id, reason: 'Login bem-sucedido' });

      return { token, user: { id: user.id, name: user.name, discordId: user.discordId, roles } };
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({ message: 'Dados de login inválidos.' });
      }
      const message = (error as Error).message;
      if (message === 'Credenciais inválidas.' || message === 'Muitas tentativas inválidas. Tente novamente mais tarde.') {
        return reply.code(401).send({ message });
      }
      return reply.code(400).send({ message });
    }
  });
}
