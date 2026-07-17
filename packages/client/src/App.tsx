import { useState } from 'react';
import { ImportPage } from './pages/ImportPage.js';
import { QuizPage } from './pages/QuizPage.js';
import { WrongBookPage } from './pages/WrongBookPage.js';
import { InsightsPage } from './pages/InsightsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

type Tab = 'quiz' | 'import' | 'wrong' | 'insights' | 'settings';

const TABS: { key: Tab; label: string }[] = [
  { key: 'quiz', label: '刷题' },
  { key: 'import', label: '导入' },
  { key: 'wrong', label: '错题本' },
  { key: 'insights', label: '学情' },
  { key: 'settings', label: '设置' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('quiz');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">考试助手</div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={t.key === tab ? 'tab active' : 'tab'}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="content">
        {tab === 'quiz' && <QuizPage />}
        {tab === 'import' && <ImportPage />}
        {tab === 'wrong' && <WrongBookPage />}
        {tab === 'insights' && <InsightsPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
