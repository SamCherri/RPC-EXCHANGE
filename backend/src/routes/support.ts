import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hasAnyRole, ROLE } from '../lib/roles.js';

type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };

const SUPPORT_ADMIN_ROLES = [ROLE.ADMIN, ROLE.SUPER_ADMIN, ROLE.DEVELOPER] as const;
const categories = ['BUG', 'SUGGESTION', 'COMPLAINT', 'QUESTION', 'BALANCE_ISSUE', 'REGISTRATION_ISSUE', 'OTHER'] as const;
const statuses = ['OPEN', 'IN_REVIEW', 'ANSWERED', 'CLOSED', 'REJECTED'] as const;
const priorities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const allowedScreenshotMimes = ['image/png', 'image/jpeg', 'image/webp'] as const;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

function ensureSupportAdmin(reply: FastifyReply, roles: string[]) {
  if (!hasAnyRole(roles, SUPPORT_ADMIN_ROLES)) {
    reply.code(403).send({ message: 'Sem permissão para acessar a central administrativa de suporte.' });
    return false;
  }
  return true;
}

function sanitizeTicket(ticket: any, admin = false) {
  const base = {
    id: ticket.id,
    userId: admin ? ticket.userId : undefined,
    user: admin && ticket.user ? { id: ticket.user.id, name: ticket.user.name, email: ticket.user.email, characterName: ticket.user.characterName } : undefined,
    category: ticket.category,
    title: ticket.title,
    message: ticket.message,
    screen: ticket.screen,
    platform: ticket.platform,
    userAgent: admin ? ticket.userAgent : undefined,
    status: ticket.status,
    internalPriority: admin ? ticket.internalPriority : undefined,
    internalNote: admin ? ticket.internalNote : undefined,
    hasScreenshot: Boolean(ticket.screenshotData),
    screenshotMimeType: admin ? ticket.screenshotMimeType : undefined,
    screenshotSize: admin ? ticket.screenshotSize : undefined,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    answeredAt: ticket.answeredAt,
    closedAt: ticket.closedAt,
    messages: ticket.messages?.filter((m: any) => admin || !m.isInternal).map((m: any) => ({
      id: m.id,
      message: m.message,
      isInternal: admin ? m.isInternal : undefined,
      createdAt: m.createdAt,
      author: m.author ? { id: m.author.id, name: m.author.name } : undefined,
    })),
  };
  return base;
}

function validateScreenshot(input?: { mimeType?: string; fileName?: string; data?: string } | null) {
  if (!input?.data) return null;
  if (!input.mimeType || !allowedScreenshotMimes.includes(input.mimeType as any)) {
    throw new Error('Print inválido. Envie apenas PNG, JPG ou WEBP.');
  }
  const cleanData = input.data.includes(',') ? input.data.split(',').pop() ?? '' : input.data;
  const buffer = Buffer.from(cleanData, 'base64');
  if (!buffer.length || buffer.length > MAX_SCREENSHOT_BYTES) {
    throw new Error('Print grande demais. Limite máximo: 2 MB.');
  }
  return { mimeType: input.mimeType, fileName: input.fileName?.slice(0, 120), data: buffer.toString('base64'), size: buffer.length };
}

