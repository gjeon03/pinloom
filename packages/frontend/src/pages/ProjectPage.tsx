import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Plan, PlanItem, Project } from '@planloom/shared';
import { api } from '../api/client.js';
import { PlanPanel } from '../components/PlanPanel.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { TerminalPanel } from '../components/TerminalPanel.js';

export function ProjectPage() {
  const { projectId, planId } = useParams<{ projectId: string; planId?: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [items, setItems] = useState<PlanItem[]>([]);

  useEffect(() => {
    if (!projectId) return;
    api.listProjects().then((list) => {
      setProject(list.find((p) => p.id === projectId) ?? null);
    });
    api.listPlans(projectId).then(setPlans);
  }, [projectId]);

  useEffect(() => {
    if (plans.length === 0) {
      setActivePlan(null);
      setItems([]);
      return;
    }
    const selected = planId
      ? plans.find((p) => p.id === planId) ?? plans[0]
      : plans[0];
    setActivePlan(selected);
  }, [plans, planId]);

  useEffect(() => {
    if (!activePlan) return;
    api.listPlanItems(activePlan.id).then(setItems);
  }, [activePlan]);

  async function createPlan(title: string) {
    if (!projectId) return;
    const p = await api.createPlan(projectId, { title });
    setPlans((prev) => [p, ...prev]);
    setActivePlan(p);
  }

  if (!project) return <div className="p-6 text-sm">Loading project…</div>;

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-[var(--color-border)] px-6 py-3">
        <div className="font-semibold">{project.name}</div>
        <div className="text-xs text-[var(--color-ink-muted)] font-mono">{project.cwd}</div>
      </header>

      <div className="grid grid-cols-[340px_1fr_360px] flex-1 min-h-0">
        <PlanPanel
          plans={plans}
          activePlan={activePlan}
          items={items}
          onSelectPlan={setActivePlan}
          onCreatePlan={createPlan}
          onItemsChange={setItems}
        />
        <ChatPanel project={project} activePlan={activePlan} items={items} />
        <TerminalPanel project={project} />
      </div>
    </div>
  );
}
