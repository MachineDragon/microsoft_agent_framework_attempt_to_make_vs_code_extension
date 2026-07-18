import React, { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2, Info, Settings } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

interface ConversationSelectorProps {
  className?: string;
  onToggleAgentDetails?: () => void;
  onOpenSettings?: () => void;
}

export const ConversationSelector: React.FC<ConversationSelectorProps> = ({ className, onToggleAgentDetails, onOpenSettings }) => {
  const {
    selectedAgent,
    currentConversation,
    availableConversations,
    createConversation,
    loadConversations,
    switchConversation,
    deleteConversation,
  } = useAppStore();

  // Load conversations when agent is selected
  useEffect(() => {
    if (selectedAgent) {
      loadConversations();
    }
  }, [selectedAgent, loadConversations]);



  const handleNewConversation = async () => {
    console.log('handleNewConversation called', { selectedAgent });
    if (!selectedAgent) {
      console.log('No selected agent, returning early');
      return;
    }
    console.log('Calling createConversation...');
    await createConversation();
    console.log('createConversation completed');
  };

  const handleConversationChange = async (conversationId: string) => {
    await switchConversation(conversationId);
  };

  const handleDeleteConversation = async () => {
    if (!currentConversation) return;
    await deleteConversation(currentConversation.id);
  };

  return (
    <div className={`flex items-center gap-3 px-6 py-4 border-b bg-card/30 backdrop-blur-sm ${className}`}>
      {/* Agent Name and Action Buttons */}
      {selectedAgent && (
        <>
          <h2 className="text-lg font-semibold">{selectedAgent.name}</h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onToggleAgentDetails}
            title="Agent Details"
          >
            <Info className="h-4 w-4" />
          </Button>
          {selectedAgent.type === 'agent' && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onOpenSettings}
              title="Edit Agent"
            >
              <Settings className="h-4 w-4" />
            </Button>
          )}
          <div className="h-6 w-px bg-border mx-2" />
        </>
      )}

      <Select
        value={currentConversation?.id || ''}
        onValueChange={handleConversationChange}
        disabled={!selectedAgent || availableConversations.length === 0}
      >
        <SelectTrigger className="w-full max-w-xs">
          <SelectValue
            placeholder={
              availableConversations.length === 0
                ? "No conversations"
                : currentConversation
                ? `Conversation ${currentConversation.id.slice(-8)}`
                : "Select conversation"
            }
          >
            {currentConversation && (
              <div className="flex items-center gap-2 text-xs">
                <span>Conversation {currentConversation.id.slice(-8)}</span>
              </div>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {availableConversations.map((conversation) => (
            <SelectItem key={conversation.id} value={conversation.id}>
              <div className="flex items-center justify-between w-full gap-3">
                <span>Conversation {conversation.id.slice(-8)}</span>
                {conversation.created_at && (
                  <span className="text-xs text-muted-foreground">
                    {new Date(conversation.created_at * 1000).toLocaleDateString()}
                  </span>
                )}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        variant="outline"
        size="icon"
        onClick={onToggleAgentDetails}
        disabled={!selectedAgent}
        title="Agent Details"
      >
        <Info className="h-4 w-4" />
      </Button>

      <Button
        variant="outline"
        size="icon"
        onClick={handleDeleteConversation}
        disabled={!currentConversation}
        title={
          currentConversation
            ? `Delete Conversation ${currentConversation.id.slice(-8)}`
            : "No conversation selected"
        }
      >
        <Trash2 className="h-4 w-4" />
      </Button>

      <Button
        variant="default"
        size="sm"
        onClick={handleNewConversation}
        disabled={!selectedAgent}
        className="shadow-sm whitespace-nowrap"
      >
        <Plus className="h-4 w-4 mr-1.5" />
        New Chat
      </Button>
    </div>
  );
};
