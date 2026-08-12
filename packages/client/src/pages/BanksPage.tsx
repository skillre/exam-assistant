import { useCallback, useEffect, useMemo, useState } from 'react';
import { QUESTION_TYPE_LABEL } from '@exam/shared';
import type { BankWithCount, Question, QuestionDraft } from '@exam/shared';
import { api } from '../api/client.js';
import { useFlashNotice } from '../utils.js';
import { DraftEditor } from '../components/DraftEditor.js';
import { ImportPanel } from '../components/ImportPanel.js';

// v2 题库管理：列表（新建/重命名/删除/题数）+ 题目维护（增改删/移动复制/批量标签）。
// 与「导入」分工：导入负责一次性灌题，这里负责已有题库的组织维护。

function emptyDraft(): QuestionDraft {
  return { type: 'single', stem: '', options: ['', ''], answer: 0, tags: [], source: 'file' };
}

function toDraft(q: Question): QuestionDraft {
  return {
    type: q.type,
    stem: q.stem,
    options: q.options,
    answer: q.answer,
    explanation: q.explanation,
    tags: q.tags,
    source: q.source,
  };
}


export function BanksPage() {
  const [banks, setBanks] = useState<BankWithCount[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedBankId, setSelectedBankId] = useState<string | null>(null);
  const [newBankName, setNewBankName] = useState('');
  const [showImport, setShowImport] = useState(false);

  const loadBanks = useCallback(() => {
    setError('');
    api.listBanksWithCounts().then(setBanks).catch((e) => setError((e as Error).message));
    api.listTags().then(setTags).catch(() => {});
  }, []);

  useEffect(() => loadBanks(), [loadBanks]);

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  }

  async function createBank() {
    const name = newBankName.trim();
    if (!name) return;
    try {
      await api.createBank(name);
      setNewBankName('');
      flash('题库已创建');
      loadBanks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function renameBank(bank: BankWithCount) {
    const name = window.prompt('重命名题库', bank.name)?.trim();
    if (!name || name === bank.name) return;
    try {
      await api.renameBank(bank.id, name);
      loadBanks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteBank(bank: BankWithCount) {
    if (
      !confirm(
        `删除题库「${bank.name}」？其中 ${bank.questionCount} 道题及相关作答/错题/答疑记录都会一并删除，不可恢复。`,
      )
    )
      return;
    try {
      await api.deleteBank(bank.id);
      if (selectedBankId === bank.id) setSelectedBankId(null);
      flash('题库已删除');
      loadBanks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (selectedBankId) {
    const bank = banks.find((b) => b.id === selectedBankId);
    return (
      <BankDetail
        bankId={selectedBankId}
        bankName={bank?.name ?? ''}
        allBanks={banks}
        tagSuggestions={tags}
        onBack={() => {
          setSelectedBankId(null);
          loadBanks();
        }}
        onChanged={loadBanks}
      />
    );
  }

  return (
    <div className="panel">
      <h2>题库管理</h2>
      {error && <div className="error">{error}</div>}
      {notice && <div className="badge ok" style={{ marginBottom: 10 }}>{notice}</div>}

      <div className="row" style={{ marginBottom: 16 }}>
        <input
          placeholder="新建题库名称"
          value={newBankName}
          onChange={(e) => setNewBankName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createBank()}
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={createBank} disabled={!newBankName.trim()}>
          + 新建空题库
        </button>
        <button
          className={showImport ? 'btn' : 'btn ghost'}
          onClick={() => setShowImport((v) => !v)}
        >
          {showImport ? '收起导入' : '📥 导入到新题库'}
        </button>
      </div>

      {showImport && (
        <div style={{ marginBottom: 16 }}>
          <ImportPanel
            onImported={() => {
              setShowImport(false);
              flash('已导入到新题库');
              loadBanks();
            }}
          />
        </div>
      )}

      {banks.length === 0 ? (
        <p className="muted">还没有题库。先新建一个，或去「导入」页灌题。</p>
      ) : (
        banks.map((b) => (
          <div className="list-item" key={b.id}>
            <div className="row">
              <strong>{b.name}</strong>
              <span className="badge">{b.questionCount} 题</span>
              <div className="spacer" />
              <button className="btn ghost" onClick={() => setSelectedBankId(b.id)}>
                管理题目
              </button>
              <button className="btn ghost" onClick={() => renameBank(b)}>
                重命名
              </button>
              <button className="btn danger" onClick={() => deleteBank(b)}>
                删除
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ── 题库详情：题目列表 + 多选批量操作 + 单题编辑 ──
interface DetailProps {
  bankId: string;
  bankName: string;
  allBanks: BankWithCount[];
  tagSuggestions: string[];
  onBack: () => void;
  onChanged: () => void;
}

function BankDetail({ bankId, bankName, allBanks, tagSuggestions, onBack, onChanged }: DetailProps) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<QuestionDraft | null>(null);
  const [adding, setAdding] = useState(false);
  const [showImport, setShowImport] = useState(false);

  // 批量操作输入
  const [moveTarget, setMoveTarget] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [tagMode, setTagMode] = useState<'add' | 'replace'>('add');

  const load = useCallback(() => {
    setError('');
    api.listQuestions(bankId).then(setQuestions).catch((e) => setError((e as Error).message));
  }, [bankId]);

  useEffect(() => load(), [load]);

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  }

  const allSelected = questions.length > 0 && selected.size === questions.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(questions.map((q) => q.id)));
  }

  function startAdd() {
    setAdding(true);
    setEditingId(null);
    setDraft(emptyDraft());
  }
  function startEdit(q: Question) {
    setAdding(false);
    setEditingId(q.id);
    setDraft(toDraft(q));
  }
  function cancelEdit() {
    setAdding(false);
    setEditingId(null);
    setDraft(null);
  }

  async function saveDraft() {
    if (!draft) return;
    try {
      if (adding) {
        await api.addQuestion(bankId, draft);
        flash('题目已新增');
      } else if (editingId) {
        await api.updateQuestion(editingId, draft);
        flash('题目已更新');
      }
      cancelEdit();
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteQuestion(q: Question) {
    if (!confirm('删除这道题？相关作答/错题/答疑记录一并删除，不可恢复。')) return;
    try {
      await api.deleteQuestion(q.id);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(q.id);
        return next;
      });
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function doMoveCopy(op: 'move' | 'copy') {
    if (selected.size === 0 || !moveTarget) return;
    try {
      const { affected } = await api.moveCopyQuestions({
        questionIds: [...selected],
        targetBankId: moveTarget,
        op,
      });
      flash(`已${op === 'move' ? '移动' : '复制'} ${affected} 题`);
      setSelected(new Set());
      setMoveTarget('');
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function doApplyTags() {
    const parsed = tagInput.split(',').map((t) => t.trim()).filter(Boolean);
    if (selected.size === 0 || parsed.length === 0) return;
    try {
      const { affected } = await api.applyTags({
        questionIds: [...selected],
        tags: parsed,
        mode: tagMode,
      });
      flash(`已给 ${affected} 题${tagMode === 'add' ? '追加' : '替换'}标签`);
      setTagInput('');
      setSelected(new Set());
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const otherBanks = useMemo(() => allBanks.filter((b) => b.id !== bankId), [allBanks, bankId]);

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn ghost" onClick={onBack}>
          ← 返回题库列表
        </button>
        <h2 style={{ margin: 0 }}>{bankName}</h2>
        <span className="badge">{questions.length} 题</span>
        <div className="spacer" />
        <button
          className={showImport ? 'btn' : 'btn ghost'}
          onClick={() => setShowImport((v) => !v)}
        >
          {showImport ? '收起导入' : '📥 导入到本库'}
        </button>
        <button className="btn" onClick={startAdd}>
          + 新增题目
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="badge ok" style={{ marginBottom: 10 }}>{notice}</div>}

      {showImport && (
        <div style={{ marginBottom: 16 }}>
          <ImportPanel
            targetBankId={bankId}
            targetBankName={bankName}
            onImported={() => {
              setShowImport(false);
              load();
              onChanged();
            }}
          />
        </div>
      )}

      {draft && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <strong>{adding ? '新增题目' : '编辑题目'}</strong>
            <div className="spacer" />
            <button className="btn" onClick={saveDraft}>
              保存
            </button>
            <button className="btn ghost" onClick={cancelEdit}>
              取消
            </button>
          </div>
          <DraftEditor
            draft={draft}
            index={0}
            errors={[]}
            onChange={setDraft}
            onRemove={cancelEdit}
            tagSuggestions={tagSuggestions}
          />
        </div>
      )}

      {/* 批量操作栏 */}
      {questions.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row">
            <label style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                style={{ width: 'auto', marginRight: 6 }}
              />
              全选
            </label>
            <span className="muted">已选 {selected.size} 题</span>
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted">移动/复制到：</span>
            <select
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
              style={{ width: 'auto' }}
              disabled={otherBanks.length === 0}
            >
              <option value="">选择目标题库</option>
              {otherBanks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <button
              className="btn ghost"
              disabled={selected.size === 0 || !moveTarget}
              onClick={() => doMoveCopy('move')}
            >
              移动
            </button>
            <button
              className="btn ghost"
              disabled={selected.size === 0 || !moveTarget}
              onClick={() => doMoveCopy('copy')}
            >
              复制
            </button>
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted">批量标签：</span>
            <input
              list="bank-tag-suggest"
              placeholder="标签，逗号分隔"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              style={{ flex: 1, minWidth: 160 }}
            />
            <datalist id="bank-tag-suggest">
              {tagSuggestions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <select
              value={tagMode}
              onChange={(e) => setTagMode(e.target.value as 'add' | 'replace')}
              style={{ width: 'auto' }}
            >
              <option value="add">追加</option>
              <option value="replace">替换</option>
            </select>
            <button
              className="btn ghost"
              disabled={selected.size === 0 || !tagInput.trim()}
              onClick={doApplyTags}
            >
              应用
            </button>
          </div>
        </div>
      )}

      {questions.length === 0 ? (
        <p className="muted">这个题库还没有题目。点「+ 新增题目」或去「导入」页灌题。</p>
      ) : (
        questions.map((q) => (
          <div className="list-item" key={q.id}>
            <div className="row">
              <input
                type="checkbox"
                checked={selected.has(q.id)}
                onChange={() => toggle(q.id)}
                style={{ width: 'auto' }}
              />
              <span className="badge">{QUESTION_TYPE_LABEL[q.type]}</span>
              <span style={{ flex: 1 }}>{q.stem}</span>
              {(q.tags ?? []).map((t) => (
                <span key={t} className="badge">
                  {t}
                </span>
              ))}
              <button className="btn ghost" onClick={() => startEdit(q)}>
                编辑
              </button>
              <button className="btn danger" onClick={() => deleteQuestion(q)}>
                删除
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
