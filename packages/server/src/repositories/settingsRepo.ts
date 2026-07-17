import type { ActiveModelSelection } from '@exam/shared';
import { db } from '../db/index.js';

// app_settings：单实例全局键值设置（DEC-19/20）。当前激活的 provider/model 存这里。

const ACTIVE_PROVIDER = 'active_provider_id';
const ACTIVE_MODEL = 'active_model_id';

function getValue(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value = @value`,
  ).run({ key, value });
}

export const settingsRepo = {
  getActiveModel(): ActiveModelSelection | undefined {
    const providerId = getValue(ACTIVE_PROVIDER);
    const modelId = getValue(ACTIVE_MODEL);
    if (!providerId || !modelId) return undefined;
    return { providerId, modelId };
  },

  setActiveModel(sel: ActiveModelSelection): void {
    setValue(ACTIVE_PROVIDER, sel.providerId);
    setValue(ACTIVE_MODEL, sel.modelId);
  },
};
