import { randomUUID } from 'node:crypto';
import type { Provider, ProviderModel, ProviderUpsert } from '@exam/shared';
import { db } from '../db/index.js';
import { encryptSecret, decryptSecret } from '../crypto/secretBox.js';

// providers 表：DEC-19/20。api_key_enc 存 AES-GCM 密文，永不回传前端。

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api: string;
  models: string; // JSON
  api_key_enc: string;
  created_at: number;
}

/** 对外脱敏：只暴 configured，绝不含明文/密文 Key（DEC-19） */
function toPublicProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    api: row.api,
    models: JSON.parse(row.models) as ProviderModel[],
    configured: row.api_key_enc.length > 0,
    createdAt: row.created_at,
  };
}

/** 内部用：带解密后明文 Key，仅供 AiService 在内存注册 provider（DEC-21） */
export interface ProviderWithKey extends Provider {
  apiKey: string;
}

/** 模块级私有行读取（create/update 内部用；外部一律 list/listWithKeys） */
function getRow(id: string): ProviderRow | undefined {
  return db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined;
}

export const providerRepo = {
  list(): Provider[] {
    const rows = db.prepare('SELECT * FROM providers ORDER BY created_at').all() as ProviderRow[];
    return rows.map(toPublicProvider);
  },

  /** 仅后端内部使用：返回解密后的明文 Key（DEC-21 运行时注入） */
  listWithKeys(): ProviderWithKey[] {
    const rows = db.prepare('SELECT * FROM providers ORDER BY created_at').all() as ProviderRow[];
    return rows.map((row) => ({
      ...toPublicProvider(row),
      apiKey: row.api_key_enc ? decryptSecret(row.api_key_enc) : '',
    }));
  },

  create(input: ProviderUpsert): Provider {
    if (!input.apiKey) {
      throw new Error('新增 provider 必须提供 apiKey');
    }
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO providers (id, name, base_url, api, models, api_key_enc, created_at)
       VALUES (@id, @name, @base_url, @api, @models, @api_key_enc, @created_at)`,
    ).run({
      id,
      name: input.name,
      base_url: input.baseUrl,
      api: input.api,
      models: JSON.stringify(input.models ?? []),
      api_key_enc: encryptSecret(input.apiKey),
      created_at: now,
    });
    return toPublicProvider(getRow(id)!);
  },

  /** 更新：apiKey 省略则保持原 Key（DEC-19 前端编辑不回填 Key） */
  update(id: string, input: ProviderUpsert): Provider | undefined {
    const existing = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined;
    if (!existing) return undefined;
    const api_key_enc = input.apiKey ? encryptSecret(input.apiKey) : existing.api_key_enc;
    db.prepare(
      `UPDATE providers SET name = @name, base_url = @base_url, api = @api,
       models = @models, api_key_enc = @api_key_enc WHERE id = @id`,
    ).run({
      id,
      name: input.name,
      base_url: input.baseUrl,
      api: input.api,
      models: JSON.stringify(input.models ?? []),
      api_key_enc,
    });
    const row = getRow(id);
    return row ? toPublicProvider(row) : undefined;
  },

  remove(id: string): boolean {
    const info = db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    return info.changes > 0;
  },
};
