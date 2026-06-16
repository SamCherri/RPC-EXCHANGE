import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export type EvidenceInput = {
  dataBase64: string;
  mimeType: string;
  fileName?: string;
};

function getMaxEvidenceBytes() {
  const parsed = Number(process.env.REGISTRATION_EVIDENCE_MAX_BYTES ?? DEFAULT_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

function sanitizeFileName(fileName?: string) {
  const fallback = 'suncity-comprovante';
  if (!fileName) return fallback;
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || fallback;
}

function detectMime(buffer: Buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

export function parseAndValidateEvidence(input: EvidenceInput) {
  const mimeType = input.mimeType.trim().toLowerCase();
  if (!ALLOWED_MIME.has(mimeType)) throw new Error('Comprovante deve ser PNG, JPEG ou WEBP.');

  const cleanBase64 = input.dataBase64.includes(',') ? input.dataBase64.split(',').pop() ?? '' : input.dataBase64;
  const buffer = Buffer.from(cleanBase64, 'base64');
  if (!buffer.length) throw new Error('Comprovante é obrigatório.');
  if (buffer.length > getMaxEvidenceBytes()) throw new Error('Comprovante excede o tamanho máximo permitido.');

  const realMime = detectMime(buffer);
  if (realMime !== mimeType) throw new Error('Tipo real do arquivo não confere com o MIME informado.');

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { buffer, mimeType, sha256, fileName: sanitizeFileName(input.fileName), sizeBytes: buffer.length };
}

export async function replaceActiveRegistrationEvidence(userId: string, input: EvidenceInput, tx: any = prisma) {
  const parsed = parseAndValidateEvidence(input);
  const storageKey = `registration/${userId}/${parsed.sha256}`;

  await tx.registrationEvidence.updateMany({
    where: { userId, status: 'ACTIVE' },
    data: { status: 'REPLACED', replacedAt: new Date() },
  });

  return tx.registrationEvidence.create({
    data: {
      userId,
      storageKey,
      originalFileName: parsed.fileName,
      mimeType: parsed.mimeType,
      sizeBytes: parsed.sizeBytes,
      sha256: parsed.sha256,
      content: parsed.buffer,
      status: 'ACTIVE',
    },
  });
}
