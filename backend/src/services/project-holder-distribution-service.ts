import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/http-error.js';

const ZERO = new Decimal(0);
const ADMIN_ROLES = ['SUPER_ADMIN', 'COIN_CHIEF_ADMIN'];
const AUDIT_ROLES = ['SUPER_ADMIN', 'COIN_CHIEF_ADMIN', 'AUDITOR'];
const round2 = (v: Decimal) => v.toDecimalPlaces(2);

function allocateByCents(input: { budgetRpc: Decimal; holders: { userId: string; shares: number }[]; eligibleShares: number }) {
  const budgetCents = Number(input.budgetRpc.mul(100).toDecimalPlaces(0));
  const base = input.holders.map((h, idx) => {
    const rawNumerator = budgetCents * h.shares;
    const floorCents = Math.floor(rawNumerator / input.eligibleShares);
    const remainderNumerator = rawNumerator % input.eligibleShares;
    return { idx, userId: h.userId, shares: h.shares, floorCents, remainderNumerator };
  });
  const used = base.reduce((acc, b) => acc + b.floorCents, 0);
  let leftover = budgetCents - used;
  const ranking = [...base].sort((a, b) => (b.remainderNumerator - a.remainderNumerator) || (b.shares - a.shares) || a.userId.localeCompare(b.userId));
  const plus = new Map<number, number>();
  for (const item of ranking) {
    if (leftover <= 0) break;
    plus.set(item.idx, (plus.get(item.idx) ?? 0) + 1);
    leftover -= 1;
  }

  return base.map((item) => ({
    ...item,
    cents: item.floorCents + (plus.get(item.idx) ?? 0),
    amount: new Decimal(item.floorCents + (plus.get(item.idx) ?? 0)).div(100).toDecimalPlaces(2),
  }));
}

function hasAnyRole(roles: string[], allowed: string[]) { return roles.some((r) => allowed.includes(r.toUpperCase())); }

