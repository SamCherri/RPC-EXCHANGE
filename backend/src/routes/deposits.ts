import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ROLE, hasAnyRole } from '../lib/roles.js';
import { assertFinancialPermission } from '../services/registration-approval-service.js';
import { normalizeDiscord } from '../services/auth-service.js';
import { MAX_PENDING_DEPOSITS_PER_USER } from '../config/anti-abuse-limits.js';

type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };
type DepositAction = 'mark-processing' | 'complete' | 'reject';
type DepositActorType = 'admin' | 'broker';
type ScreenshotMimeType = typeof ALLOWED_SCREENSHOT_MIME_TYPES[number];

type NormalizedDepositScreenshot = {
  mimeType: ScreenshotMimeType;
  fileName?: string;
  data: string;
  checksum: string;
  size: number;
};

const DEPOSIT_ADMIN_ROLES = [ROLE.ADMIN, ROLE.SUPER_ADMIN, ROLE.DEVELOPER] as const;
const BROKER_ROLES = [ROLE.VIRTUAL_BROKER] as const;
const DEPOSIT_STATUS = ['PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELED'] as const;
const DEPOSIT_METHOD = ['PLATFORM', 'BROKER'] as const;
const ALLOWED_SCREENSHOT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const DEPOSIT_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const BASE64_CHARS_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_SCREENSHOT_BASE64_LENGTH = Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4;
const DATA_URL_PATTERN = /^data:([^;,]+);base64,/i;

const screenshotSchema = z.object({
  mimeType: z.string(),
  fileName: z.string().optional(),
  data: z.string(),
}).optional().nullable();

const createDepositSchema = z.object({
  amount: z.coerce.number().positive('Valor deve ser maior que zero.'),
  method: z.enum(DEPOSIT_METHOD),
  brokerUserId: z.string().min(1).optional(),
  brokerRef: z.string().min(1).optional(),
  userNote: z.string().max(400).optional(),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
  screenshot: screenshotSchema,
}).refine((data) => data.method === 'PLATFORM' || Boolean(data.brokerUserId || data.brokerRef), {
  message: 'Informe o corretor virtual para depósito via corretor.',
  path: ['brokerRef'],
});

const noteSchema = z.object({ adminNote: z.string().max(400).optional() });

function isDepositAdmin(roles: string[]) {
  return hasAnyRole(roles, DEPOSIT_ADMIN_ROLES);
}

function isBroker(roles: string[]) {
  return hasAnyRole(roles, BROKER_ROLES);
}

