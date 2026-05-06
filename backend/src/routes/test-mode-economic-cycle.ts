import { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { getSimulationRun, listSimulationRuns, runFullEconomicCycleSimulation } from '../services/test-mode-economic-cycle-service.js';

const runBody = z.object({ scenario: z.enum(['BASELINE_FULL_CYCLE','LOW_LIQUIDITY','WHALE_ENTRY','WHALE_EXIT','MASS_SELL','BUYBACK_NO_LIQUIDITY','SELF_TRADE_ATTEMPT']), options: z.record(z.union([z.number(), z.boolean()])).optional() });

const badRequest = (reply: any, err: unknown) => reply.status(400).send({ message: err instanceof ZodError ? (err.issues[0]?.message ?? 'Dados inválidos.') : (err as Error).message });
const statusOf = (err: unknown) => (err as Error & { statusCode?: number }).statusCode ?? 500;

export async function testModeEconomicCycleRoutes(app: FastifyInstance) {
  app.post('/admin/test-mode/economic-cycle/run', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const body = runBody.parse(request.body ?? {});
      const user = request.user as { sub: string; roles?: string[] };
      const result = await runFullEconomicCycleSimulation({ actorUserId: user.sub, actorRoles: user.roles ?? [], scenario: body.scenario, options: body.options });
      return reply.status(201).send(result);
    } catch (err) { const st = statusOf(err); if (st === 500) return badRequest(reply, err); return reply.status(st).send({ message: (err as Error).message }); }
  });

  app.get('/admin/test-mode/economic-cycle/runs', { preHandler: [app.authenticate] }, async (request, reply) => {
    try { const user = request.user as { roles?: string[] }; return { runs: await listSimulationRuns(user.roles ?? []) }; }
    catch (err) { return reply.status(statusOf(err)).send({ message: (err as Error).message }); }
  });

  app.get('/admin/test-mode/economic-cycle/runs/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const user = request.user as { roles?: string[] }; const params = z.object({ id: z.string().min(1) }).parse(request.params ?? {});
      const run = await getSimulationRun(user.roles ?? [], params.id); if (!run) return reply.status(404).send({ message: 'Run não encontrado.' });
      return run;
    } catch (err) { const st = err instanceof ZodError ? 400 : statusOf(err); return reply.status(st).send({ message: (err as Error).message }); }
  });
}
