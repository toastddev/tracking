import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

function loadKey(): Buffer {
  const raw = process.env.GOOGLE_ADS_TOKEN_ENC_KEY;
  if (!raw) throw new Error('GOOGLE_ADS_TOKEN_ENC_KEY is not configured');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`GOOGLE_ADS_TOKEN_ENC_KEY must be ${KEY_BYTES} bytes (base64-encoded)`);
  }
  return key;
}

export function encryptSecret(plaintext: string): EncryptedBlob {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptSecret(blob: EncryptedBlob): string {
  const key = loadKey();
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString('utf8');
}
