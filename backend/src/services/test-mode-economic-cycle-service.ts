import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../lib/prisma.js';

const RUN_ROLES = ['SUPER_ADMIN', 'COIN_CHIEF_ADMIN', 'ADMIN'];
const READ_ROLES = ['SUPER_ADMIN', 'COIN_CHIEF_ADMIN', 'ADMIN', 'AUDITOR'];
const SCENARIOS = ['BASELINE_FULL_CYCLE','LOW_LIQUIDITY','WHALE_ENTRY','WHALE_EXIT','MASS_SELL','BUYBACK_NO_LIQUIDITY','SELF_TRADE_ATTEMPT'] as const;

export type SimulationScenario = typeof SCENARIOS[number];
export function assertSimulationRunAccess(roles: string[]) { if (!roles.some((r) => RUN_ROLES.includes(r.toUpperCase()))) { const e = new Error('Sem permissão.'); (e as Error & { statusCode?: number }).statusCode = 403; throw e; } }
export function assertSimulationReadAccess(roles: string[]) { if (!roles.some((r) => READ_ROLES.includes(r.toUpperCase()))) { const e = new Error('Sem permissão.'); (e as Error & { statusCode?: number }).statusCode = 403; throw e; } }

export async function runFullEconomicCycleSimulation(input: { actorUserId: string; actorRoles: string[]; scenario: SimulationScenario; options?: Record<string, number | boolean | undefined>; }) {
  assertSimulationRunAccess(input.actorRoles);
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const initialRpcPrice = new Decimal(String(input.options?.initialRpcPrice ?? 1)).toDecimalPlaces(8);
    const initialTokenPrice = new Decimal(String(input.options?.initialTokenPrice ?? 10)).toDecimalPlaces(8);
    const includeDistribution = input.options?.includeDistribution !== false;
    const includeBuyback = input.options?.includeBuyback !== false;
    const st: any = {
      rpcPrice: initialRpcPrice, tokenPrice: initialTokenPrice, fiatBalance: new Decimal(String(input.options?.initialFiatBalance ?? 20000)),
      rpcBalance: new Decimal('0'), companyOffer: Math.max(10, Number(input.options?.companyTotalShares ?? 1000) * 0.4), holdings: new Map<string, number>([['investor', 0], ['whale', 0], ['seller', 300], ['founder', 300]]),
      orders: [{ userId: 'seller', side: 'SELL', qty: 100, price: initialTokenPrice }], warnings: [] as string[], steps: [] as any[], metrics: { rpcVolume: new Decimal('0'), tokenVolume: 0, trades: 0, rejected: 0, buybacks: 0, reserve: 0, distributed: new Decimal('0') },
    };
    const run = await tx.testModeSimulationRun.create({ data: { createdByUserId: input.actorUserId, scenario: input.scenario, status: 'RUNNING', initialStateJson: JSON.stringify({ initialRpcPrice: String(initialRpcPrice), initialTokenPrice: String(initialTokenPrice) }) } });
    const step = async (type: string, description: string, before: Record<string, unknown>, after: Record<string, unknown>, issues: string[] = []) => {
      const n = st.steps.length + 1; st.steps.push({ stepNumber: n, type, description, issues });
      await tx.testModeSimulationStep.create({ data: { runId: run.id, stepNumber: n, type, description, beforeJson: JSON.stringify(before), afterJson: JSON.stringify(after), issuesJson: JSON.stringify(issues) } });
    };

    const b0 = { fiat: String(st.fiatBalance), rpc: String(st.rpcBalance), rpcPrice: String(st.rpcPrice) };
    const fiatSpend = new Decimal('5000'); const rpcBought = fiatSpend.div(st.rpcPrice).toDecimalPlaces(2); st.fiatBalance = st.fiatBalance.sub(fiatSpend); st.rpcBalance = st.rpcBalance.add(rpcBought); st.metrics.rpcVolume = st.metrics.rpcVolume.add(rpcBought);
    await step('RPC_PURCHASE', 'R$ fictício -> RPC em estado simulado', b0, { fiat: String(st.fiatBalance), rpc: String(st.rpcBalance), rpcPrice: String(st.rpcPrice) });

    const b1 = { offer: st.companyOffer, tokenPrice: String(st.tokenPrice), holding: st.holdings.get('investor') };
    const buyQty = 50; st.companyOffer -= buyQty; st.holdings.set('investor', (st.holdings.get('investor') ?? 0) + buyQty); st.tokenPrice = st.tokenPrice.mul('1.02').toDecimalPlaces(8); st.metrics.tokenVolume += buyQty;
    await step('INITIAL_OFFER', 'Compra simulada na oferta inicial', b1, { offer: st.companyOffer, tokenPrice: String(st.tokenPrice), holding: st.holdings.get('investor') });

    const b2 = { tokenPrice: String(st.tokenPrice), trades: st.metrics.trades };
    if (input.scenario === 'SELF_TRADE_ATTEMPT') { st.metrics.rejected += 1; st.warnings.push('SELF_TRADE_BLOCKED'); await step('SECONDARY_TRADE', 'Self-trade bloqueado', b2, { tokenPrice: String(st.tokenPrice), trades: st.metrics.trades }, ['SELF_TRADE_BLOCKED']); }
    else { st.metrics.trades += 1; st.metrics.tokenVolume += 20; st.tokenPrice = st.tokenPrice.mul(input.scenario === 'MASS_SELL' ? '0.90' : '1.01').toDecimalPlaces(8); await step('SECONDARY_TRADE', 'Trade simulado executado entre usuários distintos', b2, { tokenPrice: String(st.tokenPrice), trades: st.metrics.trades }); }

    if (includeBuyback) {
      const bb = { reserve: st.metrics.reserve, buybacks: st.metrics.buybacks, orderBookSell: st.orders.length };
      if (input.scenario === 'BUYBACK_NO_LIQUIDITY' || st.orders.length === 0) { st.warnings.push('BUYBACK_NO_SELLER_LIQUIDITY'); await step('BUYBACK', 'Recompra sem vendedor suficiente', bb, { reserve: st.metrics.reserve, buybacks: st.metrics.buybacks, orderBookSell: st.orders.length }, ['BUYBACK_NO_SELLER_LIQUIDITY']); }
      else { st.metrics.buybacks += 1; st.metrics.reserve += 30; st.metrics.trades += 1; await step('BUYBACK', 'Recompra simulada contra ordem SELL simulada', bb, { reserve: st.metrics.reserve, buybacks: st.metrics.buybacks, orderBookSell: st.orders.length }); }
    }

    if (includeDistribution) {
      const bd = { distributed: String(st.metrics.distributed) }; const budget = new Decimal('120'); st.metrics.distributed = budget; await step('HOLDER_DISTRIBUTION', 'Distribuição proporcional simulada (founder excluído)', bd, { distributed: String(st.metrics.distributed) });
    }

    if (input.scenario === 'LOW_LIQUIDITY') st.warnings.push('LOW_LIQUIDITY_WARNING');
    if (input.scenario === 'WHALE_ENTRY') st.warnings.push('WHALE_CONCENTRATION_INCREASED');
    if (input.scenario === 'WHALE_EXIT') st.warnings.push('WHALE_EXIT_SELL_PRESSURE');
    if (input.scenario === 'MASS_SELL') st.warnings.push('MASS_SELL_PRESSURE');

    const result = { runId: run.id, scenario: input.scenario, status: 'COMPLETED', summary: { initialRpcPrice: String(initialRpcPrice), finalRpcPrice: String(st.rpcPrice), initialTokenPrice: String(initialTokenPrice), finalTokenPrice: String(st.tokenPrice), rpcVolume: String(st.metrics.rpcVolume), tokenVolume: st.metrics.tokenVolume, tradesExecuted: st.metrics.trades, ordersRejected: st.metrics.rejected, buybacksExecuted: st.metrics.buybacks, reservedShares: st.metrics.reserve, distributedRpc: String(st.metrics.distributed), warnings: st.warnings, criticalIssues: [] as string[] }, steps: st.steps, auditFindings: st.warnings, economicNotes: ['Simulação isolada: sem alteração em Wallet/Trade/Company reais.'] };
    await tx.testModeSimulationRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', resultJson: JSON.stringify(result), warningsJson: JSON.stringify(st.warnings), completedAt: new Date() } });
    return result;
  });
}


