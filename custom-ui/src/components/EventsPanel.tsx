import React, { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

interface EventsPanelProps {
  className?: string;
}

// Helper to condense consecutive text delta events
const getCondensedEvents = (events: any[]) => {
  const condensed: any[] = [];
  let currentTextGroup: any = null;

  for (const event of events) {
    if (event.type === 'response.output_text.delta') {
      if (!currentTextGroup) {
        // Start a new text group
        currentTextGroup = {
          ...event,
          _condensed: true,
          _deltas: [event.delta],
          _fullText: event.delta || '',
          _count: 1,
        };
      } else {
        // Add to existing group
        currentTextGroup._deltas.push(event.delta);
        currentTextGroup._fullText += event.delta || '';
        currentTextGroup._count++;
      }
    } else {
      // Non-delta event, flush current group if exists
      if (currentTextGroup) {
        condensed.push(currentTextGroup);
        currentTextGroup = null;
      }
      condensed.push(event);
    }
  }

  // Flush remaining group
  if (currentTextGroup) {
    condensed.push(currentTextGroup);
  }

  return condensed;
};

const getCondensedEventCount = (events: any[]) => {
  return getCondensedEvents(events).length;
};

export const EventsPanel: React.FC<EventsPanelProps> = ({ className }) => {
  const { debugEvents } = useAppStore();

  return (
    <div className={`flex flex-col h-full border-l bg-card/30 backdrop-blur-sm ${className}`}>
      <Tabs defaultValue="events" className="flex-1 flex flex-col">
        <div className="p-4 border-b bg-gradient-to-br from-accent/20 to-transparent">
          <TabsList className="bg-accent/50 w-full">
            <TabsTrigger value="events" className="flex-1">Events</TabsTrigger>
            <TabsTrigger value="traces" className="flex-1">Traces</TabsTrigger>
            <TabsTrigger value="tools" className="flex-1">Tools</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="events" className="flex-1 mt-0 p-4">
          <ScrollArea className="h-full">
            {debugEvents.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
                No events yet
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground mb-2">
                  Events {getCondensedEventCount(debugEvents)} ({debugEvents.length} raw)
                </div>
                {getCondensedEvents(debugEvents).map((event, idx) => (
                  <EventCard key={idx} event={event} />
                ))}
              </div>
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="traces" className="flex-1 mt-0 p-4">
          <ScrollArea className="h-full">
            <div className="text-sm text-muted-foreground">
              Trace data will appear here during agent execution
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="tools" className="flex-1 mt-0 p-4">
          <ScrollArea className="h-full">
            <div className="text-sm text-muted-foreground">
              Tool calls and results will appear here
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
};

interface EventCardProps {
  event: any;
}

const EventCard: React.FC<EventCardProps> = ({ event }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const getEventTypeColor = (type: string): "default" | "secondary" | "destructive" => {
    if (type.includes('error') || type.includes('failed')) return 'destructive';
    if (type.includes('done') || type.includes('completed')) return 'secondary';
    return 'default';
  };

  // Get event type display name (remove response. prefix)
  const getEventTypeLabel = () => {
    return event.type.replace('response.', '');
  };

  // Get a preview/subtitle of the event data
  const getSubtitle = () => {
    if (event._condensed) {
      const preview = event._fullText.slice(0, 50);
      return preview + (event._fullText.length > 50 ? '...' : '');
    }
    
    if (event.type === 'response.completed') {
      const resp = event.response;
      if (resp?.id) return `Response complete`;
    }
    
    if (event.type === 'response.created') {
      return 'response.created';
    }
    
    if (event.type === 'response.in_progress') {
      return 'response.in_progress';
    }
    
    if (event.type === 'response.output_item.added') {
      return 'Output item added';
    }
    
    if (event.type === 'response.content_part.added') {
      return 'response.content_part.added';
    }
    
    if (event.delta) return event.delta;
    if (event.text) return event.text.slice(0, 50);
    
    return '';
  };

  const getTimestamp = () => {
    if (event.timestamp) return new Date(event.timestamp).toLocaleTimeString();
    if (event.response?.created_at) {
      return new Date(event.response.created_at * 1000).toLocaleTimeString();
    }
    return '';
  };

  return (
    <Card className="p-3 bg-accent/30 border-accent/50 hover:bg-accent/40 transition-colors">
      <div className="flex items-start gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-5 w-5 p-0 hover:bg-accent"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </Button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <Badge variant={getEventTypeColor(event.type)} className="text-xs font-mono">
              {getEventTypeLabel()}
            </Badge>
            {getTimestamp() && (
              <span className="text-xs text-muted-foreground">
                {getTimestamp()}
              </span>
            )}
          </div>

          {!isExpanded && getSubtitle() && (
            <div className="text-xs text-muted-foreground truncate">
              {getSubtitle()}
            </div>
          )}

          {event._condensed && !isExpanded && (
            <div className="text-xs text-muted-foreground/60 mt-1">
              {event._count} deltas
            </div>
          )}

          {isExpanded && (
            <div className="mt-2 space-y-2">
              {event._condensed ? (
                <>
                  <div className="text-xs text-muted-foreground">
                    Full text ({event._count} deltas):
                  </div>
                  <div className="p-3 bg-background/50 rounded-lg text-xs border border-border">
                    {event._fullText}
                  </div>
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Show raw deltas
                    </summary>
                    <pre className="mt-2 p-3 bg-background/50 rounded-lg overflow-x-auto border border-border font-mono max-h-96 overflow-y-auto">
                      {JSON.stringify(event._deltas, null, 2)}
                    </pre>
                  </details>
                </>
              ) : (
                <pre className="p-3 bg-background/50 rounded-lg text-xs overflow-x-auto border border-border font-mono max-h-96 overflow-y-auto">
                  {JSON.stringify(event, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};
