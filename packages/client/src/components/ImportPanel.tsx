import { useEffect, useState } from 'react';
import type { QuestionDraft } from '@exam/shared';
import { api } from '../api/client.js';
import { DraftEditor } from './DraftEditor.js';

// 前端即时校验：与后端 questionSchema 同口径，用于入库前拦截
function localIssues(d: QuestionDraft): string[] {
  const errs: string[] = [];
  if (!d.stem.trim()) errs.push('题干不能为空');
  if (d.type === 'boolean') {
    if (typeof d.answer !== 'boolean') errs.push('判断题答案必须是正确/错误');
    return errs;
  }
  if (d.options.length < 2) errs.push('至少要有 2 个选项');
  if (d.options.some((o) => !o.trim())) errs.push('存在空选项');
  if (d.type === 'single') {
    if (typeof d.answer !== 'number' || d.answer < 0 || d.answer >= d.options.length)
      errs.push('单选答案越界');
  } else if (d.type === 'multiple') {
    if (!Array.isArray(d.answer) || d.answer.length === 0) errs.push('多选至少选一个答案');
    else if (d.answer.some((n) => n < 0 || n >= d.options.length)) errs.push('多选答案含越界项');
  }
  return errs;
}

function emptyDraft(): QuestionDraft {
  return { type: 'single', stem: '', options: ['', ''], answer: 0, tags: [], source: 'file' };
}

interface Props {
  // 追加模式：传入目标题库 id（入库到已有库）；不传则新建库模式（用 bankName）
  targetBankId?: string;
  targetBankName?: string;
  // 入库成功回调（count = 本次入库题数）
  onImported?: (count: number) => void;
}

// 可复用导入面板：拖拽/选择文件（AI 解析或结构化）或粘贴文本 → 预览可编辑草稿 → 入库。
// 新建库模式带题库名输入；追加模式直接入库到 targetBankId。
export function ImportPanel({ targetBankId, targetBankName, onImported }: Props) {
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState<QuestionDraft[]>([]);
  const [bankName, setBankName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);

  const appendMode = !!targetBankId;

  useEffect(() => {
    api.listTags().then(setTagSuggestions).catch(() => {});
  }, []);

  const invalidCount = drafts.filter((d) => localIssues(d).length > 0).length;

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
    setDrafts([]);
    try {
      const r = await api.parseFile(file);
      setDrafts(r.questions);
      if (r.questions.length === 0) setError('文件里没有解析出题目，换个文件或格式再试');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function updateDraft(i: number, nd: QuestionDraft) {
    setDrafts((ds) => ds.map((d, j) => (j === i ? nd : d)));
  }
  function removeDraft(i: number) {
    setDrafts((ds) => ds.filter((_, j) => j !== i));
  }
  function addDraft() {
    setDrafts((ds) => [...ds, emptyDraft()]);
  }

  async function commit() {
    if (drafts.length === 0 || invalidCount > 0) return;
    setLoading(true);
    setError('');
    try {
      const r = await api.commitImport(
        appendMode
          ? { bankId: targetBankId, questions: drafts }
          : { bankName: bankName.trim() || `导入 ${new Date().toLocaleString()}`, questions: drafts },
      );
      setNotice(`已导入 ${r.count} 道题${appendMode ? '到本题库' : '到新题库'}`);
      setDrafts([]);
      setText('');
      setBankName('');
      onImported?.(r.count);
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
      {error && <div className="error">⚠ {error}</div>}
      {notice && <div className="ok">{notice}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>怎么导入？</h3>
        <p className="muted" style={{ lineHeight: 1.8, margin: '4px 0 0' }}>
          {appendMode ? (
            <>解析出的题目会<strong>追加到当前题库</strong>「{targetBankName}」。两种方式，选任一种：</>
          ) : (
            <>两种方式，选任一种即可：</>
          )}
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
        <h3 style={{ marginTop: 0 }}>方式一：上传文件</h3>
        <label
          className={`dropzone${dragOver ? ' over' : ''}${loading ? ' disabled' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!loading) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (loading) return;
            const f = e.dataTransfer.files?.[0];
            if (f) parseFile(f);
          }}
        >
          <input
            type="file"
            accept=".txt,.md,.markdown,.docx,.csv,.xlsx,.xls,.json"
            style={{ display: 'none' }}
            disabled={loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ''; // 重置，否则再选同一文件不触发 onChange
              if (f) parseFile(f);
            }}
          />
          {loading ? (
            <div className="muted">处理中…（文档需 AI 识别，请稍候）</div>
          ) : (
            <>
              <div style={{ fontSize: 28, marginBottom: 6 }}>📄</div>
              <div><strong>把文件拖到这里</strong>，或<strong>点此选择</strong></div>
              <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
                支持 txt / md / docx / csv / xlsx / json
              </div>
            </>
          )}
        </label>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>方式二：粘贴文本</h3>
        <textarea
          placeholder="把题目文字直接粘贴到这里（含题干、选项、答案），AI 会自动识别…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={loading}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={parseText} disabled={loading || !text.trim()}>
            {loading ? '解析中…' : '解析文本'}
          </button>
        </div>
      </div>

      {drafts.length > 0 && (
        <div className="card">
          <div className="row">
            <h3 style={{ margin: 0 }}>预览与编辑（{drafts.length} 道题）</h3>
            <div className="spacer" />
            <button className="btn ghost" onClick={addDraft} disabled={loading}>
              + 新增一题
            </button>
          </div>
          <p className="muted" style={{ margin: '6px 0 12px' }}>
            入库前可逐题编辑题干、选项、答案、题型与标签，红色提示为校验未通过项。
          </p>

          {drafts.map((d, i) => (
            <DraftEditor
              key={i}
              index={i}
              draft={d}
              errors={localIssues(d)}
              onChange={(nd) => updateDraft(i, nd)}
              onRemove={() => removeDraft(i)}
              tagSuggestions={tagSuggestions}
            />
          ))}

          {!appendMode && (
            <>
              <label>题库名称</label>
              <input
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="留空则用时间戳命名"
              />
            </>
          )}
          {invalidCount > 0 && (
            <div className="error" style={{ marginTop: 8 }}>
              还有 {invalidCount} 道题未通过校验，修正后才能入库。
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={commit} disabled={loading || invalidCount > 0}>
              {appendMode ? '确认导入到本库' : '确认导入'}
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
