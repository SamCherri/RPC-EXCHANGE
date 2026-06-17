import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

type Severity = 'CRITICAL' | 'WARNING';
type Status = 'OK' | 'WARNING' | 'CRITICAL';

type MarketHealthIssue = {
  severity: Severity;
  code: string;
  title: string;
  description: string;
  entity?: string;
  entityId?: string;
  userId?: string;
  expected?: string;
  actual?: string;
  metadata?: Record<string, unknown>;
};

type MarketHealthSection = { status: Status; issues: MarketHealthIssue[]; metrics: Record<string, unknown> };
type RpcLimitOrderRecord = Prisma.RpcLimitOrderGetPayload<Record<string, never>>;

const TRADE_LIMIT = 1000;

const toNum = (v: unknown) => Number(v ?? 0);
const sectionStatus = (issues: MarketHealthIssue[]): Status => issues.some((i) => i.severity === 'CRITICAL') ? 'CRITICAL' : issues.length > 0 ? 'WARNING' : 'OK';

export async function getMarketHealthReport() {
  const [wallets, rpcOrders, rpcTrades, rpcMarket, platformAccounts, holdings, marketOrders, companyTrades] = await Promise.all([
    prisma.wallet.findMany(),
    prisma.rpcLimitOrder.findMany({ where: { status: { in: ['OPEN'] } } }) as Promise<RpcLimitOrderRecord[]>,
    prisma.rpcExchangeTrade.findMany({ take: TRADE_LIMIT, orderBy: { createdAt: 'desc' } }),
    prisma.rpcMarketState.findFirst(),
    prisma.platformAccount.findMany(),
    prisma.companyHolding.findMany(),
    prisma.marketOrder.findMany({ where: { status: { in: ['OPEN', 'PARTIALLY_FILLED'] } } }),
    prisma.trade.findMany({ take: TRADE_LIMIT, orderBy: { createdAt: 'desc' } }),
  ]);

  const rpcIssues: MarketHealthIssue[] = [];
  for (const w of wallets) if ([w.fiatAvailableBalance, w.fiatLockedBalance, w.rpcAvailableBalance, w.rpcLockedBalance].some((f) => toNum(f) < 0)) rpcIssues.push({ severity: 'CRITICAL', code: 'RPC_WALLET_NEGATIVE', title: 'Carteira RPC com saldo negativo', description: 'Um ou mais campos da wallet RPC estão negativos.', entity: 'Wallet', entityId: w.id, userId: w.userId });
  const buyUsers = new Set(rpcOrders.filter((o) => o.side === 'BUY_RPC').map((o) => o.userId));
  const sellUsers = new Set(rpcOrders.filter((o) => o.side === 'SELL_RPC').map((o) => o.userId));
  for (const w of wallets) {
    if (toNum(w.fiatLockedBalance) > 0 && !buyUsers.has(w.userId)) rpcIssues.push({ severity: 'CRITICAL', code: 'RPC_LOCKED_WITHOUT_OPEN_ORDER', title: 'Saldo travado sem ordem RPC', description: 'fiatLockedBalance sem ordem BUY aberta.', entity: 'Wallet', entityId: w.id, userId: w.userId });
    if (toNum(w.rpcLockedBalance) > 0 && !sellUsers.has(w.userId)) rpcIssues.push({ severity: 'CRITICAL', code: 'RPC_LOCKED_WITHOUT_OPEN_ORDER', title: 'Saldo travado sem ordem RPC', description: 'rpcLockedBalance sem ordem SELL aberta.', entity: 'Wallet', entityId: w.id, userId: w.userId });
  }
  for (const o of rpcOrders) {
    if (o.side === 'BUY_RPC' && toNum(o.lockedFiatAmount) <= 0) rpcIssues.push({ severity: 'CRITICAL', code: 'RPC_OPEN_ORDER_WITHOUT_LOCK', title: 'Ordem RPC aberta sem lock', description: 'BUY aberta sem lockedFiatAmount.', entity: 'RpcLimitOrder', entityId: o.id, userId: o.userId });
    if (o.side === 'SELL_RPC' && toNum(o.lockedRpcAmount) <= 0) rpcIssues.push({ severity: 'CRITICAL', code: 'RPC_OPEN_ORDER_WITHOUT_LOCK', title: 'Ordem RPC aberta sem lock', description: 'SELL aberta sem lockedRpcAmount.', entity: 'RpcLimitOrder', entityId: o.id, userId: o.userId });
  }
  for (const t of rpcTrades) {
    const expected = toNum(t.rpcAmount) > 0 ? toNum(t.fiatAmount) / toNum(t.rpcAmount) : 0;
    if (expected > 0 && Math.abs(toNum(t.unitPrice) - expected) > 0.000001) rpcIssues.push({ severity: 'WARNING', code: 'RPC_TRADE_UNIT_PRICE_INCONSISTENT', title: 'Trade RPC com unitPrice inconsistente', description: 'unitPrice divergente de fiatAmount/rpcAmount.', entity: 'RpcExchangeTrade', entityId: t.id, userId: t.userId });
  }
  for (const p of platformAccounts) if (toNum(p.balance) < 0) rpcIssues.push({ severity: 'CRITICAL', code: 'RPC_PLATFORM_ACCOUNT_NEGATIVE', title: 'PlatformAccount negativa', description: 'Conta da plataforma com saldo negativo.', entity: 'PlatformAccount', entityId: p.id });

  const companyIssues: MarketHealthIssue[] = [];
  for (const h of holdings) if (h.shares < 0) companyIssues.push({ severity: 'CRITICAL', code: 'COMPANY_HOLDING_NEGATIVE', title: 'Holding negativa', description: 'Holding com quantidade de ações negativa.', entity: 'CompanyHolding', entityId: h.id, userId: h.userId });
  for (const o of marketOrders) {
    if (o.remainingQuantity < 0 || o.remainingQuantity > o.quantity) companyIssues.push({ severity: 'CRITICAL', code: 'COMPANY_ORDER_REMAINING_INVALID', title: 'remainingQuantity inválido', description: 'remainingQuantity inválido na ordem.', entity: 'MarketOrder', entityId: o.id, userId: o.userId });
    if (o.type === 'BUY' && toNum(o.lockedCash) <= 0) companyIssues.push({ severity: 'CRITICAL', code: 'COMPANY_OPEN_ORDER_WITHOUT_LOCK', title: 'Ordem buy sem lock', description: 'Ordem aberta buy sem lockedCash.', entity: 'MarketOrder', entityId: o.id, userId: o.userId });
    if (o.type === 'SELL' && o.lockedShares <= 0) companyIssues.push({ severity: 'CRITICAL', code: 'COMPANY_OPEN_ORDER_WITHOUT_LOCK', title: 'Ordem sell sem lock', description: 'Ordem aberta sell sem lockedShares.', entity: 'MarketOrder', entityId: o.id, userId: o.userId });
  }
  for (const t of companyTrades) {
    if (t.buyerId === t.sellerId) companyIssues.push({ severity: 'CRITICAL', code: 'COMPANY_SELF_TRADE', title: 'Self-trade detectado', description: 'Trade com comprador e vendedor iguais.', entity: 'Trade', entityId: t.id, userId: t.buyerId });
    const expected = t.quantity > 0 ? toNum(t.grossAmount) / t.quantity : 0;
    if (expected > 0 && Math.abs(toNum(t.unitPrice) - expected) > 0.000001) companyIssues.push({ severity: 'WARNING', code: 'COMPANY_TRADE_UNIT_PRICE_INCONSISTENT', title: 'Unit price inconsistente em trade de empresa', description: 'unitPrice divergente de total/quantidade.', entity: 'Trade', entityId: t.id });
  }

  const sections = {
    rpcMarket: { status: sectionStatus(rpcIssues), issues: rpcIssues, metrics: { analyzedTrades: rpcTrades.length, analysisLimit: TRADE_LIMIT, hasRpcMarketState: Boolean(rpcMarket) } },
    companyMarket: { status: sectionStatus(companyIssues), issues: companyIssues, metrics: { analyzedTrades: companyTrades.length, analysisLimit: TRADE_LIMIT, unsupportedChecks: ['COMPANY_TRADE_PRICE_OUTSIDE_LIMIT'] } },
  } satisfies Record<string, MarketHealthSection>;
  const all = [...rpcIssues, ...companyIssues];
  const criticalIssues = all.filter((i) => i.severity === 'CRITICAL').length;
  return { status: criticalIssues > 0 ? 'CRITICAL' as Status : all.length ? 'WARNING' as Status : 'OK' as Status, generatedAt: new Date().toISOString(), summary: { totalIssues: all.length, criticalIssues, warningIssues: all.length - criticalIssues }, sections };
}
