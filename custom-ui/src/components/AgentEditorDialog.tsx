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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Plus, X, Loader2, Code, Sparkles, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';
import type { AgentInfo } from '@/types';
import { apiClient } from '@/services/api';
import { useToolStore } from '@/stores/toolStore';

// ─── Agent templates ──────────────────────────────────────────────────────────

const AGENT_TEMPLATES = [
  {
    id: 'customer_support',
    emoji: '🎧',
    label: 'Customer Support',
    name: 'Support Agent',
    description: 'Handles customer inquiries, resolves issues, and escalates when needed.',
    instructions: `You are a friendly and professional customer support agent. Your goals are:
- Answer questions clearly and accurately
- Show empathy for frustrated customers
- Resolve issues in as few steps as possible
- Escalate to a human when the issue is beyond your scope

Always greet the user, confirm you understand their issue before responding, and close by asking if there is anything else you can help with.`,
    tone: 'friendly',
  },
  {
    id: 'code_reviewer',
    emoji: '🔍',
    label: 'Code Reviewer',
    name: 'Code Review Agent',
    description: 'Reviews code for bugs, security issues, and best practices.',
    instructions: `You are a senior software engineer performing code reviews. For every piece of code submitted:
1. Check for bugs and logic errors
2. Identify security vulnerabilities (injection, auth flaws, secrets in code)
3. Evaluate performance bottlenecks
4. Suggest refactors for readability and maintainability
5. Highlight anything that doesn't follow best practices for the language/framework

Format your response with clear sections: **Bugs**, **Security**, **Performance**, **Style**, **Summary**.`,
    tone: 'technical',
  },
  {
    id: 'research_assistant',
    emoji: '🔬',
    label: 'Research Assistant',
    name: 'Research Agent',
    description: 'Synthesizes information, summarizes documents, and answers factual questions.',
    instructions: `You are a meticulous research assistant. When given a topic or question:
- Provide a concise, accurate summary
- Cite key facts and distinguish between confirmed facts and speculation
- Organize the response with headers when covering multiple subtopics
- Highlight areas where information may be outdated or contested
- Always recommend follow-up resources when relevant`,
    tone: 'professional',
  },
  {
    id: 'data_analyst',
    emoji: '📊',
    label: 'Data Analyst',
    name: 'Data Analyst Agent',
    description: 'Analyzes datasets, identifies patterns, and generates insights.',
    instructions: `You are a data analyst specializing in turning raw data into actionable insights. When given data:
- Identify key trends, anomalies, and patterns
- Suggest the most appropriate visualizations
- Explain statistical concepts in plain language
- Highlight data quality issues (missing values, outliers)
- Provide executive-level summaries alongside technical details`,
    tone: 'professional',
  },
  {
    id: 'sales_outreach',
    emoji: '📨',
    label: 'Sales Outreach',
    name: 'Sales Agent',
    description: 'Crafts personalized outreach messages and follows up on leads.',
    instructions: `You are an expert sales development representative. Your tasks:
- Write personalized, concise cold outreach emails (under 150 words)
- Tailor messaging to the prospect's industry and role
- Focus on value, not features — what problem does this solve for them?
- Include a single, clear call-to-action
- Write follow-up sequences that add value at each touch

Never use clichés like "I hope this email finds you well." Be direct and specific.`,
    tone: 'friendly',
  },
  {
    id: 'writing_assistant',
    emoji: '✍️',
    label: 'Writing Assistant',
    name: 'Writing Agent',
    description: 'Edits, rewrites, and helps with all forms of written content.',
    instructions: `You are a professional editor and writing coach. Your responsibilities:
- Improve clarity, flow, and conciseness without losing the author's voice
- Fix grammar, punctuation, and style issues
- Suggest stronger word choices and sentence structures
- Adapt tone and register to the target audience
- For long-form content: check structure, pacing, and logical flow

When asked to rewrite, always explain the key changes you made.`,
    tone: 'professional',
  },
  {
    id: 'security_auditor',
    emoji: '🛡️',
    label: 'Security Auditor',
    name: 'Security Agent',
    description: 'Identifies security risks in code, architecture, and configurations.',
    instructions: `You are a cybersecurity expert and penetration tester. For every submission:
1. Map to OWASP Top 10 and relevant CVEs where applicable
2. Rate severity: Critical / High / Medium / Low / Info
3. Explain the attack vector in plain language
4. Provide specific, actionable remediation steps with code examples
5. Note any compliance implications (GDPR, SOC2, HIPAA, PCI-DSS)

Be thorough but prioritize actionability. Always explain the "why" behind each finding.`,
    tone: 'technical',
  },
  {
    id: 'hr_assistant',
    emoji: '👥',
    label: 'HR Assistant',
    name: 'HR Agent',
    description: 'Helps with hiring, onboarding, policies, and employee questions.',
    instructions: `You are a knowledgeable HR business partner. You help with:
- Drafting job descriptions and interview questions
- Answering employee policy questions accurately and confidentially
- Providing onboarding checklists and documentation
- Offering guidance on performance management conversations
- Suggesting fair, legally compliant approaches to HR challenges

Always recommend consulting legal counsel for complex employment law questions.`,
    tone: 'professional',
  },
] as const;

