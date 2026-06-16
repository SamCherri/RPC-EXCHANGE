import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { validatePublicNameAllowed } from './content-moderation-service.js';
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;

export function normalizeDiscord(value: string) {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

export function normalizeGamePhone(value: string) {
  return value.trim();
}

async function validatePlayerProfileInput(input: { name: string; characterName: string; discord: string; gamePhone: string; currentUserId?: string }) {
  const name = input.name.trim();
  const characterName = input.characterName.trim();
  const discord = normalizeDiscord(input.discord);
  const gamePhone = normalizeGamePhone(input.gamePhone);

  if (name.length < 3) throw new Error('Nome deve ter pelo menos 3 caracteres.');
  if (characterName.length < 3) throw new Error('Nome do personagem deve ter pelo menos 3 caracteres.');
  if (discord.length < 2) throw new Error('Discord deve ter pelo menos 2 caracteres.');
  if (gamePhone.length < 3) throw new Error('Telefone do jogo deve ter pelo menos 3 caracteres.');
  if (discord.length > 64) throw new Error('Discord deve ter no máximo 64 caracteres.');
  if (gamePhone.length > 32) throw new Error('Telefone do jogo deve ter no máximo 32 caracteres.');

  await validatePublicNameAllowed(name, 'user');
  await validatePublicNameAllowed(characterName, 'character');

  const existingDiscord = await prisma.user.findUnique({ where: { discord }, select: { id: true } });
  if (existingDiscord && existingDiscord.id !== input.currentUserId) {
    throw new Error('Discord já cadastrado.');
  }

  return { name, characterName, discord, gamePhone };
}

export async function registerUser(name: string, characterName: string, discord: string, gamePhone: string, password: string) {
  const profile = await validatePlayerProfileInput({ name, characterName, discord, gamePhone });
  const passwordHash = await bcrypt.hash(password, 10);

  const userRole = await prisma.role.findUnique({ where: { key: 'USER' } });
  if (!userRole) throw new Error('Cargo USER não encontrado no seed.');

  return prisma.user.create({
    data: {
      ...profile,
      passwordHash,
      wallet: { create: {} },
      roles: { create: [{ roleId: userRole.id }] },
    },
    include: { roles: { include: { role: true } } },
  });
}

export async function loginUser(discord: string, password: string) {
  const normalizedDiscord = normalizeDiscord(discord);
  const normalizedEmail = discord.trim().toLowerCase();
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { discord: normalizedDiscord },
        { email: normalizedEmail },
      ],
    },
    include: { roles: { include: { role: true } }, wallet: true },
  });

  if (!user) throw new Error('Credenciais inválidas.');
  if (user.loginLockedUntil && user.loginLockedUntil > new Date()) throw new Error('Muitas tentativas inválidas. Tente novamente mais tarde.');
  if (user.isBlocked) throw new Error('Usuário bloqueado pela administração.');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const failedLoginAttempts = user.failedLoginAttempts + 1;
    const lockAccount = failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS;
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts, loginLockedUntil: lockAccount ? new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000) : null } });
    if (lockAccount) throw new Error('Muitas tentativas inválidas. Tente novamente mais tarde.');
    throw new Error('Credenciais inválidas.');
  }
  if (user.failedLoginAttempts > 0 || user.loginLockedUntil) await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, loginLockedUntil: null } });
  return user;
}

export async function updateUserProfile(userId: string, input: { name: string; characterName: string; discord: string; gamePhone: string }) {
  const profile = await validatePlayerProfileInput({ ...input, currentUserId: userId });
  return prisma.user.update({ where: { id: userId }, data: profile, select: { id: true, name: true, characterName: true, discord: true, gamePhone: true, email: true, isBlocked: true, createdAt: true, roles: { include: { role: true } } } });
}

export async function changeUserPassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user) throw new Error('Não autenticado.');
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) throw new Error('Senha atual inválida.');
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(newPassword, 10), failedLoginAttempts: 0, loginLockedUntil: null } });
}
