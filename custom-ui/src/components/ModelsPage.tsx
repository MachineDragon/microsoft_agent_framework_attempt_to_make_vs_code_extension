import { useEffect, useState } from "react";
import { apiClient } from "@/services/api";
import { getStoredString, removeStoredString, setStoredString } from "@/services/extensionStorage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Database, ExternalLink, Brain, Eye, Wrench, MessageSquare, Download, Trash2, Search, RefreshCw, CheckCircle2 } from "lucide-react";

type OllamaModel = {
  name: string;
  id: string;
  size: string;
  modified: string;
  capabilities?: string[];
  architecture?: string;
  parameters?: string;
  context_length?: string;
  embedding_length?: string;
  quantization?: string;
};

type ModelPullJob = {
  job_id: string;
  name: string;
  status: string;
  completed?: number | null;
  total?: number | null;
  percent?: number | null;
  done: boolean;
  error?: string | null;
};

const capabilityConfig: Record<string, { icon: React.ElementType; label: string; color: string }> = {
  completion: { icon: MessageSquare, label: "Chat", color: "text-blue-500" },
  vision:     { icon: Eye,           label: "Vision", color: "text-purple-500" },
  tools:      { icon: Wrench,        label: "Tools", color: "text-amber-500" },
  thinking:   { icon: Brain,         label: "Thinking", color: "text-green-500" },
};

// Suggested models to pull if none installed
const SUGGESTED_MODELS = [
  { name: "llama3.2:3b",    desc: "Fast, 3B — great for quick tasks" },
  { name: "llama3.1:8b",    desc: "Balanced, 8B — solid all-rounder" },
  { name: "qwen2.5-coder:7b", desc: "Code specialist, 7B" },
  { name: "mistral:7b",     desc: "Efficient, 7B — low memory" },
];

