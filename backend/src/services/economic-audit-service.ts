import { prisma } from '../lib/prisma.js';
import { auditRpcSupplyConsistency } from './rpc-supply-policy-service.js';

export type EconomicAuditSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'WARNING';
export type EconomicAuditIssue = {
  code: string;
  severity: EconomicAuditSeverity;
  category: string;
  entity: string;
  entityId: string;
  companyId?: string;
  userId?: string;
  message: string;
  recommendedAction: string;
  metadata?: Record<string, unknown>;
};

const READ_ROLES = ['SUPER_ADMIN', 'COIN_CHIEF_ADMIN', 'AUDITOR', 'ADMIN'];
const SENSITIVE_ACTION_KEYWORDS = ['ISSUANCE', 'TREASURY', 'BROKER', 'ADJUST', 'WITHDRAW', 'APPROVE', 'SUSPEND', 'REACTIVATE', 'CLOSE', 'CAPITAL', 'BUYBACK', 'RESERVE', 'DISTRIBUT'];
const toNum = (v: unknown) => Number(v ?? 0);

export function assertEconomicAuditReadAccess(actorRoles: string[]) {
  if (!actorRoles.some((r) => READ_ROLES.includes(r))) {
    const err = new Error('Sem permissão para consultar auditoria econômica.');
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }
}

