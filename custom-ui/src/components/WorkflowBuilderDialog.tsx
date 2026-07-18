import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertCircle, Workflow } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { apiClient } from '@/services/api';
import {
  useWorkflowStore,
  ORCHESTRATION_OPTIONS,
  type SavedWorkflow,
  type WorkflowOrchestration,
} from '@/stores/workflowStore';

interface WorkflowBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: SavedWorkflow | null;
}

export const WorkflowBuilderDialog: React.FC<WorkflowBuilderDialogProps> = ({
  open,
  onOpenChange,
  editing,
}) => {
  const { agents } = useAppStore();
  const { createWorkflow, updateWorkflow } = useWorkflowStore();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [orchestrationType, setOrchestrationType] = useState<WorkflowOrchestration>('group_chat');
  const [managerInstructions, setManagerInstructions] = useState('');
  const [managerModelId, setManagerModelId] = useState('');
  const [availableModels, setAvailableModels] = useState<Array<{ name: string; id: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const isNew = !editing;

  useEffect(() => {
    if (!open) return;
    setError(null);
    apiClient.getOllamaModels().then(setAvailableModels).catch(() => {});
    if (editing) {
      setName(editing.name);
      setDescription(editing.description ?? '');
      setSelectedAgentIds(editing.agentIds);
      setOrchestrationType(editing.orchestrationType);
      setManagerInstructions(editing.managerInstructions ?? '');
      setManagerModelId(editing.managerModelId ?? '');
    } else {
      setName('');
      setDescription('');
      setSelectedAgentIds([]);
      setOrchestrationType('group_chat');
      setManagerInstructions('');
      setManagerModelId('');
    }
  }, [open, editing]);

  const toggleAgent = (id: string) => {
    setSelectedAgentIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  };

  const handleSave = () => {
    if (!name.trim()) { setError('Workflow name is required.'); return; }
    if (selectedAgentIds.length < 2) { setError('Select at least 2 agents.'); return; }
    setError(null);

    const data = {
      name: name.trim(),
      description: description.trim() || undefined,
      agentIds: selectedAgentIds,
      orchestrationType,
      managerInstructions: managerInstructions.trim() || undefined,
      managerModelId: managerModelId.trim() || undefined,
    };

    if (editing) {
      updateWorkflow(editing.id, data);
    } else {
      createWorkflow(data);
    }
    onOpenChange(false);
  };

  // Available agents to pick from
  const availableAgents = agents.filter((a) => a.type === 'agent');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b shrink-0">
          <div className="flex items-center gap-2">
            <Workflow className="h-5 w-5 text-primary" />
            <DialogTitle>{isNew ? 'Create Workflow' : 'Edit Workflow'}</DialogTitle>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            A workflow saves a named combination of agents + orchestration type for quick reuse in Chat.
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Name + description */}
          <div className="space-y-4 rounded-xl border border-border/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Identity</p>
            <div className="space-y-1.5">
              <Label htmlFor="wf-name">Name *</Label>
              <Input id="wf-name" placeholder="e.g. Code Review Pipeline" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wf-desc">Description</Label>
              <Input id="wf-desc" placeholder="What does this workflow do?" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>

          {/* Orchestration type */}
          <div className="space-y-4 rounded-xl border border-border/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Orchestration *</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ORCHESTRATION_OPTIONS.map((opt) => (
                <label
                  key={opt.id}
                  className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                    orchestrationType === opt.id
                      ? 'border-primary bg-primary/10'
                      : 'border-border/60 hover:border-primary/40 hover:bg-accent/20'
                  }`}
                >
                  <input
                    type="radio"
                    name="orchestration"
                    className="mt-0.5 shrink-0"
                    checked={orchestrationType === opt.id}
                    onChange={() => setOrchestrationType(opt.id)}
                  />
                  <div>
                    <div className="text-sm font-medium flex items-center gap-1.5">
                      <span>{opt.icon}</span> {opt.label}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{opt.desc}</div>
                  </div>
                </label>
              ))}
            </div>

            {orchestrationType === 'group_chat' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="wf-manager-model" className="text-xs text-muted-foreground">
                    Manager Model <span className="opacity-60">(optional — defaults to first agent's model)</span>
                  </Label>
                  <Select value={managerModelId || '__auto__'} onValueChange={(v) => setManagerModelId(v === '__auto__' ? '' : v)}>
                    <SelectTrigger id="wf-manager-model" className="h-8 text-xs">
                      <SelectValue placeholder="Auto (borrow from first agent)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__auto__">Auto — use first agent's model</SelectItem>
                      {availableModels.map((m) => (
                        <SelectItem key={m.id || m.name} value={m.name}>{m.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wf-manager" className="text-xs text-muted-foreground">
                    Manager Instructions <span className="opacity-60">(optional)</span>
                  </Label>
                  <Textarea
                    id="wf-manager"
                    placeholder="e.g. Only finish when the code has been written AND successfully executed."
                    value={managerInstructions}
                    onChange={(e) => setManagerInstructions(e.target.value)}
                    rows={3}
                    className="text-xs"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Agent selection */}
          <div className="space-y-3 rounded-xl border border-border/60 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Participants * <span className="normal-case font-normal">(select 2+)</span>
              </p>
              {selectedAgentIds.length > 0 && (
                <Badge variant="secondary" className="text-[11px]">{selectedAgentIds.length} selected</Badge>
              )}
            </div>

            {availableAgents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No agents found. Create some agents first.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
                {availableAgents.map((agent) => {
                  const checked = selectedAgentIds.includes(agent.id);
                  return (
                    <label
                      key={agent.id}
                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 cursor-pointer transition-colors ${
                        checked
                          ? 'border-primary bg-primary/10'
                          : 'border-border/40 hover:border-primary/30 hover:bg-accent/20'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="shrink-0"
                        checked={checked}
                        onChange={() => toggleAgent(agent.id)}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium truncate">{agent.name || agent.id}</div>
                        {agent.description && (
                          <div className="text-[10px] text-muted-foreground truncate">{agent.description}</div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}

            {/* Show selected order */}
            {selectedAgentIds.length >= 2 && (
              <div className="pt-1">
                <p className="text-[11px] text-muted-foreground mb-1">
                  {orchestrationType === 'sequential' ? 'Execution order:' : 'Participants:'}
                </p>
                <div className="flex flex-wrap gap-1">
                  {selectedAgentIds.map((id, i) => {
                    const agent = availableAgents.find((a) => a.id === id);
                    return (
                      <span key={id} className="inline-flex items-center gap-1 text-[11px] bg-muted/60 rounded px-1.5 py-0.5">
                        {orchestrationType === 'sequential' && <span className="text-muted-foreground">{i + 1}.</span>}
                        {agent?.name || id}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="px-6 py-3 border-t bg-card/50 shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={!name.trim() || selectedAgentIds.length < 2}
          >
            {isNew ? 'Create Workflow' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
