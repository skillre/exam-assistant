import { resolve } from 'node:path';

/**
 * 数据基路径（DEC-18）。容器内默认 /app/data，本地开发可用 DATA_DIR 覆盖。
 * 所有落盘位置（SQLite、答疑 JSONL 会话）都从此派生，不硬编码相对路径。
 */
export const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(process.cwd(), 'data');

export const DB_PATH = resolve(DATA_DIR, 'app.db');
export const SESSIONS_DIR = resolve(DATA_DIR, 'sessions');