export async function createHolderDistributionProgram(input: { companyId: string; actorUserId: string; actorRoles?: string[]; budgetRpc: number; reason: string; excludeFounder?: boolean; ip?: string; userAgent?: string | null }) {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new HttpError(400, 'Motivo deve ter ao menos 10 caracteres.');
  const budgetRpc = round2(new Decimal(input.budgetRpc));
  if (budgetRpc.lte(0)) throw new HttpError(400, 'budgetRpc deve ser maior que zero.');
  if (input.excludeFounder === false) throw new HttpError(400, 'Inclusão do fundador na distribuição não é suportada nesta política inicial.');
  const excludeFounder = true;

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${input.companyId} FOR UPDATE`;
    const company = await tx.company.findUnique({ where: { id: input.companyId }, include: { revenueAccount: true } });
    if (!company) throw new HttpError(404, 'Projeto não encontrado.');
    if (company.status !== 'ACTIVE') throw new HttpError(400, 'Projeto precisa estar ACTIVE.');
    const isFounder = company.founderUserId === input.actorUserId;
    if (!isFounder && !hasAnyRole(input.actorRoles ?? [], ADMIN_ROLES)) throw new HttpError(403, 'Sem permissão.');
    const revenue = await tx.companyRevenueAccount.findUnique({ where: { companyId: input.companyId } });
    if (!revenue) throw new HttpError(400, 'Conta institucional não encontrada.');

    const holders = await tx.companyHolding.findMany({ where: { companyId: input.companyId, shares: { gt: 0 }, userId: excludeFounder ? { not: company.founderUserId } : undefined } });
    if (!holders.length) throw new HttpError(400, 'Snapshot vazio.');
    const eligibleShares = holders.reduce((acc, h) => acc + h.shares, 0);
    if (eligibleShares <= 0) throw new HttpError(400, 'Shares elegíveis inválidas.');

    const debited = await tx.companyRevenueAccount.updateMany({ where: { id: revenue.id, balance: { gte: budgetRpc } }, data: { balance: { decrement: budgetRpc } } });
    if (debited.count !== 1) throw new HttpError(400, 'Saldo institucional insuficiente.');

    const program = await tx.projectHolderDistributionProgram.create({ data: { companyId: input.companyId, createdByUserId: input.actorUserId, status: 'READY', budgetRpc, eligibleShares, eligibleHoldersCount: holders.length, reason, excludeFounder } });

    const allocations = allocateByCents({ budgetRpc, holders: holders.map((h) => ({ userId: h.userId, shares: h.shares })), eligibleShares });
    const totalCents = allocations.reduce((acc, item) => acc + item.cents, 0);
    if (totalCents !== Number(budgetRpc.mul(100).toDecimalPlaces(0))) throw new HttpError(400, 'Falha ao distribuir orçamento em centavos.');

    for (const h of holders) {
      const alloc = allocations.find((a) => a.userId === h.userId);
      if (!alloc) throw new HttpError(400, 'Falha ao localizar alocação de holder.');
      const percent = new Decimal(h.shares).div(eligibleShares).toDecimalPlaces(8);
      await tx.projectHolderDistributionSnapshot.create({ data: { programId: program.id, companyId: input.companyId, userId: h.userId, shares: h.shares, sharePercent: percent, calculatedAmountRpc: alloc.amount } });
    }

    await tx.adminLog.create({ data: { userId: input.actorUserId, action: 'PROJECT_HOLDER_DISTRIBUTION_CREATE', entity: 'ProjectHolderDistributionProgram', reason, current: JSON.stringify({ programId: program.id, companyId: input.companyId, budgetRpc: String(budgetRpc), excludeFounder }), ip: input.ip ?? null, userAgent: input.userAgent ?? null } });
    return program;
  });
}

export async function executeHolderDistributionProgram(input: { programId: string; actorUserId: string; actorRoles?: string[]; ip?: string; userAgent?: string | null }) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ProjectHolderDistributionProgram" WHERE id = ${input.programId} FOR UPDATE`;
    const program = await tx.projectHolderDistributionProgram.findUnique({ where: { id: input.programId }, include: { company: true } });
    if (!program) throw new HttpError(404, 'Programa não encontrado.');
    const isFounder = program.company.founderUserId === input.actorUserId;
    if (!isFounder && !hasAnyRole(input.actorRoles ?? [], ADMIN_ROLES)) throw new HttpError(403, 'Sem permissão.');
    if (program.status !== 'READY') throw new HttpError(400, 'Programa não está READY ou já foi executado/cancelado.');

    const snapshots = await tx.projectHolderDistributionSnapshot.findMany({ where: { programId: program.id, status: 'PENDING' } });
    let totalPaid = ZERO;
    let skipped = 0;
    for (const snap of snapshots) {
      if (snap.calculatedAmountRpc.lte(0)) {
        await tx.projectHolderDistributionSnapshot.update({ where: { id: snap.id }, data: { status: 'SKIPPED' } });
        skipped++;
        continue;
      }
      const wallet = await tx.wallet.findUnique({ where: { userId: snap.userId } });
      if (!wallet) {
        await tx.projectHolderDistributionSnapshot.update({ where: { id: snap.id }, data: { status: 'SKIPPED' } });
        skipped++;
        continue;
      }
      await tx.wallet.update({ where: { id: wallet.id }, data: { rpcAvailableBalance: { increment: snap.calculatedAmountRpc } } });
      const tr = await tx.transaction.create({ data: { walletId: wallet.id, type: 'PROJECT_HOLDER_DISTRIBUTION_IN', amount: snap.calculatedAmountRpc, description: `Distribuição para holder do projeto ${program.company.ticker}` } });
      await tx.projectHolderDistributionPayment.create({ data: { programId: program.id, snapshotId: snap.id, companyId: program.companyId, userId: snap.userId, walletId: wallet.id, transactionId: tr.id, amountRpc: snap.calculatedAmountRpc } });
      await tx.projectHolderDistributionSnapshot.update({ where: { id: snap.id }, data: { status: 'PAID', paidAmountRpc: snap.calculatedAmountRpc, paidAt: new Date() } });
      totalPaid = totalPaid.add(snap.calculatedAmountRpc);
    }
    const forceSkipped = await tx.projectHolderDistributionSnapshot.updateMany({ where: { programId: program.id, status: 'PENDING' }, data: { status: 'SKIPPED' } });
    if (forceSkipped.count > 0) skipped += forceSkipped.count;

    const finalizedSnapshots = await tx.projectHolderDistributionSnapshot.findMany({ where: { programId: program.id } });
    const hasPending = finalizedSnapshots.some((snapshot) => snapshot.status === 'PENDING');
    if (hasPending) throw new HttpError(409, 'Inconsistência: snapshot PENDING após execução.');

    const refund = round2(program.budgetRpc.sub(totalPaid));
    if (refund.gt(0)) await tx.companyRevenueAccount.update({ where: { companyId: program.companyId }, data: { balance: { increment: refund } } });

    const finish = await tx.projectHolderDistributionProgram.updateMany({ where: { id: program.id, status: 'READY' }, data: { status: 'COMPLETED', distributedRpc: totalPaid, refundedRpc: refund.gt(0) ? refund : ZERO, executedAt: new Date() } });
    if (finish.count !== 1) throw new HttpError(409, 'Conflito de concorrência ao finalizar distribuição.');
    const updated = await tx.projectHolderDistributionProgram.findUniqueOrThrow({ where: { id: program.id } });
    await tx.adminLog.create({ data: { userId: input.actorUserId, action: 'PROJECT_HOLDER_DISTRIBUTION_EXECUTE', entity: 'ProjectHolderDistributionProgram', reason: 'Execução de distribuição para holders', current: JSON.stringify({ programId: program.id, distributedRpc: String(totalPaid), refundedRpc: String(refund), skipped }), ip: input.ip ?? null, userAgent: input.userAgent ?? null } });
    return updated;
  });
}

