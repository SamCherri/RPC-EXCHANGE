const OFFICIAL_ROLE_LABELS: Record<string, string> = {
  DEVELOPER: 'Desenvolvedor',
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin oficial',
  COIN_CHIEF_ADMIN: 'Tesouraria oficial',
  VIRTUAL_BROKER: 'Corretor oficial',
  AUDITOR: 'Auditor oficial',
};

export function isOfficialRole(roles: string[] = []): boolean {
  return roles.some((role) => OFFICIAL_ROLE_LABELS[role]);
}

export function getOfficialRoleBadge(roles: string[] = []): string | null {
  const orderedPriority = ['DEVELOPER', 'SUPER_ADMIN', 'ADMIN', 'COIN_CHIEF_ADMIN', 'VIRTUAL_BROKER', 'AUDITOR'];
  for (const role of orderedPriority) {
    if (roles.includes(role)) return OFFICIAL_ROLE_LABELS[role];
  }
  return null;
}
