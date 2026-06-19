import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { contributeRpcToProject, HttpError } from '../services/project-capital-flow-service.js';

type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };
const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN', 'COIN_CHIEF_ADMIN'];
const isAdmin = (roles: string[]) => roles.some((r) => ADMIN_ROLES.includes(r));

export async function projectCapitalFlowRoutes(app: FastifyInstance) {
  app.get('/project-capital-flow/my-projects', { preHandler: [app.authenticate] }, async (request) => {
    const auth = request as AuthRequest;
    const wallet = await prisma.wallet.findUnique({ where: { userId: auth.user.sub } });
    const companies = await prisma.company.findMany({ where: { founderUserId: auth.user.sub, status: 'ACTIVE' }, include: { revenueAccount: true, boostAccount: true, capitalFlowEntries: { orderBy: { createdAt: 'desc' }, take: 10 } } });
    return { walletRpcAvailableBalance: wallet?.rpcAvailableBalance ?? 0, companies };
  });

  app.get('/project-capital-flow/companies/:companyId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const auth = request as AuthRequest;
    try {
      const { companyId } = z.object({ companyId: z.string().min(1) }).parse(request.params);
      const company = await prisma.company.findUnique({ where: { id: companyId }, include: { revenueAccount: true, capitalFlowEntries: { orderBy: { createdAt: 'desc' }, take: 50 } } });
      if (!company) return reply.code(404).send({ message: 'Projeto não encontrado.' });
      if (company.founderUserId !== auth.user.sub && !isAdmin((auth.user.roles ?? []).map((r) => r.toUpperCase()))) return reply.code(403).send({ message: 'Sem permissão.' });
      return { company };
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.post('/project-capital-flow/companies/:companyId/contribute', { preHandler: [app.authenticate] }, async (request, reply) => {
    const auth = request as AuthRequest;
    try {
      const { companyId } = z.object({ companyId: z.string().min(1) }).parse(request.params);
      const body = z.object({ amountRpc: z.coerce.number(), reason: z.string(), idempotencyKey: z.string().optional() }).parse(request.body);
      const headerKey = request.headers['idempotency-key'];
      const idempotencyKey = typeof headerKey === 'string' ? headerKey : body.idempotencyKey;
      const result = await contributeRpcToProject({ companyId, actorUserId: auth.user.sub, amountRpc: body.amountRpc, reason: body.reason, idempotencyKey, ip: request.ip, userAgent: request.headers['user-agent'] ?? null });
      return result;
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ message: error.message });
      return reply.code(400).send({ message: (error as Error).message });
    }
  });
}
