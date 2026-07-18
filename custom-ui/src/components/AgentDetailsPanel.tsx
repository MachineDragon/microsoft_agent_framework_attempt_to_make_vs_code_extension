import React from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { AgentInfo } from '@/types';

interface AgentDetailsPanelProps {
  agent: AgentInfo;
  className?: string;
}

export const AgentDetailsPanel: React.FC<AgentDetailsPanelProps> = ({ agent, className }) => {
  return (
    <div className={`border-l bg-card/30 backdrop-blur-sm ${className}`}>
      <ScrollArea className="h-full">
        <div className="p-6 space-y-6">
          {/* Header */}
          <div>
            <h2 className="text-2xl font-bold mb-1">{agent.name}</h2>
            <p className="text-sm text-muted-foreground">Agent Details</p>
          </div>

          {/* Model & Client */}
          {(agent.model_id || agent.chat_client_type) && (
            <Card className="p-4 space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Model & Client
              </h3>
              <div className="space-y-1">
                {agent.model_id && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Model: </span>
                    <span className="font-mono">{agent.model_id}</span>
                  </div>
                )}
                {agent.chat_client_type && (
                  <div className="text-sm text-muted-foreground">
                    ({agent.chat_client_type})
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Source */}
          <Card className="p-4 space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Source
            </h3>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="capitalize">
                {agent.source}
              </Badge>
            </div>
          </Card>

          {/* Environment Variables */}
          <Card className="p-4 space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Environment
            </h3>
            {agent.required_env_vars && agent.required_env_vars.length > 0 ? (
              <div className="space-y-2">
                {agent.required_env_vars.map((envVar, idx) => (
                  <div key={idx} className="text-sm space-y-1">
                    <div className="flex items-center gap-2">
                      <code className="text-xs bg-muted px-2 py-1 rounded">
                        {envVar.name}
                      </code>
                      {envVar.required && (
                        <Badge variant="destructive" className="text-xs">
                          Required
                        </Badge>
                      )}
                    </div>
                    {envVar.description && (
                      <p className="text-xs text-muted-foreground pl-2">
                        {envVar.description}
                      </p>
                    )}
                    {envVar.example && (
                      <p className="text-xs text-muted-foreground/60 pl-2 font-mono">
                        Example: {envVar.example}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No environment variables required
              </p>
            )}
          </Card>

          {/* Instructions */}
          {agent.instructions && (
            <Card className="p-4 space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Instructions
              </h3>
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {agent.instructions}
              </p>
            </Card>
          )}

          {/* Tools */}
          <Card className="p-4 space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Tools ({agent.tools?.length || 0})
            </h3>
            {agent.tools && agent.tools.length > 0 ? (
              <div className="space-y-2">
                {agent.tools.map((tool, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs font-mono">
                      {typeof tool === 'string' ? tool : JSON.stringify(tool)}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No tools configured</p>
            )}
          </Card>

          {/* Context Providers */}
          {agent.context_providers && agent.context_providers.length > 0 && (
            <Card className="p-4 space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Context Providers ({agent.context_providers.length})
              </h3>
              <div className="flex flex-wrap gap-2">
                {agent.context_providers.map((provider, idx) => (
                  <Badge key={idx} variant="secondary" className="text-xs">
                    {provider}
                  </Badge>
                ))}
              </div>
            </Card>
          )}

          {/* Middleware */}
          {agent.middleware && agent.middleware.length > 0 && (
            <Card className="p-4 space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Middleware ({agent.middleware.length})
              </h3>
              <div className="flex flex-wrap gap-2">
                {agent.middleware.map((mw, idx) => (
                  <Badge key={idx} variant="secondary" className="text-xs">
                    {mw}
                  </Badge>
                ))}
              </div>
            </Card>
          )}

          {/* Description */}
          {agent.description && (
            <Card className="p-4 space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Description
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {agent.description}
              </p>
            </Card>
          )}

          {/* Deployment Support */}
          {agent.deployment_supported !== undefined && (
            <Card className="p-4 space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Deployment
              </h3>
              <div className="flex items-center gap-2">
                <Badge variant={agent.deployment_supported ? "default" : "secondary"}>
                  {agent.deployment_supported ? "Supported" : "Not Supported"}
                </Badge>
              </div>
              {agent.deployment_reason && (
                <p className="text-xs text-muted-foreground mt-2">
                  {agent.deployment_reason}
                </p>
              )}
            </Card>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