function sanitizeFileName(fileName?: string) {
  if (!fileName) return undefined;
  const sanitized = fileName.replace(/[\\/\0\r\n\t"]/g, '_').trim().slice(0, 120);
  return sanitized || undefined;
}

function isAllowedScreenshotMimeType(mimeType: string): mimeType is ScreenshotMimeType {
  return (ALLOWED_SCREENSHOT_MIME_TYPES as readonly string[]).includes(mimeType);
}

function detectScreenshotMimeType(buffer: Buffer): ScreenshotMimeType | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function normalizeDepositScreenshot(input?: { mimeType?: string; fileName?: string; data?: string } | null): NormalizedDepositScreenshot | null {
  if (!input?.data) return null;

  const declaredMimeType = input.mimeType?.trim().toLowerCase() ?? '';
  if (!isAllowedScreenshotMimeType(declaredMimeType)) {
    throw new Error('Print inválido. Envie apenas PNG, JPG ou WEBP.');
  }

  const trimmedData = input.data.trim();
  if (!trimmedData) throw new Error('Print vazio ou inválido.');

  const dataUrlMatch = trimmedData.match(DATA_URL_PATTERN);
  if (dataUrlMatch && dataUrlMatch[1]?.toLowerCase() !== declaredMimeType) {
    throw new Error('MIME declarado não confere com o print enviado.');
  }

  const base64Data = dataUrlMatch ? trimmedData.slice(dataUrlMatch[0].length) : trimmedData;
  const compactBase64 = base64Data.replace(/\s/g, '');

  if (!compactBase64 || compactBase64.length > MAX_SCREENSHOT_BASE64_LENGTH) {
    throw new Error('Print grande demais. Limite máximo: 2 MB.');
  }
  if (compactBase64.length % 4 !== 0 || !BASE64_CHARS_PATTERN.test(compactBase64)) {
    throw new Error('Print precisa estar em Base64 válido.');
  }

  const buffer = Buffer.from(compactBase64, 'base64');
  if (!buffer.length) throw new Error('Print vazio ou inválido.');
  if (buffer.length > MAX_SCREENSHOT_BYTES) throw new Error('Print grande demais. Limite máximo: 2 MB.');

  const detectedMimeType = detectScreenshotMimeType(buffer);
  if (!detectedMimeType) {
    throw new Error('Conteúdo do print não foi reconhecido como PNG, JPG ou WEBP.');
  }
  if (detectedMimeType !== declaredMimeType) {
    throw new Error('MIME declarado não confere com o conteúdo real do print.');
  }

  return {
    mimeType: detectedMimeType,
    fileName: sanitizeFileName(input.fileName),
    data: compactBase64,
    checksum: createHash('sha256').update(buffer).digest('hex'),
    size: buffer.length,
  };
}

function normalizeIdempotencyKey(request: FastifyRequest, bodyKey?: string) {
  const headerValue = request.headers['idempotency-key'];
  const raw = (Array.isArray(headerValue) ? headerValue[0] : headerValue) ?? bodyKey;
  const key = raw?.trim();
  if (!key) return null;
  if (key.length < 8 || key.length > 120) throw new Error('Chave de idempotência inválida. Use uma chave entre 8 e 120 caracteres.');
  return key;
}

function buildRequestHash(input: {
  amount: Decimal;
  method: string;
  brokerUserId?: string | null;
  brokerRef?: string | null;
  userNote?: string | null;
  screenshotChecksum?: string | null;
}) {
  const payload = {
    amount: input.amount.toFixed(2),
    method: input.method,
    brokerUserId: input.brokerUserId ?? null,
    brokerRef: input.brokerRef?.trim().toLowerCase() || null,
    userNote: input.userNote?.trim() || null,
    screenshotChecksum: input.screenshotChecksum ?? null,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function sanitizeDeposit<T extends {
  screenshotData?: string | null;
  screenshotChecksum?: string | null;
  idempotencyKey?: string | null;
  requestHash?: string | null;
  screenshotFileName?: string | null;
  screenshotSize?: number | null;
}>(deposit: T) {
  const {
    screenshotData,
    screenshotChecksum: _screenshotChecksum,
    idempotencyKey: _idempotencyKey,
    requestHash: _requestHash,
    ...safeDeposit
  } = deposit;
  return {
    ...safeDeposit,
    hasScreenshot: Boolean(screenshotData),
  };
}

async function generateDepositCode(tx: Prisma.TransactionClient) {
  const latest = await tx.depositRequest.findFirst({
    where: { code: { startsWith: 'DEP-' } },
    orderBy: { createdAt: 'desc' },
    select: { code: true },
  });
  const lastNumeric = latest?.code.match(/^DEP-(\d+)$/)?.[1];
  return `DEP-${String(lastNumeric ? Number(lastNumeric) + 1 : 1).padStart(6, '0')}`;
}

async function resolveBroker(tx: Prisma.TransactionClient, input: { brokerUserId?: string; brokerRef?: string }) {
  const include = { roles: { select: { role: { select: { key: true } } } } };
  const user = input.brokerUserId
    ? await tx.user.findUnique({ where: { id: input.brokerUserId }, include })
    : await resolveUniqueUserByRef(tx, input.brokerRef ?? '', 'VIRTUAL_BROKER');

  if (!user) throw new Error('Corretor virtual não encontrado.');
  const roles = user.roles.map((item) => item.role.key);
  if (!roles.includes('VIRTUAL_BROKER')) throw new Error('Usuário informado não é corretor virtual.');
  await tx.brokerAccount.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } });
  return user;
}

async function resolveUniqueUserByRef(tx: Prisma.TransactionClient, ref: string, roleKey?: string) {
  const trimmedRef = ref.trim();
  const roleFilter = roleKey ? { roles: { some: { role: { key: roleKey } } } } : {};
  const normalizedDiscord = normalizeDiscord(trimmedRef);

  if (normalizedDiscord) {
    const discordUser = await tx.user.findFirst({
      where: { ...roleFilter, discordId: { equals: normalizedDiscord, mode: 'insensitive' } },
      include: { roles: { select: { role: { select: { key: true } } } } },
    });
    if (discordUser) return discordUser;
  }

  const candidates = await tx.user.findMany({
    where: {
      ...roleFilter,
      OR: [
        { bankAccountNumber: { equals: trimmedRef } },
        { characterName: { equals: trimmedRef, mode: 'insensitive' } },
        { name: { equals: trimmedRef, mode: 'insensitive' } },
        { email: { equals: trimmedRef.toLowerCase(), mode: 'insensitive' } },
      ],
    },
    include: { roles: { select: { role: { select: { key: true } } } } },
    take: 2,
  });

  if (candidates.length === 0) throw new Error('Usuário não encontrado.');
  if (candidates.length > 1) throw new Error('Referência ambígua. Use o Discord exato.');
  return candidates[0];
}

async function logDeposit(tx: Prisma.TransactionClient, request: FastifyRequest, actorId: string, action: string, previous: unknown, current: unknown, reason?: string) {
  await tx.adminLog.create({
    data: {
      userId: actorId,
      action,
      entity: 'DepositRequest',
      reason,
      previous: JSON.stringify(previous),
      current: JSON.stringify(current),
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    },
  });
}

function includeDepositRelations() {
  return {
    user: { select: { id: true, name: true, email: true, characterName: true, bankAccountNumber: true, discordId: true } },
    brokerUser: { select: { id: true, name: true, email: true, characterName: true, discordId: true } },
  };
}

async function sendDepositScreenshot(reply: FastifyReply, deposit: { id: string; screenshotData: string | null; screenshotMimeType: string | null; screenshotFileName: string | null }) {
  if (!deposit.screenshotData || !deposit.screenshotMimeType) return reply.code(404).send({ message: 'Print não encontrado.' });
  if (!isAllowedScreenshotMimeType(deposit.screenshotMimeType)) return reply.code(400).send({ message: 'Tipo de print inválido.' });

  const extension = deposit.screenshotMimeType === 'image/png' ? 'png' : deposit.screenshotMimeType === 'image/webp' ? 'webp' : 'jpg';
  const safeFileName = sanitizeFileName(deposit.screenshotFileName ?? undefined) ?? `deposit-${deposit.id}.${extension}`;
  return reply
    .header('Content-Type', deposit.screenshotMimeType)
    .header('Content-Disposition', `inline; filename="${safeFileName}"`)
    .header('X-Content-Type-Options', 'nosniff')
    .send(Buffer.from(deposit.screenshotData, 'base64'));
}

async function resolveIdempotencyConflict(userId: string, idempotencyKey: string | null, requestHash: string | null) {
  if (!idempotencyKey || !requestHash) return null;
  const existing = await prisma.depositRequest.findFirst({ where: { userId, idempotencyKey } });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    return { statusCode: 409 as const, body: { message: 'Esta chave de idempotência já foi usada com dados diferentes. Gere uma nova chave e tente novamente.' } };
  }
  return { statusCode: 200 as const, body: sanitizeDeposit(existing) };
}