export async function cancelHolderDistributionProgram(input: { programId: string; actorUserId: string; actorRoles?: string[]; ip?: string; userAgent?: string | null }) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ProjectHolderDistributionProgram" WHERE id = ${input.programId} FOR UPDATE`;
    const program = await tx.projectHolderDistributionProgram.findUnique({ where: { id: input.programId }, include: { company: true } });
    if (!program) throw new HttpError(404, 'Programa não encontrado.');
    const isFounder = program.company.founderUserId === input.actorUserId;
    if (!isFounder && !hasAnyRole(input.actorRoles ?? [], ADMIN_ROLES)) throw new HttpError(403, 'Sem permissão.');
    if (!['READY', 'DRAFT'].includes(program.status)) throw new HttpError(400, 'Somente READY/DRAFT pode cancelar.');
    const pending = await tx.projectHolderDistributionSnapshot.findMany({ where: { programId: program.id, status: 'PENDING' } });
    const refund = pending.reduce((acc, s) => acc.add(s.calculatedAmountRpc), ZERO);
    await tx.projectHolderDistributionSnapshot.updateMany({ where: { programId: program.id, status: 'PENDING' }, data: { status: 'SKIPPED' } });
    const pendingAfterCancel = await tx.projectHolderDistributionSnapshot.count({ where: { programId: program.id, status: 'PENDING' } });
    if (pendingAfterCancel > 0) throw new HttpError(409, 'Inconsistência: snapshot PENDING após cancelamento.');
    if (refund.gt(0)) await tx.companyRevenueAccount.update({ where: { companyId: program.companyId }, data: { balance: { increment: refund } } });
    const updated = await tx.projectHolderDistributionProgram.update({ where: { id: program.id }, data: { status: 'CANCELED', refundedRpc: refund, canceledAt: new Date() } });
    await tx.adminLog.create({ data: { userId: input.actorUserId, action: 'PROJECT_HOLDER_DISTRIBUTION_CANCEL', entity: 'ProjectHolderDistributionProgram', reason: 'Cancelamento de distribuição para holders', current: JSON.stringify({ programId: program.id, refundedRpc: String(refund) }), ip: input.ip ?? null, userAgent: input.userAgent ?? null } });
    return updated;
  });
}

export async function getHolderDistributionProgramSummary(companyId: string, actorUserId: string, actorRoles: string[]) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new HttpError(404, 'Projeto não encontrado.');
  if (company.founderUserId !== actorUserId && !hasAnyRole(actorRoles, AUDIT_ROLES)) throw new HttpError(403, 'Sem permissão.');
  return prisma.projectHolderDistributionProgram.findMany({ where: { companyId }, include: { snapshots: true, payments: true }, orderBy: { createdAt: 'desc' } });
}

export async function listMyProjectHolderDistributions(actorUserId: string) {
  const companies = await prisma.company.findMany({ where: { founderUserId: actorUserId }, select: { id: true } });
  return prisma.projectHolderDistributionProgram.findMany({ where: { companyId: { in: companies.map((c) => c.id) } }, include: { snapshots: true }, orderBy: { createdAt: 'desc' } });
}

export async function listAdminHolderDistributions(actorRoles: string[]) {
  if (!hasAnyRole(actorRoles, AUDIT_ROLES)) throw new HttpError(403, 'Sem permissão.');
  return prisma.projectHolderDistributionProgram.findMany({ include: { snapshots: true, payments: true }, orderBy: { createdAt: 'desc' }, take: 200 });
}
