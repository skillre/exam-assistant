import { QUESTION_TYPE_LABEL } from '@exam/shared';
import type { QuestionDraft, QuestionType, AnswerValue } from '@exam/shared';

interface Props {
  draft: QuestionDraft;
  index: number;
  errors: string[];
  onChange: (next: QuestionDraft) => void;
  onRemove: () => void;
  tagSuggestions?: string[];
}

// v2 FR4.1/4.2/4.3：单条草稿的可编辑卡片。题干/选项/答案/题型/标签/解析均可改。
export function DraftEditor({ draft, index, errors, onChange, onRemove, tagSuggestions }: Props) {
  function patch(p: Partial<QuestionDraft>) {
    onChange({ ...draft, ...p });
  }

  // 切换题型时重置 answer 到该题型的合法初值，避免形态错位
  function changeType(type: QuestionType) {
    const answer: AnswerValue = type === 'boolean' ? true : type === 'multiple' ? [] : 0;
    patch({ type, answer });
  }

  function setOption(j: number, val: string) {
    const options = [...draft.options];
    options[j] = val;
    patch({ options });
  }
  function addOption() {
    patch({ options: [...draft.options, ''] });
  }
  function removeOption(j: number) {
    const options = draft.options.filter((_, k) => k !== j);
    // 收缩答案里越界/被删的 index
    let answer = draft.answer;
    if (draft.type === 'single' && typeof answer === 'number') {
      answer = answer >= options.length ? Math.max(0, options.length - 1) : answer;
    } else if (draft.type === 'multiple' && Array.isArray(answer)) {
      answer = answer.filter((idx) => idx !== j).map((idx) => (idx > j ? idx - 1 : idx));
    }
    patch({ options, answer });
  }

  function toggleMulti(j: number) {
    const arr = Array.isArray(draft.answer) ? [...draft.answer] : [];
    const next = arr.includes(j) ? arr.filter((x) => x !== j) : [...arr, j].sort((a, b) => a - b);
    patch({ answer: next });
  }

  return (
    <div className="list-item" style={{ cursor: 'default' }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted">#{index + 1}</span>
        <select
          value={draft.type}
          onChange={(e) => changeType(e.target.value as QuestionType)}
          style={{ width: 'auto' }}
        >
          <option value="single">{QUESTION_TYPE_LABEL.single}</option>
          <option value="multiple">{QUESTION_TYPE_LABEL.multiple}</option>
          <option value="boolean">{QUESTION_TYPE_LABEL.boolean}</option>
        </select>
        <div className="spacer" />
        <button className="btn danger" onClick={onRemove}>
          删除
        </button>
      </div>

      <label>题干</label>
      <textarea
        value={draft.stem}
        onChange={(e) => patch({ stem: e.target.value })}
        style={{ minHeight: 60 }}
      />

      {draft.type === 'boolean' ? (
        <>
          <label>正确答案</label>
          <select
            value={String(draft.answer)}
            onChange={(e) => patch({ answer: e.target.value === 'true' })}
            style={{ width: 'auto' }}
          >
            <option value="true">正确</option>
            <option value="false">错误</option>
          </select>
        </>
      ) : (
        <>
          <label>选项（勾选/选择正确答案）</label>
          {draft.options.map((o, j) => (
            <div className="row" key={j} style={{ marginBottom: 4 }}>
              {draft.type === 'single' ? (
                <input
                  type="radio"
                  name={`ans-${index}`}
                  checked={draft.answer === j}
                  onChange={() => patch({ answer: j })}
                  style={{ width: 'auto' }}
                />
              ) : (
                <input
                  type="checkbox"
                  checked={Array.isArray(draft.answer) && draft.answer.includes(j)}
                  onChange={() => toggleMulti(j)}
                  style={{ width: 'auto' }}
                />
              )}
              <span className="muted">{String.fromCharCode(65 + j)}.</span>
              <input value={o} onChange={(e) => setOption(j, e.target.value)} style={{ flex: 1 }} />
              <button className="btn ghost" onClick={() => removeOption(j)}>
                ✕
              </button>
            </div>
          ))}
          <button className="btn ghost" onClick={addOption} style={{ marginTop: 4 }}>
            + 添加选项
          </button>
        </>
      )}

      <label>知识点标签（逗号分隔）</label>
      <input
        list={`tag-suggest-${index}`}
        value={(draft.tags ?? []).join(', ')}
        onChange={(e) =>
          patch({
            tags: e.target.value
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean),
          })
        }
      />
      {tagSuggestions && tagSuggestions.length > 0 && (
        <datalist id={`tag-suggest-${index}`}>
          {tagSuggestions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      )}

      <label>解析（可选）</label>
      <textarea
        value={draft.explanation ?? ''}
        onChange={(e) => patch({ explanation: e.target.value })}
        style={{ minHeight: 48 }}
      />

      {errors.length > 0 && (
        <div className="error" style={{ marginTop: 8 }}>
          {errors.map((msg, k) => (
            <div key={k}>⚠ {msg}</div>
          ))}
        </div>
      )}
    </div>
  );
}
