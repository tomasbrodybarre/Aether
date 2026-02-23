'use client';

import type { Message, PermissionRequestEvent } from '@/types';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationEmptyState,
} from '@/components/ai-elements/conversation';
import { MessageItem } from './MessageItem';
import { StreamingMessage } from './StreamingMessage';
import Image from 'next/image';

interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultInfo {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface MessageListProps {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  toolUses?: ToolUseInfo[];
  toolResults?: ToolResultInfo[];
  streamingToolOutput?: string;
  statusText?: string;
  pendingPermission?: PermissionRequestEvent | null;
  permissionQueueLength?: number;
  onPermissionResponse?: (decision: 'allow' | 'allow_session' | 'deny') => void;
  permissionResolved?: 'allow' | 'deny' | null;
  onForceStop?: () => void;
  contentWidth?: number;
  /** All known project tags for the tag editor suggestion list */
  allProjectTags?: string[];
  /** Called when the user changes a turn's project tag */
  onTagChange?: (turnId: string, newTag: string | null) => void;
  /** Called when user clicks Discuss on an edited cell */
  onCellDiscuss?: (turnId: string, cellIndex: number, newContent: string) => void;
  /** Called when user clicks Save on an edited cell */
  onCellSave?: (turnId: string, cellIndex: number, newContent: string) => void;
}

export function MessageList({
  messages,
  streamingContent,
  isStreaming,
  toolUses = [],
  toolResults = [],
  streamingToolOutput,
  statusText,
  pendingPermission,
  permissionQueueLength,
  onPermissionResponse,
  permissionResolved,
  onForceStop,
  contentWidth = 100,
  allProjectTags,
  onTagChange,
  onCellDiscuss,
  onCellSave,
}: MessageListProps) {
  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <ConversationEmptyState
          title="Aether"
          description="Start a conversation with Gemini. Ask questions, get help with code, or explore ideas."
          icon={<Image src="/aether_logo.png" alt="Aether" width={64} height={64} />}
        />
      </div>
    );
  }

  return (
    <Conversation>
      <ConversationContent
        className="mx-auto px-4 py-6 gap-6 w-full"
        style={{ maxWidth: contentWidth >= 100 ? '1000px' : `${contentWidth}%` }}
      >
        {messages.map((message, index) => {
          // Compute block number for assistant messages (1-indexed, like Jupyter Out[N])
          const blockNumber = message.role === 'assistant'
            ? messages.slice(0, index + 1).filter(m => m.role === 'assistant').length
            : undefined;
          return (
            <MessageItem key={message.id} message={message} blockNumber={blockNumber} allProjectTags={allProjectTags} onTagChange={onTagChange} onCellDiscuss={onCellDiscuss} onCellSave={onCellSave} />
          );
        })}

        {isStreaming && (
          <StreamingMessage
            content={streamingContent}
            isStreaming={isStreaming}
            toolUses={toolUses}
            toolResults={toolResults}
            streamingToolOutput={streamingToolOutput}
            statusText={statusText}
            pendingPermission={pendingPermission}
            permissionQueueLength={permissionQueueLength}
            onPermissionResponse={onPermissionResponse}
            permissionResolved={permissionResolved}
            onForceStop={onForceStop}
          />
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
