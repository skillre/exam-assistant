import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// 轻量 Markdown 渲染：marked 转 HTML，DOMPurify 消毒后注入。
// 用于 AI 讲解/答疑等富文本，流式增量也可安全渲染（每次 content 变化重算）。
marked.setOptions({ breaks: true, gfm: true });

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text ?? '', { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);

  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
