import { describe, it, expect } from 'vitest';
import { csvCell, toCsv, exportFilename } from './csv.js';

// 第四批 ①：CSV 生成（RFC4180 转义）单测。

describe('csvCell（RFC4180 转义）', () => {
  it('普通字段原样输出', () => {
    expect(csvCell('hello')).toBe('hello');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('含逗号的字段加引号', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  it('含双引号的字段加引号且引号翻倍', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('含换行的字段加引号（\\n 与 \\r\\n）', () => {
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('a\r\nb')).toBe('"a\r\nb"');
  });

  it('含回车单独出现也转义', () => {
    expect(csvCell('a\rb')).toBe('"a\rb"');
  });
});

describe('toCsv（多行 + BOM）', () => {
  it('输出带 UTF-8 BOM 头，行以 CRLF 分隔', () => {
    const out = toCsv([['type', 'stem'], ['single', '1+1=?']]);
    expect(out.startsWith('\uFEFF')).toBe(true);
    expect(out).toBe('\uFEFFtype,stem\r\nsingle,1+1=?\r\n');
  });

  it('混合转义：表头 + 含逗号/引号/换行的数据行', () => {
    const out = toCsv([
      ['type', 'stem', 'explanation'],
      ['multiple', 'a,b', '他说"你好"\n换行'],
    ]);
    expect(out).toContain('"a,b"');
    expect(out).toContain('"他说""你好""\n换行"');
  });
});

describe('exportFilename', () => {
  it('格式 exam-{prefix}-YYYYMMDD.csv', () => {
    const d = new Date(2026, 7, 12); // 2026-08-12
    expect(exportFilename('wrong', d)).toBe('exam-wrong-20260812.csv');
    expect(exportFilename('TOGAF', d)).toBe('exam-TOGAF-20260812.csv');
  });
});
