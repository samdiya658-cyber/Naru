import { useState } from 'react';

export interface TaskStep {
  text: string;
  status: 'done' | 'current' | 'pending';
}

export function parseTaskPlan(text: string): { steps: TaskStep[]; cleanText: string } | null {
  // Look for <coworkPlan>...</coworkPlan> or a list of [x], [ ], [>] steps
  const planMatch = text.match(/<coworkPlan>([\s\S]*?)<\/coworkPlan>/i);
  let planBlock = planMatch ? planMatch[1].trim() : '';
  let cleanText = text;

  if (planMatch) {
    cleanText = text.replace(planMatch[0], '').trim();
  } else {
    // Look for leading Markdown checklist
    const checklistRegex = /^((?:\s*[-*]?\s*\[[ xX✓▶>~-]\]\s+[^\n]+\n?)+)/m;
    const match = text.match(checklistRegex);
    if (match && match[1].split('\n').filter(l => l.trim()).length >= 2) {
      planBlock = match[1].trim();
      cleanText = text.replace(match[1], '').trim();
    }
  }

  if (!planBlock) return null;

  const lines = planBlock.split('\n').map(l => l.trim()).filter(Boolean);
  const steps: TaskStep[] = [];

  for (const line of lines) {
    const isDone = /\[([xX✓])\]/i.test(line) || /^\s*[-*]?\s*✓/i.test(line);
    const isCurrent = /\[([▶>~])\]/i.test(line) || /^\s*[-*]?\s*▶/i.test(line);
    const textPart = line.replace(/^[-*]?\s*\[[ xX✓▶>~-]\]\s*/, '').replace(/^[-*]?\s*[✓▶>]\s*/, '').trim();

    if (textPart) {
      steps.push({
        text: textPart,
        status: isDone ? 'done' : isCurrent ? 'current' : 'pending',
      });
    }
  }

  return steps.length > 0 ? { steps, cleanText } : null;
}

export function TaskChecklist({ steps }: { steps: TaskStep[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const total = steps.length;
  const completed = steps.filter(s => s.status === 'done').length;
  const isFinished = completed === total;
  const progressPercent = Math.round((completed / Math.max(1, total)) * 100);

  return (
    <div className={`cowork-plan-card ${isFinished ? 'finished' : 'in-progress'}`}>
      <div className="cowork-plan-header" onClick={() => setCollapsed(!collapsed)} role="button" tabIndex={0}>
        <div className="cowork-plan-title-group">
          <span className="cowork-plan-badge">
            {isFinished ? '✓ Plan Completed' : `▶ Task Plan (${completed}/${total})`}
          </span>
          <span className="cowork-plan-summary">
            {isFinished ? 'All coworker steps executed' : steps.find(s => s.status === 'current')?.text || 'Executing tasks...'}
          </span>
        </div>
        <div className="cowork-plan-actions">
          <div className="cowork-mini-progress">
            <div className="cowork-mini-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <span className="cowork-toggle-icon">{collapsed ? '▼' : '▲'}</span>
        </div>
      </div>

      {!collapsed && (
        <ul className="cowork-steps-list">
          {steps.map((step, idx) => (
            <li key={idx} className={`cowork-step ${step.status}`}>
              <span className="cowork-step-indicator" aria-hidden="true">
                {step.status === 'done' ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                ) : step.status === 'current' ? (
                  <span className="cowork-step-pulse" />
                ) : (
                  <span className="cowork-step-bullet" />
                )}
              </span>
              <span className="cowork-step-text">{step.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
