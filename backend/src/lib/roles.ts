export const ROLE = {
  USER: 'USER',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
  COIN_CHIEF_ADMIN: 'COIN_CHIEF_ADMIN',
  DEVELOPER: 'DEVELOPER',
  AUDITOR: 'AUDITOR',
  VIRTUAL_BROKER: 'VIRTUAL_BROKER',
} as const;

export const ADMIN_ROLES: string[] = [ROLE.ADMIN, ROLE.SUPER_ADMIN, ROLE.COIN_CHIEF_ADMIN, ROLE.DEVELOPER];
export const REGISTRATION_REVIEW_ROLES: string[] = [ROLE.ADMIN, ROLE.SUPER_ADMIN, ROLE.DEVELOPER];
export const SUPER_ADMIN_ROLES: string[] = [ROLE.SUPER_ADMIN, ROLE.DEVELOPER];
export const COIN_CONTROL_ROLES: string[] = [ROLE.COIN_CHIEF_ADMIN, ROLE.SUPER_ADMIN, ROLE.DEVELOPER];
export const ADMIN_REPORT_ROLES: string[] = [ROLE.SUPER_ADMIN, ROLE.AUDITOR, ROLE.COIN_CHIEF_ADMIN, ROLE.DEVELOPER];
export const ADMIN_OR_AUDITOR_ROLES: string[] = [ROLE.ADMIN, ROLE.SUPER_ADMIN, ROLE.COIN_CHIEF_ADMIN, ROLE.DEVELOPER, ROLE.AUDITOR];

export function hasAnyRole(roles: string[] = [], accepted: readonly string[]) {
  return roles.some((role) => accepted.includes(role));
}

export function hasDeveloperRole(roles: string[] = []) {
  return roles.includes(ROLE.DEVELOPER);
}

export function hasSuperAdminRole(roles: string[] = []) {
  return hasAnyRole(roles, SUPER_ADMIN_ROLES);
}
