import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { validatePublicNameAllowed, validateRpAccountUnique } from './content-moderation-service.js';
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;

export async function registerUser(name: string, characterName: string, bankAccountNumber: string, discordId: string, characterPhone: string, email: string, password: string, proof: { mimeType: string; fileName?: string; data: string; checksum: string }) {
  const normalizedEmail = email.trim().toLowerCase();
  const exists = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (exists) {
    throw new Error('E-mail já cadastrado.');
  }

  await validatePublicNameAllowed(name, 'user');
  await validatePublicNameAllowed(characterName, 'character');
  await validateRpAccountUnique(bankAccountNumber);

  const discordExists = await prisma.user.findFirst({ where: { discordId: { equals: discordId.trim(), mode: 'insensitive' } }, select: { id: true } });
  if (discordExists) throw new Error('Discord já cadastrado.');

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
      bankAccountNumber,
      discordId: discordId.trim(),
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

export async function loginUser(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
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