type TemplateId = typeof AGENT_TEMPLATES[number]['id'];

// ─── Tone options ─────────────────────────────────────────────────────────────

const TONE_OPTIONS = [
  { value: 'professional', label: 'Professional', desc: 'Formal, precise, business-appropriate' },
  { value: 'friendly',     label: 'Friendly',     desc: 'Warm, approachable, conversational' },
  { value: 'technical',    label: 'Technical',     desc: 'Detailed, accurate, jargon-comfortable' },
  { value: 'casual',       label: 'Casual',        desc: 'Relaxed, informal, concise' },
  { value: 'empathetic',   label: 'Empathetic',    desc: 'Patient, supportive, emotionally aware' },
];

// ─── Component ────────────────────────────────────────────────────────────────

interface AgentEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentInfo | null;
  onSave: (agentData: any) => Promise<void>;
}

export const AgentEditorDialog: React.FC<AgentEditorDialogProps> = ({
  open,
  onOpenChange,
  agent,
  onSave,
}) => {
  const { tools: savedTools } = useToolStore();

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    instructions: '',
    model_id: '',
    temperature: 0.7,
    max_tokens: 2000,
    tone: 'professional',
    tools: [] as string[],
  });
  const [availableModels, setAvailableModels] = useState<Array<{ name: string; id: string; size: string; modified: string }>>([]);
  const [newTool, setNewTool] = useState('');
  const [selectedSavedTool, setSelectedSavedTool] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId | null>(null);

  const isNew = !agent;
  const isDefault = !!agent?.isDefault;

  useEffect(() => {
    if (!open) return;
    setSaveError(null);
    setSelectedTemplate(null);
    if (agent) {
      setFormData({
        name: agent.name || '',
        description: agent.description || '',
        instructions: agent.instructions || '',
        model_id: agent.model_id || '',
        temperature: 0.7,
        max_tokens: 2000,
        tone: 'professional',
        tools: agent.tools?.map(t => typeof t === 'string' ? t : JSON.stringify(t)) || [],
      });
    } else {
      setFormData({ name: '', description: '', instructions: '', model_id: '', temperature: 0.7, max_tokens: 2000, tone: 'professional', tools: [] });
    }
    loadModels();
  }, [open, agent]);

  const loadModels = async () => {
    setIsLoadingModels(true);
    try {
      const models = await apiClient.getOllamaModels();
      setAvailableModels(models);
    } catch {
      setAvailableModels([]);
    } finally {
      setIsLoadingModels(false);
    }
  };

  const applyTemplate = (templateId: TemplateId) => {
    const tpl = AGENT_TEMPLATES.find(t => t.id === templateId);
    if (!tpl) return;
    setSelectedTemplate(templateId);
    setFormData(prev => ({
      ...prev,
      name: tpl.name,
      description: tpl.description,
      instructions: tpl.instructions,
      tone: tpl.tone,
    }));
  };

  const handleAddTool = () => {
    if (newTool.trim() && !formData.tools.includes(newTool.trim())) {
      setFormData(prev => ({ ...prev, tools: [...prev.tools, newTool.trim()] }));
      setNewTool('');
    }
  };

  const handleRemoveTool = (index: number) => {
    setFormData(prev => ({ ...prev, tools: prev.tools.filter((_, i) => i !== index) }));
  };

  const handleSave = async () => {
    setSaveError(null);
    if (isDefault && !formData.model_id) {
      setSaveError('Please select a model for this agent.');
      return;
    }
    if (!isDefault && !formData.name.trim()) {
      setSaveError('Agent name is required.');
      return;
    }
    if (!isDefault && !formData.instructions.trim()) {
      setSaveError('Instructions are required.');
      return;
    }
    setIsSaving(true);
    try {
      await onSave({ id: agent?.id, ...formData, isDefault });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save agent.');
    } finally {
      setIsSaving(false);
    }
  };

  const instCharCount = formData.instructions.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] p-0 flex flex-col">
        <DialogHeader className="px-6 pt-5 pb-3 shrink-0 border-b">
          <DialogTitle className="text-xl">
            {isDefault ? 'Configure Agent' : isNew ? 'Create Agent' : 'Edit Agent'}
          </DialogTitle>
          {isDefault && (
            <p className="text-sm text-muted-foreground mt-0.5">
              Set the model. Instructions and tools are managed by the agent's source code.
            </p>
          )}
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 py-5 space-y-6">

            {/* ── Template picker (new agents only) ──────────────────── */}
            {isNew && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold">Start from a template</span>
                  <span className="text-xs text-muted-foreground ml-auto">or fill in manually below</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {AGENT_TEMPLATES.map(tpl => (
                    <button
                      key={tpl.id}
                      className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                        selectedTemplate === tpl.id
                          ? 'border-primary bg-primary/10'
                          : 'border-border/60 hover:border-primary/40 hover:bg-accent/30'
                      }`}
                      onClick={() => applyTemplate(tpl.id)}
                    >
                      <div className="text-lg mb-0.5">{tpl.emoji}</div>
                      <div className="text-xs font-semibold leading-tight">{tpl.label}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Identity ─────────────────────────────────────────────── */}
            <div className="space-y-4 rounded-xl border border-border/60 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Identity</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="name">Name {!isDefault && <span className="text-destructive">*</span>}</Label>
                  <Input
                    id="name"
                    placeholder="My Agent"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    disabled={isDefault}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="tone">Tone</Label>
                  <Select
                    value={formData.tone}
                    onValueChange={(v) => setFormData(prev => ({ ...prev, tone: v }))}
                    disabled={isDefault}
                  >
                    <SelectTrigger id="tone">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TONE_OPTIONS.map(t => (
                        <SelectItem key={t.value} value={t.value}>
                          <div>
                            <div className="font-medium">{t.label}</div>
                            <div className="text-xs text-muted-foreground">{t.desc}</div>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  placeholder="A short description of what this agent does"
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  disabled={isDefault}
                />
              </div>
            </div>

            {/* ── Instructions ─────────────────────────────────────────── */}
            {!isDefault && (
              <div className="space-y-4 rounded-xl border border-border/60 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    System Instructions <span className="text-destructive">*</span>
                  </p>
                  <span className={`text-xs tabular-nums ${instCharCount > 4000 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                    {instCharCount.toLocaleString()} chars
                  </span>
                </div>
                <Textarea
                  placeholder={`You are a ${formData.tone} AI assistant that...\n\nDescribe the agent's role, what it should and should not do, how to handle edge cases, and any domain knowledge it needs.`}
                  value={formData.instructions}
                  onChange={(e) => setFormData(prev => ({ ...prev, instructions: e.target.value }))}
                  rows={10}
                  className="font-mono text-sm resize-none"
                />
                <p className="text-xs text-muted-foreground">
                  The system prompt defines the agent's behaviour. Be specific — mention what the agent
                  <em> should</em> and <em>should not</em> do, its output format, and how to handle uncertainty.
                </p>
              </div>
            )}

            {/* ── Model ────────────────────────────────────────────────── */}
            <div className="space-y-4 rounded-xl border border-border/60 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Model</p>

              <div className="space-y-1.5">
                <Label htmlFor="model">
                  {isDefault ? 'Model *' : 'Model'}
                </Label>
                <Select
                  value={formData.model_id}
                  onValueChange={(v) => setFormData(prev => ({ ...prev, model_id: v }))}
                  disabled={isLoadingModels}
                >
                  <SelectTrigger id="model">
                    <SelectValue placeholder={isLoadingModels ? 'Loading…' : 'Select a model'} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableModels.length === 0 && !isLoadingModels && (
                      <div className="px-3 py-2 text-xs text-muted-foreground">No models found — pull one on the Models page.</div>
                    )}
                    {availableModels.map(m => (
                      <SelectItem key={m.id || m.name} value={m.name}>{m.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Advanced parameters — collapsed by default */}
              <button
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                Advanced parameters
              </button>

              {showAdvanced && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="temperature" className="text-xs">Temperature</Label>
                      <span className="text-xs tabular-nums text-muted-foreground">{formData.temperature.toFixed(1)}</span>
                    </div>
                    <Slider
                      id="temperature"
                      min={0} max={2} step={0.1}
                      value={[formData.temperature]}
                      onValueChange={(v) => setFormData(prev => ({ ...prev, temperature: v[0] }))}
                    />
                    <p className="text-[11px] text-muted-foreground">0 = focused · 2 = creative</p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="max_tokens" className="text-xs">Max output tokens</Label>
                    <Input
                      id="max_tokens"
                      type="number"
                      min={64}
                      max={128000}
                      value={formData.max_tokens}
                      onChange={(e) => setFormData(prev => ({ ...prev, max_tokens: Math.max(64, parseInt(e.target.value) || 2000) }))}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* ── Tools ────────────────────────────────────────────────── */}
            <div className="space-y-4 rounded-xl border border-border/60 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tools & Capabilities</p>

              {!isDefault && (
                <div className="space-y-3">
                  {savedTools.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Add from saved tools</Label>
                      <Select
                        value={selectedSavedTool}
                        onValueChange={(v) => {
                          if (v && !formData.tools.includes(v)) {
                            setFormData(prev => ({ ...prev, tools: [...prev.tools, v] }));
                          }
                          setSelectedSavedTool('');
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select a saved tool to add…" />
                        </SelectTrigger>
                        <SelectContent>
                          {savedTools.map(t => (
                            <SelectItem key={t.id} value={t.id} disabled={formData.tools.includes(t.id)}>
                              <div className="flex items-center gap-2"><Code className="h-3 w-3" />{t.name}</div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Or enter a tool ID manually</Label>
                    <div className="flex gap-2">
                      <Input
                        placeholder="web_search, code_interpreter, …"
                        value={newTool}
                        onChange={(e) => setNewTool(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddTool(); } }}
                        className="h-8 text-xs"
                      />
                      <Button variant="outline" size="sm" onClick={handleAddTool} className="shrink-0 h-8">
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {formData.tools.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {formData.tools.map((tool, idx) => (
                    <Badge key={idx} variant="secondary" className="pl-2.5 pr-1 py-1 gap-1.5">
                      <Code className="h-3 w-3 text-primary" />
                      <span className="text-xs">{tool}</span>
                      {!isDefault && (
                        <button
                          className="hover:text-destructive ml-0.5 transition-colors"
                          onClick={() => handleRemoveTool(idx)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No tools attached. Tools extend the agent with external capabilities like web search, code execution, and custom functions.
                </p>
              )}
            </div>

            {/* ── Inline error ─────────────────────────────────────────── */}
            {saveError && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {saveError}
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="px-6 py-3 border-t bg-card/50 shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSaving || (isDefault ? !formData.model_id : (!formData.name.trim() || !formData.instructions.trim()))}
          >
            {isSaving ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</> :
             isDefault ? 'Save Configuration' :
             isNew ? 'Create Agent' : 'Update Agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
