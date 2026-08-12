import { useState } from 'react';
import type { Provider, ProviderModel, ProviderUpsert } from '@exam/shared';

interface Props {
  initial?: Provider; // 传入 = 编辑模式（Key 不回填，DEC-19）
  onSubmit: (body: ProviderUpsert) => void;
  onCancel: () => void;
}

// provider 增删改表单。编辑时 Key 留空表示不改（DEC-19：Key 永不回填前端）。
// 第三批 体验⑤：alert → 内联错误；apiType 枚举 + 编辑模式现值兜底（评审 C6）。

// SDK 支持面内常见 API 类型（自由文本兜底保留，兼容历史数据）
const API_TYPE_OPTIONS = ['openai-completions', 'anthropic-messages'];

export function ProviderForm({ initial, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiType, setApiType] = useState(initial?.api ?? 'openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [models, setModels] = useState<ProviderModel[]>(
    initial?.models ?? [{ id: '', name: '' }],
  );

  const editing = !!initial;
  // 编辑模式兜底：历史自由文本不在枚举内时作为额外 option 显示（不空白）
  const apiTypeOptions =
    editing && initial && !API_TYPE_OPTIONS.includes(initial.api)
      ? [initial.api, ...API_TYPE_OPTIONS]
      : API_TYPE_OPTIONS;

  function setModel(i: number, patch: Partial<ProviderModel>) {
    setModels((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  }
  function addModel() {
    setModels((ms) => [...ms, { id: '', name: '' }]);
  }
  function removeModel(i: number) {
    setModels((ms) => ms.filter((_, j) => j !== i));
  }

  function submit() {
    const cleanModels = models
      .map((m) => ({ id: m.id.trim(), name: (m.name || m.id).trim() }))
      .filter((m) => m.id);
    if (!name.trim() || !baseUrl.trim() || cleanModels.length === 0) {
      setError('名称 / baseUrl / 至少一个模型 必填');
      return;
    }
    if (!editing && !apiKey.trim()) {
      setError('新增 provider 必须填 API Key');
      return;
    }
    const body: ProviderUpsert = {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      api: apiType.trim(),
      models: cleanModels,
    };
    if (apiKey.trim()) body.apiKey = apiKey.trim();
    onSubmit(body);
  }

  return (
    <div className="card">
      <h3>{editing ? '编辑 Provider' : '新增 Provider'}</h3>
      <div className="field">
        <label>名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 DeepSeek" />
      </div>
      <div className="field">
        <label>Base URL</label>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.deepseek.com/v1"
        />
      </div>
      <div className="field">
        <label>API 类型</label>
        <select value={apiType} onChange={(e) => setApiType(e.target.value)}>
          {apiTypeOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>
          API Key {editing && <span className="muted">（留空 = 不修改现有 Key）</span>}
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={editing ? '••••••（已配置）' : 'sk-...'}
        />
      </div>
      <div className="field">
        <label>模型列表</label>
        {models.map((m, i) => (
          <div className="row" key={i} style={{ marginBottom: 6 }}>
            <input
              placeholder="模型 id，如 deepseek-chat"
              value={m.id}
              onChange={(e) => setModel(i, { id: e.target.value })}
              style={{ flex: 1 }}
            />
            <input
              placeholder="显示名（可空）"
              value={m.name}
              onChange={(e) => setModel(i, { name: e.target.value })}
              style={{ flex: 1 }}
            />
            <button className="btn ghost" onClick={() => removeModel(i)} disabled={models.length === 1}>
              删
            </button>
          </div>
        ))}
        <button className="btn ghost" onClick={addModel}>+ 加一个模型</button>
      </div>
      {error && <div className="error">⚠ {error}</div>}
      <div className="row">
        <button className="btn" onClick={submit}>保存</button>
        <button className="btn ghost" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}
