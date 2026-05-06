import { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { getEconomicAuditSummary, runEconomicAudit } from '../services/economic-audit-service.js';

type AuthRequest = FastifyRequest & { user: { roles?: string[] } };

const includeWarningsSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

const querySchema = z.object({
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'WARNING']).optional(),
  category: z.string().min(1).optional(),
  companyId: z.string().min(1).optional(),
  entity: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  includeWarnings: includeWarningsSchema,
});

function toHttpError(error: unknown) {
  if (error instanceof ZodError) {
    return { statusCode: 400, message: 'Parâmetros inválidos.', details: error.issues };
  }
  const statusCode = (error as { statusCode?: number })?.statusCode ?? 500;
  return { statusCode, message: error instanceof Error ? error.message : 'Erro interno.' };
}

export async function economicAuditRoutes(app: FastifyInstance) {
  app.get('/admin/economic-audit', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const roles = (request as AuthRequest).user.roles ?? [];
      const filters = querySchema.parse(request.query);
      return await runEconomicAudit({ actorRoles: roles, filters });
    } catch (error) {
      const e = toHttpError(error);
      return reply.code(e.statusCode).send({ message: e.message, ...(e as { details?: unknown }).details ? { details: (e as { details: unknown }).details } : {} });
    }
  });

  app.get('/admin/economic-audit/summary', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const roles = (request as AuthRequest).user.roles ?? [];
      return await getEconomicAuditSummary(roles);
    } catch (error) {
      const e = toHttpError(error);
      return reply.code(e.statusCode).send({ message: e.message, ...(e as { details?: unknown }).details ? { details: (e as { details: unknown }).details } : {} });
    }
  });
}
