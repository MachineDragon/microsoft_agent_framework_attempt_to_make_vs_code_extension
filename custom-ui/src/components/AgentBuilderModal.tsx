import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { apiClient } from '@/services/api';
import type { Entity } from '@/types';

// EntityUpdateRequest type for the update endpoint
interface EntityUpdateRequest {
  instructions?: string;
  model_id?: string;
  temperature?: number;
  max_tokens?: number;
}

interface AgentsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent?: Entity;
}

export const AgentsModal: React.FC<AgentsModalProps> = ({
  open,
  onOpenChange,
  agent,
}) => {
  const { loadEntities } = useAppStore();
  
  const [instructions, setInstructions] = useState('');
  const [modelId, setModelId] = useState('');
  const [temperature, setTemperature] = useState([1.0]);
  const [maxTokens, setMaxTokens] = useState('4096');
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Load Ollama models
  useEffect(() => {
    if (open) {
      loadOllamaModels();
    }
  }, [open]);

  // Initialize form with agent data
  useEffect(() => {
    if (agent) {
      setInstructions(agent.instructions || '');
      setModelId(agent.model_id || '');
      setTemperature([(agent as any).temperature !== undefined ? (agent as any).temperature : 1.0]);
      setMaxTokens(String((agent as any).max_tokens || 4096));
    }
  }, [agent]);

  const loadOllamaModels = async () => {
    setIsLoading(true);
    try {
      const result = await apiClient.getOllamaModels();
      // API returns model objects; store just names for this selector.
      setOllamaModels((result || []).map((m) => m.name));
    } catch (error) {
      console.error('Failed to load Ollama models:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!agent) return;
    
    setIsSaving(true);
    try {
      const updateRequest: EntityUpdateRequest = {
        instructions,
        model_id: modelId || undefined,
        temperature: temperature[0],
        max_tokens: parseInt(maxTokens) || undefined,
      };
      
      await apiClient.updateEntity(agent.id, updateRequest);
      
      // Reload entities to reflect changes
      await loadEntities();
      
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to update agent:', error);
      alert('Failed to save agent configuration');
    } finally {
      setIsSaving(false);
    }
  };

  const isValid = instructions.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {agent ? `Edit Agent: ${agent.name}` : 'Agents'}
          </DialogTitle>
          <DialogDescription>
            Configure your agent's behavior and model settings
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Instructions */}
          <div className="space-y-2">
            <Label htmlFor="instructions">
              Instructions <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Enter system instructions for the agent..."
              className="min-h-[150px]"
            />
            <p className="text-xs text-muted-foreground">
              Define the agent's role, capabilities, and behavior
            </p>
          </div>

          {/* Model Selection */}
          <div className="space-y-2">
            <Label htmlFor="model">Ollama Model</Label>
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading models...
              </div>
            ) : (
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger id="model">
                  <SelectValue placeholder="Select a model (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {ollamaModels.length === 0 ? (
                    <SelectItem value="none" disabled>
                      No Ollama models found
                    </SelectItem>
                  ) : (
                    ollamaModels.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">
              Select an Ollama model or leave empty for default
            </p>
          </div>

          {/* Temperature */}
          <div className="space-y-2">
            <Label htmlFor="temperature">
              Temperature: {temperature[0].toFixed(2)}
            </Label>
            <Slider
              id="temperature"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onValueChange={setTemperature}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">
              Controls randomness: 0 = deterministic, 2 = very creative
            </p>
          </div>

          {/* Max Tokens */}
          <div className="space-y-2">
            <Label htmlFor="maxTokens">Max Tokens</Label>
            <Input
              id="maxTokens"
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              placeholder="4096"
              min="1"
              max="32000"
            />
            <p className="text-xs text-muted-foreground">
              Maximum number of tokens to generate in the response
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!isValid || isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Changes'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