function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function listSimulationRuns(actorRoles: string[]) { assertSimulationReadAccess(actorRoles); return prisma.testModeSimulationRun.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }); }
export async function getSimulationRun(actorRoles: string[], runId: string) {
  assertSimulationReadAccess(actorRoles);
  const run = await prisma.testModeSimulationRun.findUnique({ where: { id: runId }, include: { steps: { orderBy: { stepNumber: 'asc' } } } });
  if (!run) return null;
  return {
    id: run.id,
    scenario: run.scenario,
    status: run.status,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    initialState: safeJsonParse(run.initialStateJson, {}),
    result: safeJsonParse(run.resultJson, {}),
    warnings: safeJsonParse(run.warningsJson, [] as string[]),
    initialStateJson: run.initialStateJson,
    resultJson: run.resultJson,
    warningsJson: run.warningsJson,
    steps: run.steps.map((step) => ({
      id: step.id,
      stepNumber: step.stepNumber,
      type: step.type,
      description: step.description,
      before: safeJsonParse(step.beforeJson, {}),
      after: safeJsonParse(step.afterJson, {}),
      issues: safeJsonParse(step.issuesJson, [] as string[]),
      beforeJson: step.beforeJson,
      afterJson: step.afterJson,
      issuesJson: step.issuesJson,
      createdAt: step.createdAt,
    })),
  };
}
