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

  // 下载结构化导入的 CSV 模板（列约定与后端 parseFile 一致）
  function downloadTemplate() {
    const rows = [
      'type,stem,options,answer,explanation,tags',
      'single,地球的卫星是？,月球|火星|金星,0,月球是地球唯一天然卫星,天文',
      'multiple,以下属于编程语言的有？,Python|HTML|Java|CSS,0|2,HTML/CSS 是标记与样式,编程',
      'boolean,地球是平的。,正确|错误,false,地球是球体,常识',
    ].join('\n');
    const blob = new Blob(['\uFEFF' + rows], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '题库导入模板.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>导入题目</h1>
      {error && <div className="error">⚠ {error}</div>}
      {notice && <div className="ok">{notice}</div>}

      <div className="card">
        <h2>怎么导入？</h2>
        <p className="muted" style={{ lineHeight: 1.8, margin: '4px 0 0' }}>
          两种方式，选任一种即可：
        </p>
        <ul className="muted" style={{ lineHeight: 1.8, margin: '6px 0 0', paddingLeft: 20 }}>
          <li>
            <strong>直接拖个文件进来</strong>（推荐）：支持 <code>.txt / .md / .docx</code> 文档 ——
            里面就是平时的题目文字（含题干、选项、答案），AI 会自动识别成结构化题目。
            也支持 <code>.csv / .xlsx / .json</code> 这种已排好列的表格。
          </li>
          <li>
            <strong>或直接粘贴文字</strong>：把题目复制到下方框里，点“解析文本”。
          </li>
        </ul>
        <p className="muted" style={{ margin: '10px 0 0' }}>
          不拘格式：带题号、ABCD 选项、“答案：B”都能认。解析后会先预览再入库。
          <span className="spacer" />
          <a href="#" onClick={(e) => { e.preventDefault(); downloadTemplate(); }}>
            下载表格模板 (CSV)
          </a>
        </p>
      </div>

      <div className="card">
        <h2>上传文件或粘贴文本</h2>
        <label className="btn" style={{ margin: '0 0 12px' }}>
          选择文件（txt / md / docx / csv / xlsx / json）
          <input
            type="file"
            accept=".txt,.md,.markdown,.docx,.csv,.xlsx,.xls,.json"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && parseFile(e.target.files[0])}
          />
        </label>
        <textarea
          placeholder="…或把题目直接粘贴到这里，AI 会自动识别题干、选项、答案…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={parseText} disabled={loading || !text.trim()}>
            {loading ? '解析中…' : '解析文本'}
          </button>
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
