import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { validatePublicNameAllowed } from './content-moderation-service.js';
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;

function normalizeDiscord(discordId: string) {
  return discordId.trim();
}

function buildInternalEmail(discordId: string) {
  const safeDiscord = normalizeDiscord(discordId)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${safeDiscord || 'discord'}@discord.rpc-exchange.local`;
}

export async function registerUser(name: string, characterName: string, discordId: string, characterPhone: string, password: string, proof: { mimeType: string; fileName?: string; data: string; checksum: string }) {
  const normalizedDiscord = normalizeDiscord(discordId);

  await validatePublicNameAllowed(name, 'user');
  await validatePublicNameAllowed(characterName, 'character');

  const discordExists = await prisma.user.findFirst({ where: { discordId: { equals: normalizedDiscord, mode: 'insensitive' } }, select: { id: true } });
  if (discordExists) throw new Error('Discord já cadastrado.');

  const normalizedEmail = buildInternalEmail(normalizedDiscord);
  const emailExists = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
  if (emailExists) throw new Error('Discord já cadastrado.');

  const passwordHash = await bcrypt.hash(password, 10);

  const userRole = await prisma.role.findUnique({ where: { key: 'USER' } });
  if (!userRole) {
    throw new Error('Cargo USER não encontrado no seed.');
  }

  const user = await prisma.user.create({
    data: {
      name,
      email: normalizedEmail,
      passwordHash,
      characterName,
      bankAccountNumber: null,
      discordId: normalizedDiscord,
      characterPhone: characterPhone.trim(),
      approvalStatus: 'PENDING',
      registrationProof: { create: proof },
      wallet: { create: {} },
      roles: { create: [{ roleId: userRole.id }] },
    },
    include: { roles: { include: { role: true } } },
  });

  return user;
}

export async function loginUser(discordId: string, password: string) {
  const identifier = discordId.trim();
  const user = await prisma.user.findFirst({
    where: identifier.includes('@')
      ? { OR: [{ discordId: { equals: identifier, mode: 'insensitive' } }, { email: { equals: identifier.toLowerCase(), mode: 'insensitive' } }] }
      : { discordId: { equals: identifier, mode: 'insensitive' } },
    include: { roles: { include: { role: true } }, wallet: true },
  });

  if (!user) {
    throw new Error('Credenciais inválidas.');
  }
  if (user.loginLockedUntil && user.loginLockedUntil > new Date()) {
    throw new Error('Muitas tentativas inválidas. Tente novamente mais tarde.');
  }

  if (user.isBlocked) {
    throw new Error('Usuário bloqueado pela administração.');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const failedLoginAttempts = user.failedLoginAttempts + 1;
    const lockAccount = failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts,
        loginLockedUntil: lockAccount ? new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000) : null,
      },
    });
    if (lockAccount) {
      throw new Error('Muitas tentativas inválidas. Tente novamente mais tarde.');
    }
    throw new Error('Credenciais inválidas.');
  }
  if (user.failedLoginAttempts > 0 || user.loginLockedUntil) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        loginLockedUntil: null,
      },
    });
  }

  return user;
}
