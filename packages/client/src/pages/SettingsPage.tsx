import { useEffect, useState } from 'react';
import type { Provider, ModelInfo, ProviderUpsert } from '@exam/shared';
import { api } from '../api/client.js';
import { ProviderForm } from '../components/ProviderForm.js';

// 模型设置页（DEC-19/20）：provider 增删改 + 选当前模型。Key 只显示 configured 状态。
export function SettingsPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [active, setActive] = useState('');
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    try {
      const [ps, ms] = await Promise.all([api.listProviders(), api.listModels()]);
      setProviders(ps);
      setModels(ms);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save(body: ProviderUpsert) {
    setError('');
    try {
      if (editing === 'new') await api.createProvider(body);
      else if (editing) await api.updateProvider(editing.id, body);
      setEditing(null);
      await refresh();
      setNotice('已保存');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    if (!confirm('删除该 provider？其模型将不可用。')) return;
    try {
      await api.deleteProvider(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function selectModel(value: string) {
    const [providerId, modelId] = value.split('::');
    if (!providerId || !modelId) return;
    setActive(value);
    try {
      await api.setActiveModel({ providerId, modelId });
      setNotice('已切换当前模型');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <h1>模型设置</h1>
      {error && <div className="error">⚠ {error}</div>}
      {notice && <div className="ok">{notice}</div>}

      <div className="card">
        <h2>当前使用的模型</h2>
        {models.length === 0 ? (
          <p className="muted">还没有可用模型。先在下方新增一个 provider 并填好 Key。</p>
        ) : (
          <select value={active} onChange={(e) => selectModel(e.target.value)}>
            <option value="">— 选择模型 —</option>
            {models.map((m) => (
              <option key={`${m.providerId}::${m.modelId}`} value={`${m.providerId}::${m.modelId}`}>
                {m.name}（{m.modelId}）
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Providers</h2>
          <div className="spacer" />
          {editing === null && (
            <button className="btn" onClick={() => setEditing('new')}>+ 新增 Provider</button>
          )}
        </div>
        {providers.length === 0 && editing === null && (
          <p className="muted">尚未配置任何 provider。</p>
        )}
        {providers.map((p) => (
          <div key={p.id} className="list-item" style={{ cursor: 'default' }}>
            <div className="row">
              <strong>{p.name}</strong>
              <span className={p.configured ? 'badge ok' : 'badge bad'}>
                {p.configured ? 'Key 已配置' : '未配置 Key'}
              </span>
              <span className="muted">{p.models.length} 个模型</span>
              <div className="spacer" />
              <button className="btn ghost" onClick={() => setEditing(p)}>编辑</button>
              <button className="btn danger" onClick={() => remove(p.id)}>删除</button>
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{p.baseUrl}</div>
          </div>
        ))}
      </div>

      {editing !== null && (
        <ProviderForm
          initial={editing === 'new' ? undefined : editing}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}
