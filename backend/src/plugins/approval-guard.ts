import fp from 'fastify-plugin';
import { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma.js';

const ECONOMIC_PREFIXES = [
  '/api/market',
  '/api/companies',
  '/api/me/holdings',
  '/api/withdrawals',
  '/api/rpc-market',
  '/api/broker',
  '/api/project-boosts',
  '/api/project-capital-flow',
];

function needsApproval(url: string) {
  return ECONOMIC_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export default fp(async (app) => {
  app.decorate('requireApprovedUser', async function (request: FastifyRequest, reply: FastifyReply) {
    const payload = request.user as { sub?: string; roles?: string[] } | undefined;
    if (!payload?.sub) return reply.code(401).send({ message: 'Não autenticado.' });
    const isAdmin = (payload.roles ?? []).some((role) => ['ADMIN', 'SUPER_ADMIN', 'COIN_CHIEF_ADMIN'].includes(role));
    if (isAdmin) return;
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { approvalStatus: true } });
    if (!user || user.approvalStatus !== 'APPROVED') return reply.code(403).send({ message: 'Cadastro ainda não aprovado. Acesse a tela de acompanhamento do cadastro.' });
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!needsApproval(request.url)) return;
    const auth = request.headers.authorization;
    if (!auth) return;
    try {
      await request.jwtVerify();
      return app.requireApprovedUser(request, reply);
    } catch {
      return;
    }
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    requireApprovedUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