export function ModelsPage() {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [modelToDownload, setModelToDownload] = useState("");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [pullJob, setPullJob] = useState<ModelPullJob | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchModels = async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const result = await apiClient.getOllamaModels();
      setModels(result);
    } catch {
      setError("Could not reach Ollama. Make sure it is running.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchModels();
    getStoredString("ollama_model_pull_job_id").then((storedJobId) => {
      if (storedJobId) setPullJob({ job_id: storedJobId, name: "model", status: "checking", done: false });
    });
  }, []);

  useEffect(() => {
    if (!pullJob?.job_id || pullJob.done) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const job = await apiClient.getOllamaModelPullJob(pullJob.job_id);
        if (cancelled) return;
        setPullJob(job);
        if (job.done) {
          void removeStoredString("ollama_model_pull_job_id");
          await fetchModels(true);
        }
      } catch (err) {
        if (!cancelled) {
          setPullJob((cur) => cur ? { ...cur, status: "failed", done: true, error: err instanceof Error ? err.message : "Failed" } : null);
          void removeStoredString("ollama_model_pull_job_id");
        }
      }
    };
    poll();
    const id = window.setInterval(poll, 1000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [pullJob?.job_id, pullJob?.done]);

  const handleDownloadModel = async (name?: string) => {
    const target = (name ?? modelToDownload).trim();
    if (!target) return;
    setDownloading(true);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await apiClient.pullOllamaModel(target);
      setActionMessage(result.message);
      void setStoredString("ollama_model_pull_job_id", result.job_id);
      setPullJob({ job_id: result.job_id, name: result.name, status: "queued", done: false });
      setModelToDownload("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to download model");
    } finally {
      setDownloading(false);
    }
  };

  const handleDeleteModel = async (name: string) => {
    if (!window.confirm(`Delete "${name}" from Ollama? This cannot be undone.`)) return;
    setDeletingModel(name);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await apiClient.deleteOllamaModel(name);
      setActionMessage(result.message);
      await fetchModels(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete model");
    } finally {
      setDeletingModel(null);
    }
  };

  const filtered = models.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    (m.architecture || "").toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading models…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center p-8">
        <div className="h-12 w-12 rounded-xl bg-destructive/10 flex items-center justify-center">
          <Database className="h-6 w-6 text-destructive" />
        </div>
        <div>
          <p className="font-medium">Could not connect to Ollama</p>
          <p className="text-sm text-muted-foreground mt-1">{error}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchModels()}>
          <RefreshCw className="h-4 w-4 mr-2" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex-1 w-full overflow-y-auto">
      <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <Database className="h-6 w-6 text-primary" /> Models
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {models.length} model{models.length !== 1 ? "s" : ""} installed via Ollama
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href="https://ollama.com/search"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              Browse Ollama library <ExternalLink className="h-3 w-3" />
            </a>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => fetchModels(true)} title="Refresh" disabled={refreshing}>
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {/* Pull / download bar */}
        <div className="rounded-xl border border-border/60 bg-card p-4 space-y-3">
          <p className="text-sm font-medium">Download a model</p>
          <div className="flex gap-2">
            <Input
              value={modelToDownload}
              onChange={(e) => setModelToDownload(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleDownloadModel(); }}
              placeholder="e.g. llama3.2:3b, qwen2.5-coder:7b"
              disabled={downloading}
              className="flex-1"
            />
            <Button onClick={() => void handleDownloadModel()} disabled={downloading || !modelToDownload.trim()} className="shrink-0">
              {downloading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Download className="h-4 w-4 mr-2" />}
              Pull
            </Button>
          </div>
          {/* Suggested */}
          {models.length === 0 && (
            <div className="pt-1">
              <p className="text-xs text-muted-foreground mb-2">No models yet — quick-start with one of these:</p>
              <div className="grid grid-cols-2 gap-2">
                {SUGGESTED_MODELS.map((s) => (
                  <button
                    key={s.name}
                    className="text-left rounded-lg border border-dashed border-border/60 px-3 py-2 hover:border-primary/50 hover:bg-accent/30 transition-colors"
                    onClick={() => void handleDownloadModel(s.name)}
                    disabled={downloading}
                  >
                    <p className="text-xs font-mono font-semibold">{s.name}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{s.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Active download job */}
        {pullJob && (
          <div className="rounded-xl border border-border/60 bg-card p-4">
            <div className="flex items-start gap-3">
              {pullJob.done && !pullJob.error ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 text-green-500 shrink-0" />
              ) : pullJob.error ? (
                <Database className="mt-0.5 h-5 w-5 text-destructive shrink-0" />
              ) : (
                <Loader2 className="mt-0.5 h-5 w-5 animate-spin text-primary shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{pullJob.name}</p>
                <p className="text-xs text-muted-foreground">
                  {pullJob.error ?? (pullJob.done ? "Download complete" : pullJob.status)}
                </p>
                {typeof pullJob.percent === "number" && !pullJob.done && (
                  <div className="mt-2 space-y-1">
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full bg-primary transition-all duration-300" style={{ width: `${Math.min(100, pullJob.percent)}%` }} />
                    </div>
                    <p className="text-[11px] text-muted-foreground">{pullJob.percent}%</p>
                  </div>
                )}
              </div>
              {pullJob.done && (
                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setPullJob(null)}>Dismiss</Button>
              )}
            </div>
          </div>
        )}

        {actionMessage && (
          <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4" /> {actionMessage}
          </div>
        )}
        {actionError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {actionError}
          </div>
        )}

        {/* Search */}
        {models.length > 0 && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter models…"
              className="pl-9"
            />
          </div>
        )}

        {/* Model list */}
        {filtered.length === 0 && models.length > 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No models match "{search}"</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((model) => (
              <div
                key={model.id}
                className="rounded-xl border border-border/60 bg-card hover:border-primary/30 transition-colors p-4 flex flex-col gap-3 group"
              >
                {/* Name + delete */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold truncate">{model.name}</p>
                    {model.architecture && (
                      <p className="text-xs text-muted-foreground mt-0.5">{model.architecture}</p>
                    )}
                  </div>
                  <button
                    className="opacity-0 group-hover:opacity-100 h-7 w-7 flex items-center justify-center rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all shrink-0"
                    title={`Delete ${model.name}`}
                    onClick={() => void handleDeleteModel(model.name)}
                    disabled={!!deletingModel || downloading}
                  >
                    {deletingModel === model.name ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>

                {/* Capabilities */}
                {model.capabilities && model.capabilities.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {model.capabilities.map((cap) => {
                      const cfg = capabilityConfig[cap];
                      const Icon = cfg?.icon ?? Database;
                      return (
                        <span
                          key={cap}
                          className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                        >
                          <Icon className={`h-3 w-3 ${cfg?.color ?? ""}`} />
                          {cfg?.label ?? cap}
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* Stats */}
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground border-t border-border/50 pt-2">
                  <span>{model.size}</span>
                  {model.parameters && <span>{model.parameters}</span>}
                  {model.context_length && <span>{model.context_length} ctx</span>}
                  {model.quantization && <span>{model.quantization}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
