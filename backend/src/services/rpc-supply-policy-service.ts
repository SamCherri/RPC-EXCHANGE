import { prisma } from '../lib/prisma.js';

const READ_ROLES = ['SUPER_ADMIN', 'COIN_CHIEF_ADMIN', 'AUDITOR', 'ADMIN'];

const toNum = (v: unknown) => Number(v ?? 0);

export function assertRpcPolicyReadAccess(actorRoles: string[]) {
  if (!actorRoles.some((r) => READ_ROLES.includes(r))) {
    const err = new Error('Sem permissão para consultar política da RPC.');
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }
}

export async function calculateRpcSupplySnapshot() {
  const [wallets, treasury, brokers, platformAccounts, revenueAccounts, buybackPrograms, withdrawals, issuances, transfers] = await Promise.all([
    prisma.wallet.findMany({ select: { id: true, userId: true, rpcAvailableBalance: true, rpcLockedBalance: true, pendingWithdrawalBalance: true } }),
    prisma.treasuryAccount.findMany({ select: { id: true, balance: true } }),
    prisma.brokerAccount.findMany({ select: { id: true, userId: true, available: true, receivedTotal: true } }),
    prisma.platformAccount.findMany({ select: { id: true, balance: true } }),
    prisma.companyRevenueAccount.findMany({ select: { id: true, companyId: true, balance: true } }),
    prisma.projectBuybackProgram.findMany({ where: { status: 'ACTIVE' }, select: { id: true, companyId: true, remainingRpc: true } }),
    prisma.withdrawalRequest.aggregate({ where: { status: 'COMPLETED' }, _sum: { amount: true } }),
    prisma.coinIssuance.aggregate({ _sum: { amount: true } }),
    prisma.coinTransfer.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);

  const availableRpc = wallets.reduce((acc, w) => acc + toNum(w.rpcAvailableBalance), 0);
  const lockedRpc = wallets.reduce((acc, w) => acc + toNum(w.rpcLockedBalance), 0);
  const pendingWithdrawalRpc = wallets.reduce((acc, w) => acc + toNum(w.pendingWithdrawalBalance), 0);
  const treasuryRpc = treasury.reduce((acc, t) => acc + toNum(t.balance), 0);
  const brokerRpc = brokers.reduce((acc, b) => acc + toNum(b.available), 0);
  const platformRpc = platformAccounts.reduce((acc, p) => acc + toNum(p.balance), 0);
  const companyRevenueRpc = revenueAccounts.reduce((acc, r) => acc + toNum(r.balance), 0);
  const buybackReservedRpc = buybackPrograms.reduce((acc, b) => acc + toNum(b.remainingRpc), 0);

  const userWalletRpc = availableRpc + lockedRpc + pendingWithdrawalRpc;
  const circulatingRpc = userWalletRpc + treasuryRpc + brokerRpc + platformRpc + companyRevenueRpc + buybackReservedRpc;

  return {
    availableRpc,
    lockedRpc,
    pendingWithdrawalRpc,
    userWalletRpc,
    treasuryRpc,
    brokerRpc,
    platformRpc,
    companyRevenueRpc,
    buybackReservedRpc,
    circulatingRpc,
    totalIssued: toNum(issuances._sum.amount),
    totalWithdrawn: toNum(withdrawals._sum.amount),
    totalBurned: 0,
    lastTransfers: transfers,
  };
}

export async function auditRpcSupplyConsistency() {
  const [wallets, treasury, brokers, platformAccounts, revenueAccounts, buybackPrograms, holderPrograms, badIssuances, badTransfers] = await Promise.all([
    prisma.wallet.findMany({ select: { id: true, userId: true, rpcAvailableBalance: true, rpcLockedBalance: true, pendingWithdrawalBalance: true } }),
    prisma.treasuryAccount.findMany({ select: { id: true, balance: true } }),
    prisma.brokerAccount.findMany({ select: { id: true, available: true } }),
    prisma.platformAccount.findMany({ select: { id: true, balance: true } }),
    prisma.companyRevenueAccount.findMany({ select: { id: true, balance: true } }),
    prisma.projectBuybackProgram.findMany({ select: { id: true, remainingRpc: true } }),
    prisma.projectHolderDistributionProgram.findMany({ select: { id: true, budgetRpc: true, distributedRpc: true } }),
    prisma.coinIssuance.findMany({ where: { OR: [{ reason: '' }, { createdById: '' }] }, take: 50 }),
    prisma.coinTransfer.findMany({ where: { reason: '' }, take: 50 }),
  ]);

  const issues: Array<{ code: string; severity: 'CRITICAL' | 'WARNING'; entity: string; entityId: string; message: string }> = [];
  for (const w of wallets) {
    if (toNum(w.rpcAvailableBalance) < 0) issues.push({ code: 'NEGATIVE_WALLET_RPC_AVAILABLE', severity: 'CRITICAL', entity: 'Wallet', entityId: w.id, message: 'rpcAvailableBalance negativo.' });
    if (toNum(w.rpcLockedBalance) < 0) issues.push({ code: 'NEGATIVE_WALLET_RPC_LOCKED', severity: 'CRITICAL', entity: 'Wallet', entityId: w.id, message: 'rpcLockedBalance negativo.' });
    if (toNum(w.pendingWithdrawalBalance) < 0) issues.push({ code: 'NEGATIVE_WALLET_RPC_PENDING', severity: 'CRITICAL', entity: 'Wallet', entityId: w.id, message: 'pendingWithdrawalBalance negativo.' });
  }
  for (const t of treasury) if (toNum(t.balance) < 0) issues.push({ code: 'NEGATIVE_TREASURY_BALANCE', severity: 'CRITICAL', entity: 'TreasuryAccount', entityId: t.id, message: 'Saldo da tesouraria negativo.' });
  for (const b of brokers) if (toNum(b.available) < 0) issues.push({ code: 'NEGATIVE_BROKER_BALANCE', severity: 'CRITICAL', entity: 'BrokerAccount', entityId: b.id, message: 'Saldo do corretor negativo.' });
  for (const p of platformAccounts) if (toNum(p.balance) < 0) issues.push({ code: 'NEGATIVE_PLATFORM_BALANCE', severity: 'CRITICAL', entity: 'PlatformAccount', entityId: p.id, message: 'Saldo da plataforma negativo.' });
  for (const r of revenueAccounts) if (toNum(r.balance) < 0) issues.push({ code: 'NEGATIVE_COMPANY_REVENUE_BALANCE', severity: 'CRITICAL', entity: 'CompanyRevenueAccount', entityId: r.id, message: 'Saldo institucional negativo.' });
  for (const b of buybackPrograms) if (toNum(b.remainingRpc) < 0) issues.push({ code: 'NEGATIVE_BUYBACK_REMAINING_RPC', severity: 'CRITICAL', entity: 'ProjectBuybackProgram', entityId: b.id, message: 'remainingRpc negativo.' });
  for (const h of holderPrograms) if (toNum(h.distributedRpc) > toNum(h.budgetRpc)) issues.push({ code: 'HOLDER_DISTRIBUTION_EXCEEDS_BUDGET', severity: 'CRITICAL', entity: 'ProjectHolderDistributionProgram', entityId: h.id, message: 'distributedRpc maior que budgetRpc.' });
  for (const i of badIssuances) issues.push({ code: 'COIN_ISSUANCE_MISSING_FIELDS', severity: 'WARNING', entity: 'CoinIssuance', entityId: i.id, message: 'CoinIssuance sem reason e/ou createdById.' });
  for (const t of badTransfers) issues.push({ code: 'COIN_TRANSFER_WITHOUT_REASON', severity: 'WARNING', entity: 'CoinTransfer', entityId: t.id, message: 'CoinTransfer sem reason.' });

  return { summary: { total: issues.length, critical: issues.filter((i) => i.severity === 'CRITICAL').length, warning: issues.filter((i) => i.severity === 'WARNING').length }, issues };
}

export async function getRpcSupplyPolicySummary(actorRoles: string[]) {
  assertRpcPolicyReadAccess(actorRoles);
  const [snapshot, audit, issuances] = await Promise.all([
    calculateRpcSupplySnapshot(),
    auditRpcSupplyConsistency(),
    prisma.coinIssuance.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);

  return {
    plannedSupply: null,
    maxSupply: null,
    ...snapshot,
    inconsistencies: audit.summary,
    lastIssuances: issuances,
  };
}