export async function supportRoutes(app: FastifyInstance) {
  app.post('/support/tickets', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const body = z.object({
      category: z.enum(categories),
      title: z.string().trim().min(5).max(120),
      message: z.string().trim().min(10).max(4000),
      screen: z.string().trim().max(120).optional(),
      platform: z.string().trim().max(80).optional(),
      screenshot: z.object({ mimeType: z.string(), fileName: z.string().optional(), data: z.string() }).optional().nullable(),
    }).parse(request.body);

    const recentCount = await prisma.supportTicket.count({ where: { userId: authRequest.user.sub, createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } } });
    if (recentCount >= 5) return reply.code(429).send({ message: 'Muitos chamados em pouco tempo. Aguarde antes de enviar novamente.' });

    let screenshot: ReturnType<typeof validateScreenshot>;
    try { screenshot = validateScreenshot(body.screenshot); } catch (error) { return reply.code(400).send({ message: (error as Error).message }); }

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: authRequest.user.sub,
        category: body.category,
        title: body.title,
        message: body.message,
        screen: body.screen,
        platform: body.platform,
        userAgent: request.headers['user-agent'] ?? null,
        screenshotMimeType: screenshot?.mimeType,
        screenshotFileName: screenshot?.fileName,
        screenshotData: screenshot?.data,
        screenshotSize: screenshot?.size,
      },
    });
    return reply.code(201).send({ message: 'Chamado enviado com sucesso.', ticket: sanitizeTicket(ticket) });
  });

  app.get('/support/my-tickets', { preHandler: [app.authenticate] }, async (request) => {
    const authRequest = request as AuthRequest;
    const tickets = await prisma.supportTicket.findMany({ where: { userId: authRequest.user.sub }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { tickets: tickets.map((ticket) => sanitizeTicket(ticket)) };
  });

  app.get('/support/my-tickets/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const ticket = await prisma.supportTicket.findFirst({ where: { id, userId: authRequest.user.sub }, include: { messages: { include: { author: true }, orderBy: { createdAt: 'asc' } } } });
    if (!ticket) return reply.code(404).send({ message: 'Chamado não encontrado.' });
    return { ticket: sanitizeTicket(ticket) };
  });

  app.get('/admin/support/tickets', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    if (!ensureSupportAdmin(reply, authRequest.user.roles ?? [])) return;
    const query = z.object({ category: z.enum(categories).optional(), status: z.enum(statuses).optional(), priority: z.enum(priorities).optional() }).parse(request.query);
    const tickets = await prisma.supportTicket.findMany({
      where: { ...(query.category ? { category: query.category } : {}), ...(query.status ? { status: query.status } : {}), ...(query.priority ? { internalPriority: query.priority } : {}) },
      include: { user: true }, orderBy: { createdAt: 'desc' }, take: 300,
    });
    return { tickets: tickets.map((ticket) => sanitizeTicket(ticket, true)) };
  });

  app.get('/admin/support/tickets/export/codex', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    if (!ensureSupportAdmin(reply, authRequest.user.roles ?? [])) return;
    const tickets = await prisma.supportTicket.findMany({ include: { user: { select: { id: true, name: true, characterName: true } }, messages: true }, orderBy: { createdAt: 'desc' }, take: 1000 });
    const byCategory = new Map<string, number>(); const byStatus = new Map<string, number>();
    for (const t of tickets) { byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + 1); byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1); }
    const lines = ['# Relatório técnico de suporte — RPC Exchange', '', '## Resumo por categoria', ...Array.from(byCategory, ([k,v]) => `- ${k}: ${v}`), '', '## Resumo por status', ...Array.from(byStatus, ([k,v]) => `- ${k}: ${v}`), '', '## Chamados', ...tickets.map((t) => `- ${t.id} | ${t.category} | ${t.status} | ${t.internalPriority} | ${t.title} | tela=${t.screen ?? '-'} | plataforma=${t.platform ?? '-'} | usuário=${t.user.characterName ?? t.user.name} (${t.user.id}) | criado=${t.createdAt.toISOString()}${t.internalNote ? ` | nota interna=${t.internalNote.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`)];
    return reply.header('Content-Type', 'text/markdown; charset=utf-8').header('Content-Disposition', 'attachment; filename="rpc-support-codex-report.md"').send(lines.join('\n'));
  });

  app.get('/admin/support/tickets/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    if (!ensureSupportAdmin(reply, authRequest.user.roles ?? [])) return;
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const ticket = await prisma.supportTicket.findUnique({ where: { id }, include: { user: true, messages: { include: { author: true }, orderBy: { createdAt: 'asc' } } } });
    if (!ticket) return reply.code(404).send({ message: 'Chamado não encontrado.' });
    return { ticket: sanitizeTicket(ticket, true) };
  });

  app.patch('/admin/support/tickets/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authRequest = request as AuthRequest;
    if (!ensureSupportAdmin(reply, authRequest.user.roles ?? [])) return;
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ status: z.enum(statuses).optional(), internalPriority: z.enum(priorities).optional(), internalNote: z.string().max(4000).optional(), response: z.string().trim().min(2).max(4000).optional() }).parse(request.body);
    const previous = await prisma.supportTicket.findUnique({ where: { id } });
    if (!previous) return reply.code(404).send({ message: 'Chamado não encontrado.' });
    const updated = await prisma.$transaction(async (tx) => {
      if (body.response) await tx.supportTicketMessage.create({ data: { ticketId: id, authorId: authRequest.user.sub, message: body.response, isInternal: false } });
      const closedAt = body.status === 'CLOSED' ? new Date() : body.status ? null : undefined;
      return tx.supportTicket.update({ where: { id }, data: { status: body.status ?? (body.response ? 'ANSWERED' : undefined), internalPriority: body.internalPriority, internalNote: body.internalNote, reviewedById: authRequest.user.sub, answeredAt: body.response ? new Date() : undefined, closedAt }, include: { user: true, messages: { include: { author: true }, orderBy: { createdAt: 'asc' } } } });
    });
    await prisma.adminLog.create({ data: { userId: authRequest.user.sub, action: 'SUPPORT_TICKET_UPDATED', entity: `SupportTicket:${id}`, previous: JSON.stringify({ status: previous.status, internalPriority: previous.internalPriority }), current: JSON.stringify({ status: updated.status, internalPriority: updated.internalPriority }), reason: body.internalNote ?? body.response ?? 'Atualização de chamado', ip: request.ip, userAgent: request.headers['user-agent'] ?? null } });
    return { message: 'Chamado atualizado.', ticket: sanitizeTicket(updated, true) };
  });
}
