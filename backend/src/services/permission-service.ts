import { prisma } from '../lib/prisma.js';

export const GRANULAR_PERMISSIONS = [
  'registration.review',
  'finance.rpc_purchase.review',
  'finance.broker_purchase.review',
  'finance.withdrawal.review',
] as const;

export async function userHasPermission(userId: string, permissionKey: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      roles: { select: { role: { select: { key: true, permissions: { select: { permission: { select: { key: true } } } } } } } },
      grantedPermissions: { select: { permission: { select: { key: true } } } },
    },
  });
  if (!user) return false;
  if (user.roles.some((item) => item.role.key === 'SUPER_ADMIN')) return true;
  if (user.grantedPermissions.some((item) => item.permission.key === permissionKey)) return true;
  return user.roles.some((item) => item.role.permissions.some((rp) => rp.permission.key === permissionKey));
}

export async function ensurePermission(userId: string, permissionKey: string) {
  if (!(await userHasPermission(userId, permissionKey))) {
    throw new Error('Sem permissão granular para esta ação.');
  }
}
