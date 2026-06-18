import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { normalizeRegistrationProof } from '../services/registration-proof-service.js';

 type AuthRequest = FastifyRequest & { user: { sub: string; roles?: string[] } };

export async function userRoutes(app: FastifyInstance) {
  app.get('/me', { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const authRequest = request as AuthRequest;
    const userId = authRequest.user.sub;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { wallet: true, roles: { include: { role: true } }, financialPermissions: true },
    });

    if (!user) return reply.code(404).send({ message: 'Usuário não encontrado.' });

    return {
      id: user.id,
      name: user.name,
      discordId: user.discordId,
      characterPhone: user.characterPhone,
      approvalStatus: user.approvalStatus,
      approvalNote: user.approvalNote,
      roles: user.roles.map((item: { role: { key: string } }) => item.role.key),
      financialPermissions: user.financialPermissions.filter((permission) => !permission.revokedAt).map((permission) => permission.permission),
      wallet: user.wallet,
    };
  });

  app.get('/registration/status', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = (request as AuthRequest).user.sub;
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { registrationProof: true, financialPermissions: true } });
    if (!user) return reply.code(404).send({ message: 'Usuário não encontrado.' });
    return { status: user.approvalStatus, note: user.approvalNote, hasScreenshot: Boolean(user.registrationProof), screenshotUpdatedAt: user.registrationProof?.updatedAt ?? null, financialPermissions: user.financialPermissions.filter((p) => !p.revokedAt).map((p) => p.permission) };
  });

  app.put('/registration/screenshot', { preHandler: [app.authenticate], config: { rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const userId = (request as AuthRequest).user.sub;
    const body = z.object({ screenshot: z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), fileName: z.string().optional(), data: z.string().min(20) }) }).parse(request.body);
    const normalizedProof = normalizeRegistrationProof(body.screenshot);
    const proof = await prisma.registrationProof.upsert({
      where: { userId },
      update: { mimeType: normalizedProof.mimeType, fileName: normalizedProof.fileName, data: normalizedProof.data, checksum: normalizedProof.checksum },
      create: { userId, mimeType: normalizedProof.mimeType, fileName: normalizedProof.fileName, data: normalizedProof.data, checksum: normalizedProof.checksum },
    });
    await prisma.user.update({ where: { id: userId }, data: { approvalStatus: 'PENDING', approvalNote: null } });
    await prisma.adminLog.create({ data: { userId, action: 'REGISTRATION_SCREENSHOT_RESUBMITTED', entity: `RegistrationProof:${proof.id}`, reason: 'Usuário reenviou screenshot de cadastro.', ip: request.ip, userAgent: request.headers['user-agent'] ?? null } });
    return { message: 'Screenshot reenviado para nova análise.', proof: { id: proof.id, updatedAt: proof.updatedAt, checksum: proof.checksum } };
  });
}
