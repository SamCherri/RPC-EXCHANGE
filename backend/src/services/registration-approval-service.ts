import { FinancialPermissionKey } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export async function assertApprovedUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { approvalStatus: true, isBlocked: true } });
  if (!user || user.isBlocked || user.approvalStatus !== 'APPROVED') {
    throw new Error('Cadastro ainda não aprovado para usar recursos econômicos. Acompanhe a tela de status/correção.');
  }
}

export async function assertFinancialPermission(userId: string, permission: FinancialPermissionKey) {
  await assertApprovedUser(userId);
  const grant = await prisma.userFinancialPermission.findUnique({ where: { userId_permission: { userId, permission } } });
  if (!grant || grant.revokedAt) {
    throw new Error('Permissão financeira não concedida pelo SUPER_ADMIN para esta ação.');
  }
}
