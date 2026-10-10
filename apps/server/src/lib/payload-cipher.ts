import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for buyer content at rest (job_payloads, ADR 0010). Blob layout: nonce(12) ‖ ciphertext ‖
 * tag(16), matching the job_payloads.ciphertext CHECK (at least 28 bytes). The associated data binds a
 * blob to its job and kind, so a row copied onto another job does not decrypt.
 *
 * SKELETON(S12): one key from the environment; key rotation (several key ids) and the retention module
 * replace this.
 */
export interface PayloadCipher {
  readonly keyId: string;
  seal(plaintext: Uint8Array, aad: string): Buffer;
  open(blob: Uint8Array, aad: string): Buffer;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class PayloadCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadCipherError';
  }
}

export function payloadAad(jobId: string, kind: string): string {
  return `spareon-payload-v1\n${jobId}\n${kind}`;
}

export function createPayloadCipher(keyHex: string, keyId: string): PayloadCipher {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new PayloadCipherError('key must be 64 lowercase hex');
  const key = Buffer.from(keyHex, 'hex');
  return {
    keyId,
    seal(plaintext, aad) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([nonce, body, cipher.getAuthTag()]);
    },
    open(blob, aad) {
      const buf = Buffer.from(blob);
      if (buf.length < NONCE_BYTES + TAG_BYTES)
        throw new PayloadCipherError('ciphertext too short');
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, NONCE_BYTES));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
      try {
        return Buffer.concat([
          decipher.update(buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES)),
          decipher.final(),
        ]);
      } catch {
        // Never include the blob or the key in the message.
        throw new PayloadCipherError('ciphertext failed authentication');
      }
    },
  };
}