export async function depositsRoutes(app: FastifyInstance) {
  app.get('/deposits/me', { preHandler: [app.authenticate] }, async (request) => {
    const authRequest = request as AuthRequest;
    const deposits = await prisma.depositRequest.findMany({
      where: { userId: authRequest.user.sub },
      include: { brokerUser: { select: { id: true, name: true, characterName: true, discordId: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { deposits: deposits.map(sanitizeDeposit) };
  });

  app.get('/deposits/brokers', { preHandler: [app.authenticate] }, async () => {
    const brokers = await prisma.user.findMany({
      where: { isBlocked: false, approvalStatus: 'APPROVED', roles: { some: { role: { key: 'VIRTUAL_BROKER' } } } },
      select: { id: true, name: true, characterName: true, discordId: true },
      orderBy: { name: 'asc' },
      take: 100,
    });
    return { brokers };
  });

  app.get('/deposits/:id/screenshot', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const deposit = await prisma.depositRequest.findFirst({
      where: { id, userId: authRequest.user.sub },
      select: { id: true, screenshotData: true, screenshotMimeType: true, screenshotFileName: true },
    });
    if (!deposit) return reply.code(404).send({ message: 'Depósito não encontrado.' });
    return sendDepositScreenshot(reply, deposit);
  });

  app.post('/deposits', {
    preHandler: [app.authenticate],
    bodyLimit: DEPOSIT_BODY_LIMIT_BYTES,
    config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    let idempotencyKey: string | null = null;
    let requestHash: string | null = null;

    try {
      await assertFinancialPermission(authRequest.user.sub, 'FIAT_DEPOSIT_REQUEST');
      const body = createDepositSchema.parse(request.body);
      idempotencyKey = normalizeIdempotencyKey(request, body.idempotencyKey);
      const amount = new Decimal(body.amount);
      const screenshot = normalizeDepositScreenshot(body.screenshot);
      requestHash = buildRequestHash({
        amount,
        method: body.method,
        brokerUserId: body.brokerUserId,
        brokerRef: body.brokerRef,
        userNote: body.userNote,
        screenshotChecksum: screenshot?.checksum,
      });

      if (idempotencyKey) {
        const existing = await prisma.depositRequest.findFirst({ where: { userId: authRequest.user.sub, idempotencyKey } });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            return reply.code(409).send({ message: 'Esta chave de idempotência já foi usada com dados diferentes. Gere uma nova chave e tente novamente.' });
          }
          return reply.code(200).send(sanitizeDeposit(existing));
        }
      }

      const created = await prisma.$transaction(async (tx) => {
        if (idempotencyKey) {
          const existing = await tx.depositRequest.findFirst({ where: { userId: authRequest.user.sub, idempotencyKey } });
          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw Object.assign(new Error('Esta chave de idempotência já foi usada com dados diferentes. Gere uma nova chave e tente novamente.'), { statusCode: 409 });
            }
            return existing;
          }
        }

        const pendingCount = await tx.depositRequest.count({
          where: { userId: authRequest.user.sub, status: { in: ['PENDING', 'PROCESSING'] } },
        });
        if (pendingCount >= MAX_PENDING_DEPOSITS_PER_USER) {
          throw new Error('Você já possui depósitos pendentes. Aguarde revisão antes de solicitar outro.');
        }

        const broker = body.method === 'BROKER' ? await resolveBroker(tx, body) : null;
        if (broker?.id === authRequest.user.sub) throw new Error('Corretor não pode solicitar depósito via si mesmo.');

        const code = await generateDepositCode(tx);
        const deposit = await tx.depositRequest.create({
          data: {
            code,
            userId: authRequest.user.sub,
            amount,
            method: body.method,
            brokerUserId: broker?.id ?? null,
            userNote: body.userNote?.trim() || null,
            status: 'PENDING',
            idempotencyKey,
            requestHash: idempotencyKey ? requestHash : null,
            screenshotMimeType: screenshot?.mimeType,
            screenshotFileName: screenshot?.fileName,
            screenshotData: screenshot?.data,
            screenshotChecksum: screenshot?.checksum,
            screenshotSize: screenshot?.size,
          },
        });

        await logDeposit(tx, request, authRequest.user.sub, 'DEPOSIT_REQUEST_CREATED', null, {
          id: deposit.id,
          code,
          amount: amount.toString(),
          method: body.method,
          status: 'PENDING',
          brokerUserId: broker?.id ?? null,
          hasScreenshot: Boolean(screenshot),
          screenshotChecksum: screenshot?.checksum ?? null,
        }, body.userNote ?? 'Solicitação de depósito criada pelo usuário.');

        return deposit;
      });

      return reply.code(201).send(sanitizeDeposit(created));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const conflict = await resolveIdempotencyConflict(authRequest.user.sub, idempotencyKey, requestHash);
        if (conflict) return reply.code(conflict.statusCode).send(conflict.body);
        return reply.code(409).send({ message: 'Depósito já registrado para esta chave de idempotência. Consulte seu histórico.' });
      }
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return reply.code(statusCode).send({ message: (error as Error).message });
    }
  });

  app.post('/deposits/:id/cancel', {
    preHandler: [app.authenticate],
    config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 15, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const params = z.object({ id: z.string().min(1) }).parse(request.params);

    try {
      const canceled = await prisma.$transaction(async (tx) => {
        const deposit = await tx.depositRequest.findUnique({ where: { id: params.id } });
        if (!deposit || deposit.userId !== authRequest.user.sub) throw new Error('Solicitação de depósito não encontrada para este usuário.');
        if (deposit.status !== 'PENDING') throw new Error('Somente depósitos pendentes podem ser cancelados.');

        const next = await tx.depositRequest.update({ where: { id: deposit.id }, data: { status: 'CANCELED', canceledAt: new Date() } });
        await logDeposit(tx, request, authRequest.user.sub, 'DEPOSIT_REQUEST_CANCELED_BY_USER', { status: deposit.status }, { status: next.status, code: next.code }, 'Solicitação cancelada pelo usuário.');
        return next;
      });
      return sanitizeDeposit(canceled);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.get('/admin/deposits', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!isDepositAdmin(roles)) return reply.code(403).send({ message: 'Sem permissão para visualizar depósitos.' });

    const query = z.object({
      status: z.enum(DEPOSIT_STATUS).optional(),
      method: z.enum(DEPOSIT_METHOD).optional(),
      userRef: z.string().optional(),
      code: z.string().optional(),
    }).parse(request.query);

    const deposits = await prisma.depositRequest.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.method ? { method: query.method } : {}),
        ...(query.code ? { code: { contains: query.code, mode: 'insensitive' } } : {}),
        ...(query.userRef ? {
          user: {
            OR: [
              { email: { contains: query.userRef.toLowerCase(), mode: 'insensitive' } },
              { name: { contains: query.userRef, mode: 'insensitive' } },
              { characterName: { contains: query.userRef, mode: 'insensitive' } },
              { bankAccountNumber: { contains: query.userRef, mode: 'insensitive' } },
            ],
          },
        } : {}),
      },
      include: includeDepositRelations(),
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return { deposits: deposits.map(sanitizeDeposit) };
  });

  app.get('/admin/deposits/:id/screenshot', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    if (!isDepositAdmin(authRequest.user.roles ?? [])) return reply.code(403).send({ message: 'Sem permissão para visualizar prints de depósitos.' });
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const deposit = await prisma.depositRequest.findUnique({
      where: { id },
      select: { id: true, screenshotData: true, screenshotMimeType: true, screenshotFileName: true },
    });
    if (!deposit) return reply.code(404).send({ message: 'Depósito não encontrado.' });
    return sendDepositScreenshot(reply, deposit);
  });

  async function adminAction(request: FastifyRequest, reply: FastifyReply, action: DepositAction) {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!isDepositAdmin(roles)) return reply.code(403).send({ message: 'Sem permissão para processar depósitos.' });

    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = noteSchema.parse(request.body);

    try {
      const updated = await prisma.$transaction(async (tx) => processDeposit(tx, request, authRequest.user.sub, params.id, action, body.adminNote, 'admin'));
      return sanitizeDeposit(updated);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  }

  app.post('/admin/deposits/:id/mark-processing', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 25, timeWindow: '1 minute' } } }, (req, rep) => adminAction(req, rep, 'mark-processing'));
  app.post('/admin/deposits/:id/complete', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 25, timeWindow: '1 minute' } } }, (req, rep) => adminAction(req, rep, 'complete'));
  app.post('/admin/deposits/:id/reject', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 25, timeWindow: '1 minute' } } }, (req, rep) => adminAction(req, rep, 'reject'));

  app.get('/broker/deposits', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!isBroker(roles)) return reply.code(403).send({ message: 'Somente corretor virtual pode visualizar depósitos atribuídos.' });

    const deposits = await prisma.depositRequest.findMany({
      where: { method: 'BROKER', brokerUserId: authRequest.user.sub },
      include: includeDepositRelations(),
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { deposits: deposits.map(sanitizeDeposit) };
  });

  app.get('/broker/deposits/:id/screenshot', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    if (!isBroker(authRequest.user.roles ?? [])) return reply.code(403).send({ message: 'Somente corretor virtual pode visualizar prints atribuídos.' });
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const deposit = await prisma.depositRequest.findFirst({
      where: { id, method: 'BROKER', brokerUserId: authRequest.user.sub },
      select: { id: true, screenshotData: true, screenshotMimeType: true, screenshotFileName: true },
    });
    if (!deposit) return reply.code(404).send({ message: 'Depósito não encontrado.' });
    return sendDepositScreenshot(reply, deposit);
  });

  async function brokerAction(request: FastifyRequest, reply: FastifyReply, action: DepositAction) {
    const authRequest = request as AuthRequest;
    const roles = authRequest.user.roles ?? [];
    if (!isBroker(roles)) return reply.code(403).send({ message: 'Somente corretor virtual pode processar depósitos atribuídos.' });

    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = noteSchema.parse(request.body);

    try {
      const updated = await prisma.$transaction(async (tx) => processDeposit(tx, request, authRequest.user.sub, params.id, action, body.adminNote, 'broker'));
      return sanitizeDeposit(updated);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  }

  app.post('/broker/deposits/:id/mark-processing', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 25, timeWindow: '1 minute' } } }, (req, rep) => brokerAction(req, rep, 'mark-processing'));
  app.post('/broker/deposits/:id/complete', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 25, timeWindow: '1 minute' } } }, (req, rep) => brokerAction(req, rep, 'complete'));
  app.post('/broker/deposits/:id/reject', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 25, timeWindow: '1 minute' } } }, (req, rep) => brokerAction(req, rep, 'reject'));
}

