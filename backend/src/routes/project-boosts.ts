import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma.js';

type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };

const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN', 'COIN_CHIEF_ADMIN'];

const isAdmin = (roles: string[]) => ADMIN_ROLES.some((role) => roles.includes(role));

export async function projectBoostRoutes(app: FastifyInstance) {
  app.get('/project-boosts/my-projects', { preHandler: [app.authenticate] }, async (request) => {
    const auth = request as AuthRequest;
    const companies = await prisma.company.findMany({ where: { founderUserId: auth.user.sub, status: 'ACTIVE' }, include: { boostAccount: true, revenueAccount: true } });
    return { companies };
  });

  app.get('/project-boosts/companies/:companyId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const auth = request as AuthRequest;
    const { companyId } = request.params as { companyId: string };
    const accessProbe = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { founderUserId: true } });
    const canBoost = accessProbe.founderUserId === auth.user.sub || isAdmin(auth.user.roles ?? []);
    if (!canBoost) return reply.code(403).send({ message: 'Sem permissão para visualizar impulsões deste projeto.' });

    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, include: { boostAccount: true, revenueAccount: true, boostInjections: { orderBy: { createdAt: 'desc' }, take: 50 } } });
    return { company, canBoost };
  });

  app.post('/project-boosts/companies/:companyId/boost', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 20, timeWindow: '1 minute' } } }, async (_request, reply) => {
    return reply.code(410).send({ message: 'Impulsão legada desativada. Use aporte institucional ou recompra real contra ordens do livro.' });
  });

  app.get('/admin/project-boosts', { preHandler: [app.authenticate] }, async (request, reply) => {
    const auth = request as AuthRequest;
    const roles = auth.user.roles ?? [];
    if (!isAdmin(roles)) return reply.code(403).send({ message: 'Sem permissão.' });
    const injections = await prisma.companyBoostInjection.findMany({ take: 200, orderBy: { createdAt: 'desc' }, include: { company: { select: { ticker: true, name: true } }, user: { select: { email: true } } } });
    return { injections };
  });

  app.post('/admin/project-boosts/companies/:companyId/boost', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const auth = request as AuthRequest;
    const roles = auth.user.roles ?? [];
    if (!isAdmin(roles)) return reply.code(403).send({ message: 'Sem permissão.' });
    return reply.code(410).send({ message: 'Impulsão legada desativada. Use aporte institucional ou recompra real contra ordens do livro.' });
  });
}

