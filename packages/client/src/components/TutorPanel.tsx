import { useEffect, useRef, useState } from 'react';
import { streamSse } from '../api/sse.js';
import { api } from '../api/client.js';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  questionId: string;
  // explain 需要 attemptId 关联作答；错题本复看历史时可不传
  attemptId?: string;
  // 是否自动拉取已有历史（错题本进入时 true）
  autoLoadHistory?: boolean;
}

// AI 讲解 + 多轮答疑面板（SSE 流式渲染）。
export function TutorPanel({ questionId, attemptId, autoLoadHistory }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState(''); // 当前流式增量缓冲
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [hasSession, setHasSession] = useState(false);
  const liveRef = useRef('');

  useEffect(() => {
    if (!autoLoadHistory) return;
    api
      .tutorHistory(questionId)
      .then((h) => {
        if (h.messages.length > 0) {
          setTurns(h.messages);
          setHasSession(true);
        }
      })
      .catch(() => {/* 无历史忽略 */});
  }, [questionId, autoLoadHistory]);

  function runStream(url: string, body: unknown, userEcho?: string) {
    setError('');
    setStreaming(true);
    setLive('');
    liveRef.current = '';
    if (userEcho) setTurns((t) => [...t, { role: 'user', content: userEcho }]);

    streamSse(url, body, {
      onDelta: (text) => {
        liveRef.current += text;
        setLive(liveRef.current);
      },
      onDone: () => {
        setTurns((t) => [...t, { role: 'assistant', content: liveRef.current }]);
        setLive('');
        setStreaming(false);
        setHasSession(true);
      },
      onError: (msg) => {
        setError(msg);
        setLive('');
        setStreaming(false);
      },
    });
  }

  function explain() {
    if (!attemptId) {
      setError('无作答记录，无法讲解');
      return;
    }
    runStream('/api/tutor/explain', { questionId, attemptId });
  }

  function ask() {
    const msg = input.trim();
    if (!msg) return;
    setInput('');
    runStream('/api/tutor/ask', { questionId, message: msg }, msg);
  }

  return (
    <div className="card">
      <h2>AI 讲解与答疑</h2>

      {turns.length === 0 && !streaming && !hasSession && (
        <button className="btn" onClick={explain} disabled={streaming || !attemptId}>
          请老师讲解这道题
        </button>
      )}

      {turns.map((t, i) => (
        <div key={i} className="tutor">
          <strong className={t.role === 'user' ? '' : 'ok'}>
            {t.role === 'user' ? '我：' : '老师：'}
          </strong>
          {t.content}
        </div>
      ))}

      {streaming && (
        <div className="tutor">
          <strong className="ok">老师：</strong>
          {live || <span className="muted">思考中…</span>}
        </div>
      )}

      {error && <div className="error" style={{ marginTop: 10 }}>⚠ {error}</div>}

      {(hasSession || turns.length > 0) && (
        <div className="row" style={{ marginTop: 12 }}>
          <input
            placeholder="继续追问，如：为什么不能选 B？"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !streaming && ask()}
            disabled={streaming}
            style={{ flex: 1 }}
          />
          <button className="btn" onClick={ask} disabled={streaming || !input.trim()}>
            追问
          </button>
        </div>
      )}
    </div>
  );
}
