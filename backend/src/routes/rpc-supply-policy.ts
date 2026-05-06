import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditRpcSupplyConsistency, getRpcSupplyPolicySummary } from '../services/rpc-supply-policy-service.js';

type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };

export async function rpcSupplyPolicyRoutes(app: FastifyInstance) {
  app.get('/admin/rpc-supply-policy', { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const authRequest = request as AuthRequest;
      return await getRpcSupplyPolicySummary(authRequest.user.roles ?? []);
    } catch (error) {
      const statusCode = (error as Error & { statusCode?: number }).statusCode ?? 400;
      return reply.code(statusCode).send({ message: (error as Error).message });
    }
  });

  app.get('/admin/rpc-supply-policy/audit', { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const authRequest = request as AuthRequest;
      await getRpcSupplyPolicySummary(authRequest.user.roles ?? []);
      return await auditRpcSupplyConsistency();
    } catch (error) {
      const statusCode = (error as Error & { statusCode?: number }).statusCode ?? 400;
      return reply.code(statusCode).send({ message: (error as Error).message });
    }
  });

  app.patch('/admin/rpc-supply-policy', { preHandler: [app.authenticate] }, async (_request, reply) => {
    return reply.code(404).send({ message: 'Política editável não implementada nesta etapa. Endpoint somente leitura.' });
  });
}
