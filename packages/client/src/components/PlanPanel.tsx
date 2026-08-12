// FILE: packages/client/src/components/PlanPanel.tsx
import { useState } from 'react';
import type { AiPhase, LearningPlan, LearningTask, PracticeScope } from '@exam/shared';
import { api } from '../api/client.js';

interface Props {
  plans: LearningPlan[];
  onStartTask?: (scope: PracticeScope) => void;
  onRefresh?: () => void;
}

// 学习计划面板（Slice 6）：阶段折叠 + 任务卡片 + "一键开练"按钮。

export function PlanPanel({ plans, onStartTask, onRefresh }: Props) {
  if (plans.length === 0) {
    return (
      <div className="card">
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>学习计划</h3>
        <p className="muted">暂无学习计划。点击"生成学习计划"创建个性化训练方案。</p>
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ fontSize: 15, margin: '0 0 12px' }}>学习计划</h3>
      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} onStartTask={onStartTask} onRefresh={onRefresh} />
      ))}
    </div>
  );
}

function PlanCard({ plan, onStartTask, onRefresh }: {
  plan: LearningPlan;
  onStartTask?: (scope: PracticeScope) => void;
  onRefresh?: () => void;
}) {
  const [tasks, setTasks] = useState<LearningTask[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (!expanded && tasks === null) {
      setLoading(true);
      try {
        const t = await api.getPlanTasks(plan.id);
        setTasks(t);
      } catch { /* ignore */ }
      setLoading(false);
    }
    setExpanded(!expanded);
  }

  async function updateTaskStatus(taskId: string, status: LearningTask['status']) {
    try {
      await api.updateTaskStatus(taskId, status);
      setTasks((prev) =>
        prev ? prev.map((t) => (t.id === taskId ? { ...t, status } : t)) : prev,
      );
      onRefresh?.();
    } catch { /* ignore */ }
  }

  // 统计进度
  const completedCount = tasks?.filter((t) => t.status === 'done').length ?? 0;
  const totalCount = tasks?.length ?? plan.phases.reduce((s, p) => s + p.tasks.length, 0);

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div
        onClick={toggle}
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <div style={{ fontWeight: 600 }}>{plan.title}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {plan.phases.length} 阶段 · {totalCount} 任务
            {totalCount > 0 && ` · 完成 ${completedCount}/${totalCount}`}
          </div>
        </div>
        <span style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▸</span>
      </div>

      {loading && <div className="muted" style={{ marginTop: 8 }}>加载中...</div>}

      {expanded && tasks && (
        <div style={{ marginTop: 12 }}>
          {plan.phases.map((phase, pi) => {
            const phaseTasks = tasks.filter((t) => t.phaseIndex === pi);
            return (
              <PhaseSection
                key={pi}
                phase={phase}
                phaseIndex={pi}
                tasks={phaseTasks}
                onStartTask={onStartTask}
                onUpdateStatus={updateTaskStatus}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function PhaseSection({ phase, phaseIndex, tasks, onStartTask, onUpdateStatus }: {
  phase: AiPhase;
  phaseIndex: number;
  tasks: LearningTask[];
  onStartTask?: (scope: PracticeScope) => void;
  onUpdateStatus: (taskId: string, status: LearningTask['status']) => void;
}) {
  const [open, setOpen] = useState(phaseIndex === 0);
  const completed = tasks.filter((t) => t.status === 'done').length;

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 0',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div>
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            阶段 {phaseIndex + 1}：{phase.title}
          </span>
          <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
            {completed}/{tasks.length}
          </span>
        </div>
        <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▸</span>
      </div>

      {open && (
        <>
          {phase.description && (
            <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>{phase.description}</p>
          )}
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onStart={() => onStartTask?.(task.scope)}
              onStatusChange={(s) => onUpdateStatus(task.id, s)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function TaskCard({ task, onStart, onStatusChange }: {
  task: LearningTask;
  onStart: () => void;
  onStatusChange: (status: LearningTask['status']) => void;
}) {
  const STATUS_LABEL: Record<LearningTask['status'], string> = {
    pending: '待开始',
    in_progress: '进行中',
    done: '已完成',
  };

  const STATUS_ICON: Record<LearningTask['status'], string> = {
    pending: '○',
    in_progress: '◐',
    done: '●',
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 0',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span
        style={{ cursor: 'pointer', fontSize: 16, color: task.status === 'done' ? 'var(--ok)' : 'var(--muted)' }}
        onClick={() => {
          const next = task.status === 'done' ? 'pending' : 'done';
          onStatusChange(next);
        }}
        title="点击切换完成状态"
      >
        {STATUS_ICON[task.status]}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, textDecoration: task.status === 'done' ? 'line-through' : 'none' }}>
          {task.title}
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {STATUS_LABEL[task.status]}
          {task.scope.mode === 'byTag' && task.scope.tag && ` · ${task.scope.tag}`}
          {task.scope.mode === 'byType' && task.scope.type && ` · ${task.scope.type}`}
        </div>
      </div>
      <button
        className="btn ghost"
        style={{ fontSize: 12, padding: '2px 8px' }}
        onClick={onStart}
      >
        一键开练
      </button>
    </div>
  );
}
