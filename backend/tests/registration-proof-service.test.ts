import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegistrationProof, REGISTRATION_PROOF_MAX_BYTES } from '../src/services/registration-proof-service.js';

const VALID_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

test('normalizeRegistrationProof aceita PNG válido e remove prefixo Data URL', () => {
  const proof = normalizeRegistrationProof({ mimeType: 'image/png', fileName: '../cadastro.png', data: `data:image/png;base64,${VALID_PNG_BASE64}` });
  assert.equal(proof.mimeType, 'image/png');
  assert.equal(proof.data, VALID_PNG_BASE64);
  assert.equal(proof.fileName, '.._cadastro.png');
  assert.ok(proof.checksum);
  assert.ok(proof.sizeBytes > 0);
});

test('normalizeRegistrationProof rejeita payload acima do limite', () => {
  const oversized = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(REGISTRATION_PROOF_MAX_BYTES + 1)]).toString('base64');
  assert.throws(() => normalizeRegistrationProof({ mimeType: 'image/png', fileName: 'big.png', data: oversized }), /limite/);
});

test('normalizeRegistrationProof rejeita MIME falso, conteúdo inválido e arquivo vazio', () => {
  assert.throws(() => normalizeRegistrationProof({ mimeType: 'image/jpeg', fileName: 'fake.jpg', data: `data:image/jpeg;base64,${VALID_PNG_BASE64}` }), /MIME declarado/);
  assert.throws(() => normalizeRegistrationProof({ mimeType: 'image/png', fileName: 'text.png', data: Buffer.from('texto').toString('base64') }), /não foi reconhecido/);
  assert.throws(() => normalizeRegistrationProof({ mimeType: 'image/png', fileName: 'empty.png', data: 'data:image/png;base64,' }), /vazio/);
});
