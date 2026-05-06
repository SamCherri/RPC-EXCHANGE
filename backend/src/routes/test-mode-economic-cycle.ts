import { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { getSimulationRun, listSimulationRuns, runFullEconomicCycleSimulation } from '../services/test-mode-economic-cycle-service.js';

const optionsSchema = z.object({
  initialFiatBalance: z.number().finite().min(0).optional(),
  initialRpcPrice: z.number().finite().gt(0).optional(),
  initialTokenPrice: z.number().finite().gt(0).optional(),
  companyTotalShares: z.number().int().positive().optional(),
  includeDistribution: z.boolean().optional(),
  includeBuyback: z.boolean().optional(),
  lowLiquidityMode: z.boolean().optional(),
}).strict();

const runBody = z.object({ scenario: z.enum(['BASELINE_FULL_CYCLE','LOW_LIQUIDITY','WHALE_ENTRY','WHALE_EXIT','MASS_SELL','BUYBACK_NO_LIQUIDITY','SELF_TRADE_ATTEMPT']), options: optionsSchema.optional() });

function sendError(reply: any, err: unknown) {
  if (err instanceof ZodError) return reply.status(400).send({ message: err.issues[0]?.message ?? 'Dados inválidos.' });
  const statusCode = (err as Error & { statusCode?: number }).statusCode;
  if (typeof statusCode === 'number') return reply.status(statusCode).send({ message: (err as Error).message });
  return reply.status(500).send({ message: 'Erro interno ao processar simulação.' });
}

export async function testModeEconomicCycleRoutes(app: FastifyInstance) {
  app.post('/admin/test-mode/economic-cycle/run', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const body = runBody.parse(request.body ?? {});
      const user = request.user as { sub: string; roles?: string[] };
      const result = await runFullEconomicCycleSimulation({ actorUserId: user.sub, actorRoles: user.roles ?? [], scenario: body.scenario, options: body.options });
      return reply.status(201).send(result);
    } catch (err) { return sendError(reply, err); }
  });

  app.get('/admin/test-mode/economic-cycle/runs', { preHandler: [app.authenticate] }, async (request, reply) => {
    try { const user = request.user as { roles?: string[] }; return { runs: await listSimulationRuns(user.roles ?? []) }; }
    catch (err) { return sendError(reply, err); }
  });

  app.get('/admin/test-mode/economic-cycle/runs/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const user = request.user as { roles?: string[] }; const params = z.object({ id: z.string().min(1) }).parse(request.params ?? {});
      const run = await getSimulationRun(user.roles ?? [], params.id); if (!run) return reply.status(404).send({ message: 'Run não encontrado.' });
      return run;
    } catch (err) { return sendError(reply, err); }
  });
}