export async function runEconomicAudit(input: { actorRoles: string[]; filters?: { severity?: EconomicAuditSeverity; category?: string; companyId?: string; entity?: string; limit?: number; includeWarnings?: boolean } }) {
  assertEconomicAuditReadAccess(input.actorRoles);
  const filters = input.filters ?? {};
  const issues: EconomicAuditIssue[] = [];

  const [wallets, treasury, brokers, platforms, revenues, boostAccounts, holdings, orders, trades, companies, companyOperations, feeDistributions, buybacks, buybackExecutions, reserve, reserveEntries, distributions, snapshots, payments, capitalFlowEntries, adminLogs] = await Promise.all([
    prisma.wallet.findMany(),
    prisma.treasuryAccount.findMany(),
    prisma.brokerAccount.findMany(),
    prisma.platformAccount.findMany(),
    prisma.companyRevenueAccount.findMany(),
    prisma.companyBoostAccount.findMany(),
    prisma.companyHolding.findMany(),
    prisma.marketOrder.findMany(),
    prisma.trade.findMany({ include: { buyOrder: true, sellOrder: true } }),
    prisma.company.findMany(),
    prisma.companyOperation.findMany(),
    prisma.feeDistribution.findMany(),
    prisma.projectBuybackProgram.findMany({ include: { company: true } }),
    prisma.projectBuybackExecution.findMany(),
    prisma.projectTokenReserve.findMany(),
    prisma.projectTokenReserveEntry.findMany(),
    prisma.projectHolderDistributionProgram.findMany(),
    prisma.projectHolderDistributionSnapshot.findMany(),
    prisma.projectHolderDistributionPayment.findMany(),
    prisma.companyCapitalFlowEntry.findMany(),
    prisma.adminLog.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
  ]);

  for (const w of wallets) {
    if (toNum(w.rpcAvailableBalance) < 0) issues.push({ code: 'NEGATIVE_WALLET_RPC_AVAILABLE', severity: 'CRITICAL', category: 'NEGATIVE_BALANCE', entity: 'Wallet', entityId: w.id, userId: w.userId, message: 'rpcAvailableBalance negativo.', recommendedAction: 'Reconciliar saldo RPC da carteira.' });
    if (toNum(w.rpcLockedBalance) < 0) issues.push({ code: 'NEGATIVE_WALLET_RPC_LOCKED', severity: 'CRITICAL', category: 'NEGATIVE_BALANCE', entity: 'Wallet', entityId: w.id, userId: w.userId, message: 'rpcLockedBalance negativo.', recommendedAction: 'Reconciliar locks RPC da carteira.' });
    if (toNum(w.fiatAvailableBalance) < 0) issues.push({ code: 'NEGATIVE_WALLET_FIAT_AVAILABLE', severity: 'HIGH', category: 'NEGATIVE_BALANCE', entity: 'Wallet', entityId: w.id, userId: w.userId, message: 'fiatAvailableBalance negativo.', recommendedAction: 'Reconciliar saldo R$ fictício.' });
  }
  for (const t of treasury) if (toNum(t.balance) < 0) issues.push({ code: 'NEGATIVE_TREASURY_BALANCE', severity: 'CRITICAL', category: 'NEGATIVE_BALANCE', entity: 'TreasuryAccount', entityId: t.id, message: 'Saldo da tesouraria negativo.', recommendedAction: 'Auditar movimentações da tesouraria.' });
  for (const b of brokers) if (toNum(b.available) < 0) issues.push({ code: 'NEGATIVE_BROKER_AVAILABLE', severity: 'CRITICAL', category: 'NEGATIVE_BALANCE', entity: 'BrokerAccount', entityId: b.id, userId: b.userId, message: 'Saldo de corretor negativo.', recommendedAction: 'Auditar transferências para corretor.' });
  for (const p of platforms) if (toNum(p.balance) < 0) issues.push({ code: 'NEGATIVE_PLATFORM_BALANCE', severity: 'CRITICAL', category: 'NEGATIVE_BALANCE', entity: 'PlatformAccount', entityId: p.id, message: 'Saldo da plataforma negativo.', recommendedAction: 'Auditar distribuição de taxas e retiradas.' });
  for (const r of revenues) if (toNum(r.balance) < 0) issues.push({ code: 'NEGATIVE_COMPANY_REVENUE_BALANCE', severity: 'CRITICAL', category: 'NEGATIVE_BALANCE', entity: 'CompanyRevenueAccount', entityId: r.id, companyId: r.companyId, message: 'Saldo institucional negativo.', recommendedAction: 'Auditar fluxo de capital institucional.' });
  for (const b of boostAccounts) if (toNum(b.rpcBalance) < 0) issues.push({ code: 'NEGATIVE_BOOST_BALANCE', severity: 'HIGH', category: 'NEGATIVE_BALANCE', entity: 'CompanyBoostAccount', entityId: b.id, companyId: b.companyId, message: 'rpcBalance de boost negativo.', recommendedAction: 'Auditar histórico de boost legado.' });
  for (const h of holdings) if (h.shares < 0) issues.push({ code: 'NEGATIVE_HOLDING_SHARES', severity: 'CRITICAL', category: 'NEGATIVE_BALANCE', entity: 'CompanyHolding', entityId: h.id, companyId: h.companyId, userId: h.userId, message: 'Holding com shares negativos.', recommendedAction: 'Auditar trades e cancelamentos relacionados.' });



  const secondaryTradesByCompany = new Map<string, typeof trades>();
  for (const trade of trades) {
    const list = secondaryTradesByCompany.get(trade.companyId) ?? [];
    list.push(trade);
    secondaryTradesByCompany.set(trade.companyId, list);
  }

  const initialOfferOpsByCompany = new Map<string, typeof companyOperations>();
  for (const op of companyOperations.filter((o) => o.type === 'INITIAL_OFFER_BUY')) {
    const list = initialOfferOpsByCompany.get(op.companyId) ?? [];
    list.push(op);
    initialOfferOpsByCompany.set(op.companyId, list);
  }

  for (const company of companies) {
    const expectedMarketCap = toNum(company.currentPrice) * company.totalShares;
    if (company.status === 'ACTIVE' && toNum(company.currentPrice) <= 0) {
      issues.push({ code: 'ACTIVE_COMPANY_NON_POSITIVE_PRICE', severity: 'CRITICAL', category: 'PRICE_INTEGRITY', entity: 'Company', entityId: company.id, companyId: company.id, message: 'Company ACTIVE com currentPrice <= 0.', recommendedAction: 'Auditar formação de preço do ativo.' });
    }
    if (Math.abs(toNum(company.fictitiousMarketCap) - expectedMarketCap) > 0.01) {
      issues.push({ code: 'COMPANY_MARKET_CAP_MISMATCH', severity: 'HIGH', category: 'PRICE_INTEGRITY', entity: 'Company', entityId: company.id, companyId: company.id, message: 'fictitiousMarketCap incompatível com currentPrice * totalShares.', recommendedAction: 'Recalcular market cap com base no preço atual.' });
    }

    const companyTrades = (secondaryTradesByCompany.get(company.id) ?? []).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const initialOps = (initialOfferOpsByCompany.get(company.id) ?? []).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (companyTrades.length === 0 && initialOps.length === 0 && Math.abs(toNum(company.currentPrice) - toNum(company.initialPrice)) > 0.000001) {
      issues.push({ code: 'PRICE_CHANGED_WITHOUT_ECONOMIC_EVENT', severity: 'CRITICAL', category: 'PRICE_INTEGRITY', entity: 'Company', entityId: company.id, companyId: company.id, message: 'currentPrice diferente de initialPrice sem Trade e sem compra inicial.', recommendedAction: 'Auditar alterações administrativas indevidas de preço.' });
    }

    const lastTradeAt = companyTrades[0]?.createdAt?.getTime() ?? -1;
    const lastInitialOfferAt = initialOps[0]?.createdAt?.getTime() ?? -1;

    if (companyTrades.length > 0 && lastTradeAt >= lastInitialOfferAt) {
      const lastTradePrice = toNum(companyTrades[0].unitPrice);
      if (Math.abs(lastTradePrice - toNum(company.currentPrice)) > 0.000001) {
        issues.push({ code: 'CURRENT_PRICE_DIVERGES_LAST_TRADE', severity: 'HIGH', category: 'PRICE_INTEGRITY', entity: 'Company', entityId: company.id, companyId: company.id, message: 'currentPrice divergente do último Trade do secundário.', recommendedAction: 'Auditar sincronização do preço com trades executados.' });
      }
    }
  }


  for (const o of orders) {
    if (['OPEN', 'PARTIALLY_FILLED'].includes(o.status) && o.type === 'BUY' && toNum(o.lockedCash) <= 0) issues.push({ code: 'OPEN_BUY_WITHOUT_LOCKED_CASH', severity: 'CRITICAL', category: 'ORDER_LOCK', entity: 'MarketOrder', entityId: o.id, companyId: o.companyId, userId: o.userId, message: 'Ordem BUY aberta/parcial sem lockedCash válido.', recommendedAction: 'Auditar lock RPC e matching.' });
    if (['OPEN', 'PARTIALLY_FILLED'].includes(o.status) && o.type === 'SELL' && o.lockedShares <= 0) issues.push({ code: 'OPEN_SELL_WITHOUT_LOCKED_SHARES', severity: 'CRITICAL', category: 'ORDER_LOCK', entity: 'MarketOrder', entityId: o.id, companyId: o.companyId, userId: o.userId, message: 'Ordem SELL aberta/parcial sem lockedShares válido.', recommendedAction: 'Auditar lock de shares.' });
    if (['OPEN', 'PARTIALLY_FILLED'].includes(o.status) && o.remainingQuantity <= 0) issues.push({ code: 'OPEN_ORDER_INVALID_REMAINING', severity: 'HIGH', category: 'ORDER_LOCK', entity: 'MarketOrder', entityId: o.id, companyId: o.companyId, userId: o.userId, message: 'Ordem aberta/parcial com remainingQuantity <= 0.', recommendedAction: 'Auditar estado da ordem.' });
    if (o.status === 'FILLED' && o.remainingQuantity > 0) issues.push({ code: 'FILLED_ORDER_WITH_REMAINING', severity: 'HIGH', category: 'ORDER_LOCK', entity: 'MarketOrder', entityId: o.id, companyId: o.companyId, userId: o.userId, message: 'Ordem FILLED com remainingQuantity > 0.', recommendedAction: 'Auditar fechamento da ordem.' });
    if (o.remainingQuantity < 0) issues.push({ code: 'ORDER_NEGATIVE_REMAINING', severity: 'CRITICAL', category: 'ORDER_LOCK', entity: 'MarketOrder', entityId: o.id, companyId: o.companyId, userId: o.userId, message: 'Ordem com remainingQuantity negativo.', recommendedAction: 'Reconciliar book e matching.' });
    if (toNum(o.lockedCash) < 0) issues.push({ code: 'ORDER_NEGATIVE_LOCKED_CASH', severity: 'CRITICAL', category: 'ORDER_LOCK', entity: 'MarketOrder', entityId: o.id, companyId: o.companyId, userId: o.userId, message: 'Ordem com lockedCash negativo.', recommendedAction: 'Auditar rotina de lock/unlock RPC.' });
    if (o.lockedShares < 0) issues.push({ code: 'ORDER_NEGATIVE_LOCKED_SHARES', severity: 'CRITICAL', category: 'ORDER_LOCK', entity: 'MarketOrder', entityId: o.id, companyId: o.companyId, userId: o.userId, message: 'Ordem com lockedShares negativo.', recommendedAction: 'Auditar rotina de lock/unlock shares.' });
    if (o.status === 'CANCELED' && (toNum(o.lockedCash) > 0 || o.lockedShares > 0)) issues.push({ code: 'CANCELED_ORDER_WITH_LOCKED_BALANCE', severity: 'HIGH', category: 'ORDER_LOCK', entity: 'MarketOrder', entityId: o.id, companyId: o.companyId, userId: o.userId, message: 'Ordem cancelada ainda possui saldo travado.', recommendedAction: 'Auditar rotina de cancelamento.' });
  }

  for (const t of trades) {
    if (t.buyerId === t.sellerId) issues.push({ code: 'SELF_TRADE_BUYER_EQUALS_SELLER', severity: 'CRITICAL', category: 'SELF_TRADE', entity: 'Trade', entityId: t.id, companyId: t.companyId, userId: t.buyerId, message: 'Trade com buyerId igual sellerId.', recommendedAction: 'Investigar manipulação e bloquear origem.' });
    if (t.buyOrder?.userId && t.sellOrder?.userId && t.buyOrder.userId === t.sellOrder.userId) issues.push({ code: 'SELF_TRADE_ORDER_OWNERSHIP', severity: 'HIGH', category: 'SELF_TRADE', entity: 'Trade', entityId: t.id, companyId: t.companyId, userId: t.buyOrder.userId, message: 'Trade com ordens do mesmo usuário.', recommendedAction: 'Auditar matching e regras anti-self-trade.' });
  }

  const now = new Date();
  for (const b of buybacks) {
    if (b.status === 'ACTIVE' && b.expiresAt && b.expiresAt < now) issues.push({ code: 'BUYBACK_PROGRAM_EXPIRED_ACTIVE', severity: 'HIGH', category: 'BUYBACK', entity: 'ProjectBuybackProgram', entityId: b.id, companyId: b.companyId, message: 'Programa de recompra ativo e vencido.', recommendedAction: 'Revisar governança do programa.' });
    if (toNum(b.spentRpc) > toNum(b.budgetRpc)) issues.push({ code: 'BUYBACK_SPENT_EXCEEDS_BUDGET', severity: 'CRITICAL', category: 'BUYBACK', entity: 'ProjectBuybackProgram', entityId: b.id, companyId: b.companyId, message: 'spentRpc acima do budgetRpc.', recommendedAction: 'Auditar execuções e orçamento.' });
    if (Math.abs((toNum(b.remainingRpc) + toNum(b.spentRpc)) - toNum(b.budgetRpc)) > 0.01) issues.push({ code: 'BUYBACK_BUDGET_MISMATCH', severity: 'HIGH', category: 'BUYBACK', entity: 'ProjectBuybackProgram', entityId: b.id, companyId: b.companyId, message: 'remainingRpc + spentRpc diverge do budgetRpc.', recommendedAction: 'Reconciliar orçamento da recompra.' });
    if (b.status === 'COMPLETED' && toNum(b.remainingRpc) > 0) issues.push({ code: 'BUYBACK_COMPLETED_WITH_REMAINING', severity: 'HIGH', category: 'BUYBACK', entity: 'ProjectBuybackProgram', entityId: b.id, companyId: b.companyId, message: 'Programa COMPLETED com remainingRpc > 0.', recommendedAction: 'Revisar encerramento de recompra.' });
    if (b.status === 'CANCELED' && toNum(b.remainingRpc) > 0) issues.push({ code: 'BUYBACK_CANCELED_WITH_REMAINING', severity: 'MEDIUM', category: 'BUYBACK', entity: 'ProjectBuybackProgram', entityId: b.id, companyId: b.companyId, message: 'Programa CANCELED com remainingRpc > 0.', recommendedAction: 'Validar política de devolução no cancelamento.' });
  }

  const reserveEntryExecutionIds = new Set(reserveEntries.map((entry) => entry.executionId));
  for (const execution of buybackExecutions) {
    if (!reserveEntryExecutionIds.has(execution.id)) {
      issues.push({ code: 'BUYBACK_EXECUTION_WITHOUT_RESERVE_ENTRY', severity: 'CRITICAL', category: 'BUYBACK', entity: 'ProjectBuybackExecution', entityId: execution.id, companyId: execution.companyId, userId: execution.sellerUserId, message: 'Execução de recompra sem entrada na reserva.', recommendedAction: 'Auditar vínculo execução-reserva.' });
    }
  }

  const reserveEntriesByCompany = new Map<string, number>();
  for (const e of reserveEntries) reserveEntriesByCompany.set(e.companyId, (reserveEntriesByCompany.get(e.companyId) ?? 0) + e.shares);
  for (const r of reserve) {
    if (r.locked === false) issues.push({ code: 'TOKEN_RESERVE_UNLOCKED', severity: 'HIGH', category: 'TOKEN_RESERVE', entity: 'ProjectTokenReserve', entityId: r.id, companyId: r.companyId, message: 'Reserva desbloqueada fora da política atual.', recommendedAction: 'Validar política HOLD_LOCKED.' });
    if (r.policy !== 'HOLD_LOCKED') issues.push({ code: 'TOKEN_RESERVE_POLICY_UNEXPECTED', severity: 'MEDIUM', category: 'TOKEN_RESERVE', entity: 'ProjectTokenReserve', entityId: r.id, companyId: r.companyId, message: 'Política da reserva diferente de HOLD_LOCKED.', recommendedAction: 'Revisar governança da reserva.' });
    if (r.shares !== (reserveEntriesByCompany.get(r.companyId) ?? 0)) issues.push({ code: 'TOKEN_RESERVE_SHARES_MISMATCH', severity: 'CRITICAL', category: 'TOKEN_RESERVE', entity: 'ProjectTokenReserve', entityId: r.id, companyId: r.companyId, message: 'Shares da reserva diverge da soma das entradas.', recommendedAction: 'Reconciliar entradas da reserva.' });
  }

  for (const p of distributions) {
    if (toNum(p.distributedRpc) > toNum(p.budgetRpc)) issues.push({ code: 'HOLDER_DISTRIBUTION_EXCEEDS_BUDGET', severity: 'CRITICAL', category: 'HOLDER_DISTRIBUTION', entity: 'ProjectHolderDistributionProgram', entityId: p.id, companyId: p.companyId, message: 'distributedRpc maior que budgetRpc.', recommendedAction: 'Auditar pagamentos e budget do programa.' });
    if (p.status === 'COMPLETED' && snapshots.some((s) => s.programId === p.id && s.status === 'PENDING')) issues.push({ code: 'HOLDER_DISTRIBUTION_COMPLETED_WITH_PENDING', severity: 'HIGH', category: 'HOLDER_DISTRIBUTION', entity: 'ProjectHolderDistributionProgram', entityId: p.id, companyId: p.companyId, message: 'Programa COMPLETED com snapshots PENDING.', recommendedAction: 'Auditar execução final da distribuição.' });
  }
  for (const s of snapshots) if (toNum(s.calculatedAmountRpc) < 0) issues.push({ code: 'NEGATIVE_DISTRIBUTION_SNAPSHOT_AMOUNT', severity: 'HIGH', category: 'HOLDER_DISTRIBUTION', entity: 'ProjectHolderDistributionSnapshot', entityId: s.id, companyId: s.companyId, userId: s.userId, message: 'Snapshot com valor calculado negativo.', recommendedAction: 'Recalcular snapshot e critérios.' });
  const paymentBySnapshotCount = new Map<string, number>();
  for (const pay of payments) {
    paymentBySnapshotCount.set(pay.snapshotId, (paymentBySnapshotCount.get(pay.snapshotId) ?? 0) + 1);
    const tx = await prisma.transaction.findUnique({ where: { id: pay.transactionId } });
    if (!tx) issues.push({ code: 'HOLDER_PAYMENT_WITHOUT_TRANSACTION', severity: 'CRITICAL', category: 'HOLDER_DISTRIBUTION', entity: 'ProjectHolderDistributionPayment', entityId: pay.id, companyId: pay.companyId, userId: pay.userId, message: 'Pagamento de holder sem Transaction correspondente.', recommendedAction: 'Auditar integridade entre pagamento e extrato.' });
  }
  for (const [snapshotId, count] of paymentBySnapshotCount.entries()) {
    if (count > 1) issues.push({ code: 'HOLDER_DUPLICATE_PAYMENT', severity: 'CRITICAL', category: 'HOLDER_DISTRIBUTION', entity: 'ProjectHolderDistributionSnapshot', entityId: snapshotId, message: 'Snapshot com pagamento duplicado.', recommendedAction: 'Auditar idempotência da distribuição.' });
  }
  for (const program of distributions.filter((p) => p.excludeFounder)) {
    const company = companies.find((c) => c.id === program.companyId);
    if (!company) continue;
    const founderPaid = payments.some((pay) => pay.programId === program.id && pay.userId === company.founderUserId);
    if (founderPaid) issues.push({ code: 'FOUNDER_PAID_WHEN_EXCLUDED', severity: 'CRITICAL', category: 'HOLDER_DISTRIBUTION', entity: 'ProjectHolderDistributionProgram', entityId: program.id, companyId: program.companyId, userId: company.founderUserId, message: 'Founder recebeu distribuição com excludeFounder=true.', recommendedAction: 'Auditar snapshot e regras de elegibilidade.' });
  }

  
  const feeByCompany = new Map<string, number>();
  for (const fee of feeDistributions) feeByCompany.set(fee.companyId, (feeByCompany.get(fee.companyId) ?? 0) + toNum(fee.companyAmount));
  const capitalByCompany = new Map<string, number>();
  for (const entry of capitalFlowEntries) capitalByCompany.set(entry.companyId, (capitalByCompany.get(entry.companyId) ?? 0) + toNum(entry.amountRpc));

  for (const rev of revenues) {
    const feeTotal = feeByCompany.get(rev.companyId) ?? 0;
    const capitalTotal = capitalByCompany.get(rev.companyId) ?? 0;
    const tracedIncoming = feeTotal + capitalTotal;
    const knownOutflows = toNum(rev.totalWithdrawn) + toNum(rev.totalUsedForBoost);
    const expectedBalance = tracedIncoming - knownOutflows;

    if (toNum(rev.balance) > 0 && tracedIncoming <= 0) {
      issues.push({ code: 'INSTITUTIONAL_BALANCE_WITHOUT_TRACEABLE_SOURCE', severity: 'CRITICAL', category: 'TRACEABILITY', entity: 'CompanyRevenueAccount', entityId: rev.id, companyId: rev.companyId, message: 'Saldo institucional positivo sem origem rastreável conhecida.', recommendedAction: 'Auditar origem de créditos institucionais.' });
    }
    if (Math.abs(toNum(rev.totalReceivedFees) - feeTotal) > 0.01) {
      issues.push({ code: 'COMPANY_REVENUE_FEES_MISMATCH', severity: 'HIGH', category: 'TRACEABILITY', entity: 'CompanyRevenueAccount', entityId: rev.id, companyId: rev.companyId, message: 'totalReceivedFees divergente da soma de FeeDistribution.companyAmount.', recommendedAction: 'Reconciliar conta institucional com distribuição de taxas.' });
    }
    const hasReservedEconomicPrograms = buybacks.some((b) => b.companyId === rev.companyId && ['ACTIVE', 'COMPLETED', 'CANCELED'].includes(b.status))
      || distributions.some((d) => d.companyId === rev.companyId);
    if (!hasReservedEconomicPrograms && Math.abs(toNum(rev.balance) - expectedBalance) > 0.01) {
      issues.push({ code: 'COMPANY_REVENUE_BALANCE_MISMATCH', severity: 'WARNING', category: 'TRACEABILITY', entity: 'CompanyRevenueAccount', entityId: rev.id, companyId: rev.companyId, message: 'Saldo institucional divergente de entradas rastreáveis menos saídas conhecidas.', recommendedAction: 'Executar reconciliação contábil institucional.' });
    }
  }
for (const c of capitalFlowEntries) {
    if (toNum(c.amountRpc) <= 0) issues.push({ code: 'CAPITAL_FLOW_NON_POSITIVE_AMOUNT', severity: 'HIGH', category: 'TRACEABILITY', entity: 'CompanyCapitalFlowEntry', entityId: c.id, companyId: c.companyId, userId: c.actorUserId, message: 'Entry de capital com amountRpc <= 0.', recommendedAction: 'Corrigir fluxo institucional e exigir valores positivos.' });
    const invalidCombo = (c.type === 'OWNER_RPC_CONTRIBUTION' && c.source !== 'OWNER_WALLET') || (c.type === 'ADMIN_RPC_ADJUSTMENT' && c.source !== 'ADMIN_ADJUSTMENT') || (c.type === 'PROJECT_REVENUE_IN' && c.source === 'OWNER_WALLET') || (c.type === 'PROJECT_REVENUE_OUT' && c.source === 'MARKET_FEE');
    if (invalidCombo) issues.push({ code: 'CAPITAL_FLOW_SOURCE_TYPE_MISMATCH', severity: 'HIGH', category: 'TRACEABILITY', entity: 'CompanyCapitalFlowEntry', entityId: c.id, companyId: c.companyId, userId: c.actorUserId, message: 'CompanyCapitalFlowEntry com source/type incompatível.', recommendedAction: 'Corrigir classificação contábil do aporte institucional.' });
    if (!c.reason?.trim()) issues.push({ code: 'CAPITAL_FLOW_MISSING_REASON', severity: 'HIGH', category: 'TRACEABILITY', entity: 'CompanyCapitalFlowEntry', entityId: c.id, companyId: c.companyId, userId: c.actorUserId, message: 'Entry de capital sem reason.', recommendedAction: 'Exigir motivo obrigatório em aporte institucional.' });
  }

  for (const log of adminLogs) {
    const sensitive = SENSITIVE_ACTION_KEYWORDS.some((k) => log.action.toUpperCase().includes(k));
    if (sensitive && !log.reason?.trim()) issues.push({ code: 'SENSITIVE_ADMIN_LOG_WITHOUT_REASON', severity: 'HIGH', category: 'ADMIN_GOVERNANCE', entity: 'AdminLog', entityId: log.id, userId: log.userId ?? undefined, message: 'AdminLog sensível sem justificativa.', recommendedAction: 'Obrigar reason nas ações sensíveis.' });
  }

  const rpcAudit = await auditRpcSupplyConsistency();
  for (const i of rpcAudit.issues) {
    issues.push({ code: i.code, severity: i.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING', category: 'RPC_POLICY', entity: i.entity, entityId: i.entityId, message: i.message, recommendedAction: 'Validar política de supply RPC e metadados obrigatórios.' });
  }

  let filtered = issues;
  if (!filters.includeWarnings) filtered = filtered.filter((i) => i.severity !== 'WARNING');
  if (filters.severity) filtered = filtered.filter((i) => i.severity === filters.severity);
  if (filters.category) filtered = filtered.filter((i) => i.category === filters.category);
  if (filters.companyId) filtered = filtered.filter((i) => i.companyId === filters.companyId);
  if (filters.entity) filtered = filtered.filter((i) => i.entity === filters.entity);
  if (filters.limit && filters.limit > 0) filtered = filtered.slice(0, filters.limit);

  const byCategory: Record<string, number> = {};
  for (const i of filtered) byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
  return { generatedAt: new Date().toISOString(), summary: { total: filtered.length, critical: filtered.filter((i) => i.severity === 'CRITICAL').length, high: filtered.filter((i) => i.severity === 'HIGH').length, medium: filtered.filter((i) => i.severity === 'MEDIUM').length, warning: filtered.filter((i) => i.severity === 'WARNING').length, byCategory }, issues: filtered };
}

export async function getEconomicAuditSummary(actorRoles: string[]) {
  const report = await runEconomicAudit({ actorRoles, filters: { includeWarnings: true, limit: 50 } });
  return { generatedAt: report.generatedAt, summary: report.summary, latestIssues: report.issues.slice(0, 10) };
}
