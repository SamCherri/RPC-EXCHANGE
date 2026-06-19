import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../lib/prisma.js';
import { ensureCompanyRevenueAccount } from './fee-distribution-service.js';

export class HttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }

type ContributionResult = {
  companyId: string;
  amountRpc: Decimal;
  previousWalletRpcBalance: Decimal;
  newWalletRpcBalance: Decimal;
  previousProjectBalance: Decimal;
  newProjectBalance: Decimal;
  entryId: string;
  idempotencyKey: string | null;
  idempotentReplay: boolean;
};

type ContributionInput = {
  companyId: string;
  actorUserId: string;
  amountRpc: number;
  reason: string;
  idempotencyKey?: string | null;
  ip?: string;
  userAgent?: string | null;
};

function normalizeIdempotencyKey(idempotencyKey?: string | null) {
  const normalized = idempotencyKey?.trim();
  if (!normalized) throw new HttpError(400, 'Chave de idempotência é obrigatória para aporte RPC.');
  if (normalized.length < 16 || normalized.length > 120) throw new HttpError(400, 'Chave de idempotência inválida.');
  return normalized;
}

function resultFromEntry(entry: {
  id: string;
  companyId: string;
  amountRpc: Decimal;
  previousWalletRpcBalance: Decimal;
  newWalletRpcBalance: Decimal;
  previousProjectBalance: Decimal;
  newProjectBalance: Decimal;
  idempotencyKey: string | null;
}, idempotentReplay: boolean): ContributionResult {
  return {
    companyId: entry.companyId,
    amountRpc: entry.amountRpc,
    previousWalletRpcBalance: entry.previousWalletRpcBalance,
    newWalletRpcBalance: entry.newWalletRpcBalance,
    previousProjectBalance: entry.previousProjectBalance,
    newProjectBalance: entry.newProjectBalance,
    entryId: entry.id,
    idempotencyKey: entry.idempotencyKey,
    idempotentReplay,
  };
}

export async function contributeRpcToProject(input: ContributionInput) {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new HttpError(400, 'Motivo deve ter ao menos 10 caracteres.');
  const amount = new Decimal(input.amountRpc).toDecimalPlaces(2);
  if (amount.lte(0)) throw new HttpError(400, 'amountRpc deve ser maior que zero.');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${input.companyId} FOR UPDATE`;
    const company = await tx.company.findUnique({ where: { id: input.companyId } });
    if (!company) throw new HttpError(404, 'Projeto não encontrado.');
    if (company.founderUserId !== input.actorUserId) throw new HttpError(403, 'Sem permissão para aportar neste projeto.');
    if (company.status !== 'ACTIVE') throw new HttpError(400, 'Projeto precisa estar ACTIVE para receber aporte.');

    const existingEntry = await tx.companyCapitalFlowEntry.findUnique({ where: { idempotencyKey } });
    if (existingEntry) {
      if (existingEntry.companyId !== input.companyId || existingEntry.actorUserId !== input.actorUserId || !existingEntry.amountRpc.equals(amount) || existingEntry.reason !== reason) {
        throw new HttpError(409, 'Chave de idempotência já usada em outra intenção de aporte.');
      }
      return resultFromEntry(existingEntry, true);
    }

    await tx.$queryRaw`SELECT id FROM "Wallet" WHERE "userId" = ${input.actorUserId} FOR UPDATE`;
    const walletBefore = await tx.wallet.findUnique({ where: { userId: input.actorUserId } });
    if (!walletBefore) throw new HttpError(404, 'Carteira não encontrada.');
    const previousWalletRpcBalance = walletBefore.rpcAvailableBalance;

    const revenue = await ensureCompanyRevenueAccount(tx, company.id);
    await tx.$queryRaw`SELECT id FROM "CompanyRevenueAccount" WHERE id = ${revenue.id} FOR UPDATE`;
    const revenueBefore = await tx.companyRevenueAccount.findUniqueOrThrow({ where: { id: revenue.id } });
    const previousProjectBalance = revenueBefore.balance;

    const debited = await tx.wallet.updateMany({
      where: { userId: input.actorUserId, rpcAvailableBalance: { gte: amount } },
      data: { rpcAvailableBalance: { decrement: amount } },
    });
    if (debited.count !== 1) throw new HttpError(400, 'Saldo RPC insuficiente na carteira.');

    await tx.companyRevenueAccount.update({ where: { id: revenueBefore.id }, data: { balance: { increment: amount } } });

    const walletAfter = await tx.wallet.findUniqueOrThrow({ where: { userId: input.actorUserId } });
    const revenueAfter = await tx.companyRevenueAccount.findUniqueOrThrow({ where: { id: revenueBefore.id } });

    const entry = await tx.companyCapitalFlowEntry.create({ data: {
      companyId: company.id, actorUserId: input.actorUserId, type: 'OWNER_RPC_CONTRIBUTION', source: 'OWNER_WALLET', amountRpc: amount,
      previousWalletRpcBalance, newWalletRpcBalance: walletAfter.rpcAvailableBalance,
      previousProjectBalance, newProjectBalance: revenueAfter.balance, reason, idempotencyKey,
      metadata: JSON.stringify({ ip: input.ip ?? null, userAgent: input.userAgent ?? null, idempotencyKey }),
    } });

    await tx.transaction.create({ data: { walletId: walletBefore.id, type: 'PROJECT_RPC_CONTRIBUTION', amount, description: `Aporte RPC no projeto ${company.ticker}` } });
    await tx.adminLog.create({ data: { userId: input.actorUserId, action: 'PROJECT_RPC_CONTRIBUTION', entity: 'CompanyRevenueAccount', reason, ip: input.ip ?? null, userAgent: input.userAgent ?? null } });

    return resultFromEntry(entry, false);
  });
}
