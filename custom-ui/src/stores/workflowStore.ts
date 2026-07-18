import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createExtensionJSONStorage } from '@/stores/extensionStorage';

export type WorkflowOrchestration =
  | 'sequential'
  | 'group_chat'
  | 'concurrent'
  | 'handoff'
  | 'magentic';

export interface SavedWorkflow {
  id: string;
  name: string;
  description?: string;
  agentIds: string[];
  orchestrationType: WorkflowOrchestration;
  managerInstructions?: string;
  managerModelId?: string;   // explicit model for the group_chat manager LLM
  createdAt: number;
  updatedAt: number;
}

interface WorkflowStore {
  workflows: SavedWorkflow[];
  createWorkflow: (data: Omit<SavedWorkflow, 'id' | 'createdAt' | 'updatedAt'>) => SavedWorkflow;
  updateWorkflow: (id: string, data: Partial<Omit<SavedWorkflow, 'id' | 'createdAt'>>) => void;
  deleteWorkflow: (id: string) => void;
}

// ─── Starter workflows ────────────────────────────────────────────────────────
// Pre-built using the default agents. Seeded on first load (when store is empty).

const STARTER_WORKFLOWS: SavedWorkflow[] = [
  {
    id: 'starter_write_and_run',
    name: '🐍 Write & Run Python',
    description: 'Code Writer writes Python, Shell Executor runs it. Loops until the code works.',
    agentIds: ['code_writer_agent', 'shell_executor_agent'],
    orchestrationType: 'group_chat',
    managerInstructions:
      'You are coordinating Code Writer and Shell Executor. '
      + 'Step 1: Route to Code Writer to write the Python script. '
      + 'Step 2: After Code Writer responds, route to Shell Executor with this exact instruction: '
      + '"Find the ```python ... ``` code block in the PREVIOUS message from Code Writer and call run_python with that exact code immediately." '
      + 'Step 3: After Shell Executor reports exit_code: 0, set finish=true. '
      + 'If Shell Executor reports an error or empty output, route back to Code Writer to fix the code.',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'starter_plan_execute_review',
    name: '📋 Plan → Execute → Review',
    description: 'Planner breaks down the task, Shell Executor carries it out, Reviewer checks the result.',
    agentIds: ['planner_agent', 'shell_executor_agent', 'reviewer_agent'],
    orchestrationType: 'sequential',
    createdAt: 2,
    updatedAt: 2,
  },
  {
    id: 'starter_research_and_code',
    name: '🔬 Research → Write → Run',
    description: 'Web Researcher finds relevant docs/examples, Code Writer turns them into code, Shell Executor runs it.',
    agentIds: ['web_researcher_agent', 'code_writer_agent', 'shell_executor_agent'],
    orchestrationType: 'sequential',
    createdAt: 3,
    updatedAt: 3,
  },
  {
    id: 'starter_data_analysis',
    name: '📊 Data Analysis',
    description: 'File Manager reads the dataset, Data Analyst runs pandas analysis, Reviewer summarises findings.',
    agentIds: ['file_manager_agent', 'data_analyst_agent', 'reviewer_agent'],
    orchestrationType: 'sequential',
    createdAt: 4,
    updatedAt: 4,
  },
  {
    id: 'starter_devops',
    name: '🛠️ DevOps Diagnosis',
    description: 'Planner identifies what to check, DevOps Agent runs kubectl/docker/git commands and fixes issues.',
    agentIds: ['planner_agent', 'devops_agent'],
    orchestrationType: 'group_chat',
    managerInstructions:
      'Route to Planner first to identify what commands to run. Then route to DevOps Agent to execute them. ' +
      'If DevOps Agent finds an issue, route back to Planner for next steps. ' +
      'Only finish when the issue is resolved and verified.',
    createdAt: 5,
    updatedAt: 5,
  },
  {
    id: 'starter_code_review',
    name: '🔍 Write → Review',
    description: 'Code Writer writes the code, Reviewer critiques it for bugs, security issues, and improvements.',
    agentIds: ['code_writer_agent', 'reviewer_agent'],
    orchestrationType: 'sequential',
    createdAt: 6,
    updatedAt: 6,
  },
];

export const useWorkflowStore = create<WorkflowStore>()(
  persist(
    (set) => ({
      workflows: STARTER_WORKFLOWS,

      createWorkflow: (data) => {
        const now = Date.now();
        const workflow: SavedWorkflow = {
          ...data,
          id: `workflow_${now}_${Math.random().toString(36).slice(2, 8)}`,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({ workflows: [...state.workflows, workflow] }));
        return workflow;
      },

      updateWorkflow: (id, data) => {
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === id ? { ...w, ...data, updatedAt: Date.now() } : w
          ),
        }));
      },

      deleteWorkflow: (id) => {
        set((state) => ({ workflows: state.workflows.filter((w) => w.id !== id) }));
      },
    }),
    {
      name: 'saved-workflows',
      storage: createExtensionJSONStorage<WorkflowStore>(),
      // Merge persisted workflows with starters so new starters appear even
      // after the store has been hydrated from localStorage
      merge: (persisted: any, current) => {
        const persistedIds = new Set((persisted?.workflows ?? []).map((w: SavedWorkflow) => w.id));
        const newStarters = STARTER_WORKFLOWS.filter((s) => !persistedIds.has(s.id));
        return {
          ...current,
          workflows: [...(persisted?.workflows ?? []), ...newStarters],
        };
      },
    }
  )
);

export const ORCHESTRATION_OPTIONS: Array<{
  id: WorkflowOrchestration;
  label: string;
  desc: string;
  icon: string;
}> = [
  {
    id: 'group_chat',
    label: 'Group Chat',
    desc: 'LLM manager decides who speaks next — best for open-ended collaboration',
    icon: '💬',
  },
  {
    id: 'sequential',
    label: 'Sequential',
    desc: 'Each agent passes its output to the next — best for pipelines',
    icon: '➡️',
  },
  {
    id: 'concurrent',
    label: 'Concurrent',
    desc: 'All agents work in parallel, results aggregated — best for independent tasks',
    icon: '⚡',
  },
  {
    id: 'handoff',
    label: 'Handoff',
    desc: 'Agents dynamically transfer control based on context — best for routing',
    icon: '🤝',
  },
  {
    id: 'magentic',
    label: 'Magentic',
    desc: 'LLM orchestrator coordinates specialised sub-agents — best for complex tasks',
    icon: '🧲',
  },
];
