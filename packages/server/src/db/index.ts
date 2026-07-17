import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { DATA_DIR, DB_PATH, SESSIONS_DIR } from '../config/paths.js';
import { SCHEMA_SQL } from './schema.js';

let dbInstance: Database.Database | undefined;

/**
 * 打开（并按需初始化）SQLite 连接。
 * - 确保 DATA_DIR / sessions 目录存在（DEC-18）
 * - 开启外键（schema 依赖 ON DELETE CASCADE，SQLite 默认关闭）
 * - 幂等建表（SCHEMA_SQL 全部 CREATE TABLE IF NOT EXISTS）
 *
 * schema 以 TS 常量内嵌（schema.ts），随 tsc 一起进 dist，
 * 避免 .sql 文件不被编译复制导致运行时读不到。
 */
export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });

  dbInstance = new Database(DB_PATH);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');

  dbInstance.exec(SCHEMA_SQL);

  return dbInstance;
}

export function closeDb(): void {
  dbInstance?.close();
  dbInstance = undefined;
}

/**
 * 懒代理：让仓储层用 `db.prepare(...)` 直接调用，首次访问时自动 getDb()。
 * 避免各仓储模块 import 时就打开数据库（副作用延迟到实际查询）。
 */
export const db: Database.Database = new Proxy({} as Database.Database, {
  get(_target, prop, receiver) {
    const real = getDb();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === 'function' ? value.bind(real) : value;
  },
});