async function processDeposit(tx: Prisma.TransactionClient, request: FastifyRequest, actorId: string, id: string, action: DepositAction, adminNote: string | undefined, actorType: DepositActorType) {
  const deposit = await tx.depositRequest.findUnique({ where: { id } });
  if (!deposit) throw new Error('Depósito não encontrado.');
  if (actorType === 'admin' && deposit.userId === actorId) throw new Error('Administrador não pode revisar o próprio depósito.');
  if (actorType === 'admin' && deposit.method === 'BROKER' && action !== 'reject') {
    throw new Error('Depósitos via corretor só podem ser processados/concluídos pelo corretor atribuído. Admin pode rejeitar o pedido, se necessário.');
  }
  if (actorType === 'broker') {
    if (deposit.method !== 'BROKER' || deposit.brokerUserId !== actorId) throw new Error('Corretor só pode processar depósitos atribuídos a ele.');
    if (deposit.userId === actorId) throw new Error('Corretor não pode concluir depósito para si mesmo.');
  }

  if (action === 'mark-processing') {
    if (deposit.status !== 'PENDING') throw new Error('Somente depósito pendente pode ser marcado em processamento.');
    const next = await tx.depositRequest.update({
      where: { id },
      data: { status: 'PROCESSING', processingAt: new Date(), reviewedById: actorId, adminNote: adminNote?.trim() || null },
    });
    await logDeposit(tx, request, actorId, 'DEPOSIT_MARKED_PROCESSING', { status: deposit.status }, { status: next.status, code: next.code }, adminNote ?? 'Depósito marcado em processamento.');
    return next;
  }

  if (!['PENDING', 'PROCESSING'].includes(deposit.status)) throw new Error('Somente depósito pendente ou em processamento pode ser finalizado.');
  const transition = await tx.depositRequest.updateMany({
    where: { id, status: { in: ['PENDING', 'PROCESSING'] } },
    data: {
      status: action === 'complete' ? 'COMPLETED' : 'REJECTED',
      completedAt: action === 'complete' ? new Date() : undefined,
      rejectedAt: action === 'reject' ? new Date() : undefined,
      reviewedById: actorId,
      completedById: action === 'complete' ? actorId : undefined,
      adminNote: adminNote?.trim() || null,
    },
  });
  if (transition.count !== 1) throw new Error('Depósito já foi processado por outra ação.');

  if (action === 'reject') {
    const next = await tx.depositRequest.findUniqueOrThrow({ where: { id } });
    await logDeposit(tx, request, actorId, 'DEPOSIT_REJECTED', { status: deposit.status }, { status: next.status, code: next.code }, adminNote ?? 'Depósito rejeitado.');
    return next;
  }

  const wallet = await tx.wallet.upsert({ where: { userId: deposit.userId }, update: {}, create: { userId: deposit.userId } });
  const previousWalletBalance = wallet.fiatAvailableBalance;

  if (deposit.method === 'BROKER') {
    if (!deposit.brokerUserId) throw new Error('Depósito via corretor sem corretor atribuído.');
    const broker = await tx.brokerAccount.findUnique({ where: { userId: deposit.brokerUserId } });
    if (!broker) throw new Error('Conta do corretor não encontrada.');
    if (broker.available.lessThan(deposit.amount)) throw new Error('Saldo insuficiente no corretor para concluir depósito.');

    const brokerMutation = await tx.brokerAccount.updateMany({
      where: { id: broker.id, available: { gte: deposit.amount } },
      data: { available: { decrement: deposit.amount } },
    });
    if (brokerMutation.count !== 1) throw new Error('Saldo insuficiente no corretor para concluir depósito.');

    await tx.wallet.update({ where: { id: wallet.id }, data: { fiatAvailableBalance: { increment: deposit.amount } } });
    await tx.transaction.create({ data: { walletId: wallet.id, type: 'BROKER_FIAT_TRANSFER_IN', amount: deposit.amount, description: `Depósito via corretor concluído (${deposit.code})` } });

    const updatedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    const updatedBroker = await tx.brokerAccount.findUniqueOrThrow({ where: { id: broker.id } });
    const next = await tx.depositRequest.findUniqueOrThrow({ where: { id } });
    await logDeposit(tx, request, actorId, 'BROKER_DEPOSIT_COMPLETED', {
      status: deposit.status,
      brokerBalance: broker.available.toString(),
      userBalance: previousWalletBalance.toString(),
    }, {
      status: next.status,
      brokerBalance: updatedBroker.available.toString(),
      userBalance: updatedWallet.fiatAvailableBalance.toString(),
      amount: deposit.amount.toString(),
      code: deposit.code,
    }, adminNote ?? 'Depósito via corretor concluído.');
    return next;
  }

  const treasury = await tx.treasuryAccount.findFirstOrThrow();
  const treasuryPrevious = treasury.balance;
  const treasuryMutation = await tx.treasuryAccount.updateMany({
    where: { id: treasury.id, balance: { gte: deposit.amount } },
    data: { balance: { decrement: deposit.amount } },
  });
  if (treasuryMutation.count !== 1) throw new Error('Saldo em R$ insuficiente na tesouraria para concluir depósito.');

  await tx.wallet.update({ where: { id: wallet.id }, data: { fiatAvailableBalance: { increment: deposit.amount } } });
  await tx.coinTransfer.create({
    data: {
      type: 'ADJUSTMENT',
      senderId: null,
      receiverId: deposit.userId,
      amount: deposit.amount,
      reason: `Depósito PLATFORM concluído (${deposit.code})`,
      previousValue: treasuryPrevious,
      newValue: treasuryPrevious.sub(deposit.amount),
    },
  });
  await tx.transaction.create({ data: { walletId: wallet.id, type: 'FIAT_DEPOSIT_COMPLETED', amount: deposit.amount, description: `Depósito via plataforma concluído (${deposit.code})` } });

  const updatedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
  const updatedTreasury = await tx.treasuryAccount.findUniqueOrThrow({ where: { id: treasury.id } });
  const next = await tx.depositRequest.findUniqueOrThrow({ where: { id } });
  await logDeposit(tx, request, actorId, 'FIAT_DEPOSIT_COMPLETED', {
    status: deposit.status,
    userBalance: previousWalletBalance.toString(),
    treasuryBalance: treasuryPrevious.toString(),
  }, {
    status: next.status,
    userBalance: updatedWallet.fiatAvailableBalance.toString(),
    treasuryBalance: updatedTreasury.balance.toString(),
    amount: deposit.amount.toString(),
    code: deposit.code,
  }, adminNote ?? 'Depósito via plataforma concluído.');
  return next;
}
