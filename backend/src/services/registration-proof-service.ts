import { createHash } from 'node:crypto';

export const REGISTRATION_PROOF_MAX_BYTES = 5 * 1024 * 1024;
export const REGISTRATION_PROOF_ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type RegistrationProofMimeType = typeof REGISTRATION_PROOF_ALLOWED_MIME_TYPES[number];

export type RegistrationProofInput = {
  mimeType: string;
  fileName?: string;
  data: string;
};

export type NormalizedRegistrationProof = {
  mimeType: RegistrationProofMimeType;
  fileName?: string;
  data: string;
  checksum: string;
  sizeBytes: number;
};

const DATA_URL_PATTERN = /^data:([^;,]+);base64,/i;
const BASE64_CHARS_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_BASE64_LENGTH = Math.ceil(REGISTRATION_PROOF_MAX_BYTES / 3) * 4;

function sanitizeFileName(fileName?: string) {
  if (!fileName) return undefined;
  const sanitized = fileName.replace(/[\\/\0\r\n\t]/g, '_').trim().slice(0, 120);
  return sanitized || undefined;
}

function isAllowedMimeType(mimeType: string): mimeType is RegistrationProofMimeType {
  return (REGISTRATION_PROOF_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

function detectMimeType(buffer: Buffer): RegistrationProofMimeType | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

export function normalizeRegistrationProof(input: RegistrationProofInput): NormalizedRegistrationProof {
  const declaredMimeType = input.mimeType.trim().toLowerCase();
  if (!isAllowedMimeType(declaredMimeType)) {
    throw new Error('Formato de screenshot não permitido. Envie PNG, JPG ou WEBP.');
  }

  if (typeof input.data !== 'string' || input.data.trim().length === 0) {
    throw new Error('Screenshot vazio ou inválido.');
  }

  const trimmedData = input.data.trim();
  const dataUrlMatch = trimmedData.match(DATA_URL_PATTERN);
  if (dataUrlMatch) {
    const dataUrlMime = dataUrlMatch[1]?.toLowerCase();
    if (dataUrlMime !== declaredMimeType) {
      throw new Error('MIME declarado não confere com o screenshot enviado.');
    }
  }

  const base64Data = dataUrlMatch ? trimmedData.slice(dataUrlMatch[0].length) : trimmedData;
  const compactBase64 = base64Data.replace(/\s/g, '');

  if (compactBase64.length === 0) {
    throw new Error('Screenshot vazio ou inválido.');
  }

  if (compactBase64.length > MAX_BASE64_LENGTH) {
    throw new Error(`Screenshot excede o limite de ${REGISTRATION_PROOF_MAX_BYTES / 1024 / 1024} MB.`);
  }

  if (compactBase64.length % 4 !== 0 || !BASE64_CHARS_PATTERN.test(compactBase64)) {
    throw new Error('Screenshot precisa estar em Base64 válido.');
  }

  const buffer = Buffer.from(compactBase64, 'base64');
  if (buffer.length === 0) {
    throw new Error('Screenshot vazio ou inválido.');
  }

  if (buffer.length > REGISTRATION_PROOF_MAX_BYTES) {
    throw new Error(`Screenshot excede o limite de ${REGISTRATION_PROOF_MAX_BYTES / 1024 / 1024} MB.`);
  }

  const detectedMimeType = detectMimeType(buffer);
  if (!detectedMimeType) {
    throw new Error('Conteúdo do screenshot não foi reconhecido como PNG, JPG ou WEBP.');
  }

  if (detectedMimeType !== declaredMimeType) {
    throw new Error('MIME declarado não confere com o conteúdo real do screenshot.');
  }

  return {
    mimeType: detectedMimeType,
    fileName: sanitizeFileName(input.fileName),
    data: compactBase64,
    checksum: createHash('sha256').update(buffer).digest('hex'),
    sizeBytes: buffer.length,
  };
}

export function decodeStoredRegistrationProof(data: string) {
  return Buffer.from(data, 'base64');
}
