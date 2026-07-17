import { useState } from 'react';
import type { QuestionDraft } from '@exam/shared';
import { api } from '../api/client.js';

// 导入页：粘贴文本（AI 解析）或上传文件 → 预览草稿 → 提交到新题库。
export function ImportPage() {
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState<QuestionDraft[]>([]);
  const [bankName, setBankName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function parseText() {
    if (!text.trim()) return;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const r = await api.parseText(text);
      setDrafts(r.questions);
      if (r.questions.length === 0) setError('没有解析出题目，换个格式再试');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function parseFile(file: File) {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const r = await api.parseFile(file);
      setDrafts(r.questions);
      if (r.questions.length === 0) setError('文件里没有解析出题目');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function commit() {
    if (drafts.length === 0) return;
    setLoading(true);
    setError('');
    try {
      const r = await api.commitImport({
        bankName: bankName.trim() || `导入 ${new Date().toLocaleString()}`,
        questions: drafts,
      });
      setNotice(`已导入 ${r.count} 道题到题库`);
      setDrafts([]);
      setText('');
      setBankName('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1>导入题目</h1>
      {error && <div className="error">⚠ {error}</div>}
      {notice && <div className="ok">{notice}</div>}

      <div className="card">
        <h2>粘贴文本（AI 解析）</h2>
        <textarea
          placeholder="把题目粘贴进来，AI 会自动识别题干、选项、答案…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={parseText} disabled={loading || !text.trim()}>
            {loading ? '解析中…' : '解析文本'}
          </button>
          <span className="spacer" />
          <label className="btn ghost" style={{ margin: 0 }}>
            上传文件
            <input
              type="file"
              style={{ display: 'none' }}
              onChange={(e) => e.target.files?.[0] && parseFile(e.target.files[0])}
            />
          </label>
        </div>
      </div>

      {drafts.length > 0 && (
        <div className="card">
          <h2>预览（{drafts.length} 道题）</h2>
          {drafts.map((d, i) => (
            <div key={i} className="list-item" style={{ cursor: 'default' }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="badge">
                  {d.type === 'single' ? '单选' : d.type === 'multiple' ? '多选' : '判断'}
                </span>
                {d.tags?.map((t) => (
                  <span key={t} className="badge">{t}</span>
                ))}
              </div>
              <div>{d.stem}</div>
              {d.type !== 'boolean' && (
                <ol type="A" className="muted" style={{ margin: '6px 0 0' }}>
                  {d.options.map((o, j) => (
                    <li key={j}>{o}</li>
                  ))}
                </ol>
              )}
            </div>
          ))}
          <label>题库名称</label>
          <input
            value={bankName}
            onChange={(e) => setBankName(e.target.value)}
            placeholder="留空则用时间戳命名"
          />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={commit} disabled={loading}>
              确认导入
            </button>
            <button className="btn ghost" onClick={() => setDrafts([])} disabled={loading}>
              放弃
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
