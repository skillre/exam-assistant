import { describe, it, expect, beforeAll } from 'vitest';
import { encryptSecret, decryptSecret } from './secretBox.js';

// 固定 APP_SECRET，避免依赖卷内自生成文件（测试可重复）
beforeAll(() => {
  process.env.APP_SECRET = 'test-secret-for-unit-tests';
});

describe('secretBox (AES-256-GCM, DEC-19)', () => {
  it('密文 ≠ 明文', () => {
    const plain = 'sk-1234567890abcdef';
    const enc = encryptSecret(plain);
    expect(enc).not.toContain(plain);
    expect(enc.split(':')).toHaveLength(3); // iv:tag:ciphertext
  });

  it('加密后可解密还原', () => {
    const plain = 'sk-deepseek-abcdef0123456789';
    expect(decryptSecret(encryptSecret(plain))).toBe(plain);
  });

  it('同一明文两次加密产出不同密文（随机 IV）', () => {
    const plain = 'sk-same-key';
    expect(encryptSecret(plain)).not.toBe(encryptSecret(plain));
  });

  it('空字符串可往返', () => {
    expect(decryptSecret(encryptSecret(''))).toBe('');
  });

  it('格式非法的密文抛可读错误', () => {
    expect(() => decryptSecret('not-a-valid-payload')).toThrow(/格式不合法/);
  });

  it('被篡改的密文（tag 校验失败）抛错', () => {
    const enc = encryptSecret('sk-tamper-me');
    const [iv, tag, data] = enc.split(':');
    // 篡改密文段
    const tampered = [iv, tag, Buffer.from('garbage').toString('base64')].join(':');
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
