import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR } from '../config/paths.js';

// AES-256-GCM 对称加密 provider API Key（DEC-19）。
// 密钥源：APP_SECRET 环境变量；缺省时首启在卷内生成并持久化，
// 使容器重建后仍能解密既有密文。

const SECRET_FILE = resolve(DATA_DIR, '.app_secret');
const ALGO = 'aes-256-gcm';

function loadOrCreateSecret(): string {
  const fromEnv = process.env.APP_SECRET?.trim();
  if (fromEnv) return fromEnv;

  if (existsSync(SECRET_FILE)) {
    return readFileSync(SECRET_FILE, 'utf8').trim();
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const generated = randomBytes(32).toString('hex');
  writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
  return generated;
}

let key: Buffer | undefined;
function getKey(): Buffer {
  if (!key) {
    // scrypt 把任意长度 secret 派生成 32 字节密钥
    key = scryptSync(loadOrCreateSecret(), 'exam-assistant-provider-key', 32);
  }
  return key;
}

/** 加密明文 Key → "iv:tag:ciphertext"（均 base64） */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/** 解密 "iv:tag:ciphertext" → 明文 Key。密文损坏或 secret 变更时抛错。 */
export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('provider key 密文格式不合法');
  }
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
