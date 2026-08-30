/**
 * Markdown 轻量渲染器（Tutor/AI 回复用）。
 *
 * - 零依赖：纯 React 元素构建（无 innerHTML，无 XSS 面）；
 * - 块级：h1-h4 / 代码块(```) / 引用(>) / 有序·无序列表 / 分隔线(---) / 表格(
 *   | 管道式) / 段落（硬换行转 <br>，聊天友好）；
 * - 行内：**粗体**、*斜体*、~~删除线~~、`行内代码`、[文字](https://链接)；
 * - 宽容解析：未闭合标记按原文显示（流式增量渲染不闪烁）；
 * - 样式由 .exam-assistant-md 容器承载（见 styles.css）。
 */

import { Fragment, createElement, type ReactNode, type ReactElement } from 'react';

/** 是否块级起始行（用于段落收集终止判断）。 */
function isBlockStart(trimmed: string): boolean {
  if (trimmed.startsWith('```')) return true;
  if (trimmed.startsWith('>')) return true;
  if (/^(#{1,4})\s+/.test(trimmed)) return true;
  if (/^(\d+)[.)]\s+/.test(trimmed)) return true;
  if (/^[-*+]\s+/.test(trimmed)) return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return true;
  return false;
}

/** 表格行拆分（去掉首尾 |，按 | 分列并 trim）。 */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** 行内解析：**b**、*i*、~~d~~、`code`、[label](url)。返回 React 节点数组。 */
function renderInlineNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buffer = '';
  let i = 0;
  let key = 0;
  const flush = () => {
    if (buffer.length > 0) nodes.push(buffer);
    buffer = '';
  };
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        flush();
        nodes.push(<code key={key++}>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    } else if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i + 1) {
        flush();
        nodes.push(<strong key={key++}>{renderInlineNodes(text.slice(i + 2, end))}</strong>);
        i = end + 2;
        continue;
      }
    } else if (text.startsWith('~~', i)) {
      const end = text.indexOf('~~', i + 2);
      if (end > i + 1) {
        flush();
        nodes.push(<del key={key++}>{renderInlineNodes(text.slice(i + 2, end))}</del>);
        i = end + 2;
        continue;
      }
    } else if (text[i] === '*') {
      const end = text.indexOf('*', i + 1);
      if (end > i) {
        flush();
        nodes.push(<em key={key++}>{renderInlineNodes(text.slice(i + 1, end))}</em>);
        i = end + 1;
        continue;
      }
    } else if (text[i] === '[') {
      const bracket = text.indexOf(']', i + 1);
      if (bracket > i && text[bracket + 1] === '(') {
        const paren = text.indexOf(')', bracket + 2);
        if (paren > bracket + 1) {
          const href = text.slice(bracket + 2, paren).trim();
          if (/^https?:\/\//i.test(href)) {
            flush();
            nodes.push(
              <a key={key++} href={href} target="_blank" rel="noopener noreferrer">
                {renderInlineNodes(text.slice(i + 1, bracket))}
              </a>,
            );
            i = paren + 1;
            continue;
          }
        }
      }
    }
    buffer += text[i];
    i += 1;
  }
  flush();
  return nodes;
}

/** 块级解析（基于行）；段落内硬换行 → <br>。 */
function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '') {
      i += 1;
      continue;
    }

    // 代码块（``` 或 ```lang 起止）
    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // 跳过结束围栏
      out.push(
        <pre key={key++} className="exam-assistant-md__code">
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = (heading[1] ?? '').length;
      out.push(createElement(`h${level}`, { key: key++ }, renderInlineNodes(heading[2] ?? '')));
      i += 1;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push(<hr key={key++} />);
      i += 1;
      continue;
    }

    // 管道表格：当前行含 |、下一行为纯分隔行（- 与 : ）
    const nextTrim = i + 1 < lines.length ? (lines[i + 1] ?? '').trim() : '';
    if (trimmed.includes('|') && /^\|?[\s:|-]+$/.test(nextTrim) && nextTrim.includes('-')) {
      const header = splitTableRow(trimmed);
      if (header.length > 1) {
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && (lines[i] ?? '').includes('|')) {
          rows.push(splitTableRow(lines[i] ?? ''));
          i += 1;
        }
        out.push(
          <table key={key++}>
            <thead>
              <tr>
                {header.map((cell, ci) => (
                  <th key={ci}>{renderInlineNodes(cell)}</th>
                ))}
              </tr>
            </thead>
            {rows.length > 0 ? (
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri}>
                    {header.map((_, ci) => (
                      <td key={ci}>{renderInlineNodes(row[ci] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ) : null}
          </table>,
        );
        continue;
      }
    }

    // 有序列表（连续行）
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const m = /^(\d+)[.)]\s+(.*)$/.exec((lines[i] ?? '').trim());
        if (m === null) break;
        items.push(<li key={items.length}>{renderInlineNodes(m[2] ?? '')}</li>);
        i += 1;
      }
      out.push(<ol key={key++}>{items}</ol>);
      continue;
    }

    // 无序列表（连续行）
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const m = /^[-*+]\s+(.*)$/.exec((lines[i] ?? '').trim());
        if (m === null) break;
        items.push(<li key={items.length}>{renderInlineNodes(m[1] ?? '')}</li>);
        i += 1;
      }
      out.push(<ul key={key++}>{items}</ul>);
      continue;
    }

    // 块引用（连续 > 行）
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        quoteLines.push((lines[i] ?? '').trim().replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(
        <blockquote key={key++}>
          {quoteLines.map((line, qi) => (
            <p key={qi}>{renderInlineNodes(line)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    // 段落：收集至空行或下一块级起点
    const para: string[] = [trimmed];
    i += 1;
    while (i < lines.length) {
      const t = (lines[i] ?? '').trim();
      if (
        t === '' ||
        isBlockStart(t) ||
        (t.includes('|') && i + 1 < lines.length && /^\|?[\s:|-]+$/.test((lines[i + 1] ?? '').trim()))
      )
        break;
      para.push(t);
      i += 1;
    }
    out.push(
      <p key={key++}>
        {para.map((line, li) => (
          <Fragment key={li}>
            {li > 0 ? <br /> : null}
            {renderInlineNodes(line)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}

/** Markdown 内容渲染组件（安全；仅用于 assistant 回复纯文本内容）。 */
export function MarkdownContent({ content }: { content: string }): ReactElement {
  return <div className="exam-assistant-md">{renderBlocks(content)}</div>;
}
