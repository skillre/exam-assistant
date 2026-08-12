import { useState } from 'react';
import type { PracticeScope, QuestionType } from '@exam/shared';
import { QuizPage } from './pages/QuizPage.js';
import { BanksPage } from './pages/BanksPage.js';
import { WrongBookPage } from './pages/WrongBookPage.js';
import { InsightsPage } from './pages/InsightsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

type Tab = 'quiz' | 'banks' | 'wrong' | 'insights' | 'settings';

const TABS: { key: Tab; label: string }[] = [
  { key: 'quiz', label: '刷题' },
  { key: 'banks', label: '题库' },
  { key: 'wrong', label: '错题本' },
  { key: 'insights', label: '学情' },
  { key: 'settings', label: '设置' },
];

// 跨页下钻筛选（FR3.4）：学情薄弱点 → 刷题/错题按标签筛选
export interface DrillFilter {
  bankId?: string;
  tag?: string;
  type?: QuestionType;
}

export function App() {
  const [tab, setTab] = useState<Tab>('quiz');
  const [quizScope, setQuizScope] = useState<Partial<PracticeScope> | null>(null);
  const [autoStart, setAutoStart] = useState(false);
  const [wrongFilter, setWrongFilter] = useState<DrillFilter | null>(null);

  // 学情下钻到刷题（按标签）
  function drillToQuiz(filter: DrillFilter) {
    setQuizScope({ bankId: filter.bankId, tag: filter.tag, mode: filter.tag ? 'byTag' : 'all' });
    setAutoStart(false);
    setTab('quiz');
  }
  // 学情下钻 / 成绩单跳转到错题本
  function drillToWrong(filter?: DrillFilter) {
    setWrongFilter(filter ?? {});
    setTab('wrong');
  }

  // v3 Slice 6：一键开练 —— 从学习计划任务直接进入刷题（全 scope + 自动开始）
  function startTaskQuiz(scope: PracticeScope) {
    setQuizScope(scope);
    setAutoStart(true);
    setTab('quiz');
  }

  // 闭环④：切 tab 即重置下钻 filter（避免旧筛选残留到下次进入）
  function switchTab(next: Tab) {
    if (next !== tab) {
      setQuizScope(null);
      setAutoStart(false);
      setWrongFilter(null);
    }
    setTab(next);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">考试助手</div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={t.key === tab ? 'tab active' : 'tab'}
              onClick={() => switchTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="content">
        {tab === 'quiz' && (
          <QuizPage
            initialScope={quizScope}
            autoStart={autoStart}
            onNavigateWrong={() => drillToWrong()}
          />
        )}
        {tab === 'banks' && <BanksPage />}
        {tab === 'wrong' && <WrongBookPage initialFilter={wrongFilter} />}
        {tab === 'insights' && (
          <InsightsPage
            onDrillToQuiz={drillToQuiz}
            onDrillToWrong={drillToWrong}
            onStartTask={startTaskQuiz}
          />
        )}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
