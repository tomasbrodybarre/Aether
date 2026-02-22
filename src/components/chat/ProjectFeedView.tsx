'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  Message,
  SSEEvent,
  TokenUsage,
  PermissionRequestEvent,
  MemoryObservationEvent,
  FileAttachment,
  TurnRecord,
} from '@/types';
import { turnToMessages } from '@/types';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { usePanel } from '@/hooks/usePanel';
import { useToast } from '@/components/ui/toast';

interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultInfo {
  tool_use_id: string;
  content: string;
}

interface ProjectFeedViewProps {
  /** Project tag — null for "current" (untagged) */
  projectTag: string | null;
  initialTurns?: TurnRecord[];
}

// Module-level cache for content width setting
let cachedContentWidth: number | null = null;

export function ProjectFeedView({ projectTag, initialTurns = [] }: ProjectFeedViewProps) {
  const { setWorkingDirectory, setPendingApprovalSessionId } = usePanel();
  const { addToast } = useToast();

  // Convert turns to messages for display
  const turnsToMessageList = useCallback(
    (turnList: TurnRecord[]): Message[] => turnList.flatMap(turnToMessages),
    []
  );

  const [turns, setTurns] = useState<TurnRecord[]>(initialTurns);
  const [messages, setMessages] = useState<Message[]>(() =>
    turnsToMessageList(initialTurns)
  );

  const [streamingContent, setStreamingContent] = useState('');
  const [contentWidth, setContentWidth] = useState(cachedContentWidth ?? 100);
  const contentWidthFetched = useRef(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolUses, setToolUses] = useState<ToolUseInfo[]>([]);
  const [toolResults, setToolResults] = useState<ToolResultInfo[]>([]);
  const [statusText, setStatusText] = useState<string | undefined>();
  const [mode, setMode] = useState('code');
  const [currentModel, setCurrentModel] = useState('');
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequestEvent[]>([]);
  const [permissionResolved, setPermissionResolved] = useState<'allow' | 'deny' | null>(null);
  const currentPermission = permissionQueue[0] ?? null;
  const [streamingToolOutput, setStreamingToolOutput] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [queuedMessage, setQueuedMessage] = useState<{ content: string; files?: FileAttachment[] } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const interruptRef = useRef(false);

  // RAF-based throttle for streaming content
  const accumulatedRef = useRef('');
  const rafIdRef = useRef<number>(0);
  const flushStreamingContent = useCallback(() => {
    if (rafIdRef.current) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = 0;
      setStreamingContent(accumulatedRef.current);
    });
  }, []);

  // Fetch content width + default working directory once
  useEffect(() => {
    if (contentWidthFetched.current || cachedContentWidth !== null) return;
    contentWidthFetched.current = true;
    fetch('/api/settings/app')
      .then((r) => r.json())
      .then((data) => {
        const w = parseInt(data.settings?.content_width, 10);
        if (w >= 50 && w <= 100) {
          cachedContentWidth = w;
          setContentWidth(w);
        }
        const defaultDir = data.settings?.default_working_directory;
        if (defaultDir && !workingDir) {
          setWorkingDir(defaultDir);
          setWorkingDirectory(defaultDir);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-sync streaming content when the window regains visibility
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && accumulatedRef.current) {
        setStreamingContent(accumulatedRef.current);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
    };
  }, []);

  // When initialTurns changes (e.g. parent page re-fetches), sync
  useEffect(() => {
    setTurns(initialTurns);
    setMessages(turnsToMessageList(initialTurns));
  }, [initialTurns, turnsToMessageList]);

  const handleWorkingDirectoryChange = useCallback(
    (dir: string) => {
      setWorkingDir(dir);
      setWorkingDirectory(dir);
    },
    [setWorkingDirectory]
  );

  const stopStreaming = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  const interruptStreaming = useCallback(
    (interruptMessage?: { content: string; files?: FileAttachment[] }) => {
      if (!isStreaming) return;
      if (interruptMessage) {
        interruptRef.current = true;
        setQueuedMessage(interruptMessage);
      }
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    },
    [isStreaming]
  );

  const handlePermissionResponse = useCallback(
    async (decision: 'allow' | 'allow_session' | 'deny') => {
      if (!currentPermission) return;
      console.log('[approval-debug] 🔵 User responded:', decision, 'for', currentPermission.permissionRequestId?.slice(0, 8));

      const body: {
        permissionRequestId: string;
        decision:
          | { behavior: 'allow'; updatedPermissions?: unknown[] }
          | { behavior: 'deny'; message?: string };
      } = {
        permissionRequestId: currentPermission.permissionRequestId,
        decision:
          decision === 'deny'
            ? { behavior: 'deny', message: 'User denied permission' }
            : {
                behavior: 'allow',
                ...(decision === 'allow_session' && currentPermission.suggestions
                  ? { updatedPermissions: currentPermission.suggestions }
                  : {}),
              },
      };

      setPermissionResolved(decision === 'deny' ? 'deny' : 'allow');

      try {
        await fetch('/api/chat/permission', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        // Best effort
      }

      setTimeout(() => {
        setPermissionQueue((q) => {
          const next = q.slice(1);
          if (next.length === 0) {
            queueMicrotask(() => setPendingApprovalSessionId(''));
          }
          return next;
        });
        setPermissionResolved(null);
      }, 600);
    },
    [currentPermission, setPendingApprovalSessionId]
  );

  const sendMessage = useCallback(
    async (content: string, files?: FileAttachment[]) => {
      if (isStreaming) {
        setQueuedMessage({ content, files });
        return;
      }

      // Build display content with file metadata
      let displayContent = content;
      if (files && files.length > 0) {
        const fileMeta = files.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          size: f.size,
          data: f.data,
        }));
        displayContent = `<!--files:${JSON.stringify(fileMeta)}-->${content}`;
      }

      // Optimistic: add user message immediately
      const tempUserId = 'temp-' + Date.now();
      const userMessage: Message = {
        id: tempUserId,
        session_id: '',
        role: 'user',
        content: displayContent,
        created_at: new Date().toISOString(),
        token_usage: null,
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsStreaming(true);
      setStreamingContent('');
      accumulatedRef.current = '';
      setToolUses([]);
      setToolResults([]);
      setStatusText(undefined);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      let accumulated = '';
      const toolUsesAccum: ToolUseInfo[] = [];
      const toolResultsAccum: ToolResultInfo[] = [];

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // No session_id → turn-based flow
            content,
            mode,
            model: currentModel || undefined,
            project_tag: projectTag,
            working_directory: workingDir || undefined,
            ...(files && files.length > 0 ? { files } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || 'Failed to send message');
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response stream');

        const decoder = new TextDecoder();
        let tokenUsage: TokenUsage | null = null;
        let buffer = '';
        let shouldStopStream = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done || shouldStopStream) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            try {
              const event: SSEEvent = JSON.parse(line.slice(6));

              // Log non-text events for approval flow debugging
              if (event.type !== 'text') {
                console.log(`[approval-debug] SSE event: ${event.type}`, event.type === 'status' ? event.data?.slice(0, 100) : '');
              }

              switch (event.type) {
                case 'text': {
                  accumulated += event.data;
                  accumulatedRef.current = accumulated;
                  flushStreamingContent();
                  break;
                }

                case 'tool_use': {
                  try {
                    const toolData = JSON.parse(event.data);
                    setStreamingToolOutput('');
                    const toolInfo = {
                      id: toolData.id,
                      name: toolData.name,
                      input: toolData.input,
                    };
                    setToolUses((prev) => {
                      if (prev.some((t) => t.id === toolData.id)) return prev;
                      return [...prev, toolInfo];
                    });
                    if (!toolUsesAccum.some((t) => t.id === toolData.id)) {
                      toolUsesAccum.push(toolInfo);
                    }
                  } catch {
                    /* skip */
                  }
                  break;
                }

                case 'tool_result': {
                  try {
                    const resultData = JSON.parse(event.data);
                    setStreamingToolOutput('');
                    const resultInfo = {
                      tool_use_id: resultData.tool_use_id,
                      content: resultData.content,
                    };
                    setToolResults((prev) => [...prev, resultInfo]);
                    toolResultsAccum.push(resultInfo);
                  } catch {
                    /* skip */
                  }
                  break;
                }

                case 'tool_output': {
                  try {
                    const parsed = JSON.parse(event.data);
                    if (parsed._progress) {
                      setStatusText(
                        `Running ${parsed.tool_name}... (${Math.round(parsed.elapsed_time_seconds)}s)`
                      );
                      break;
                    }
                  } catch {
                    // Not JSON — raw stderr
                  }
                  setStreamingToolOutput((prev) => {
                    const next = prev + (prev ? '\n' : '') + event.data;
                    return next.length > 5000 ? next.slice(-5000) : next;
                  });
                  break;
                }

                case 'status': {
                  try {
                    const statusData = JSON.parse(event.data);
                    if (statusData.session_id) {
                      setStatusText(`Connected (${statusData.model || 'gemini'})`);
                      setTimeout(() => setStatusText(undefined), 2000);
                    } else if (statusData.tool_status) {
                      // Tool lifecycle status — show human-readable text
                      const toolName = statusData.tool_name || 'tool';
                      switch (statusData.tool_status) {
                        case 'awaiting_approval':
                          // Show feedback while waiting for the permission_request SSE to arrive
                          console.log('[approval-debug] 🔶 Status: awaiting_approval for', toolName);
                          setStatusText(`Awaiting approval: ${toolName}...`);
                          break;
                        case 'validating':
                        case 'scheduled':
                          setStatusText(`Preparing ${toolName}...`);
                          break;
                        case 'executing':
                          setStatusText(`Running ${toolName}...`);
                          break;
                        case 'success':
                        case 'error':
                        case 'cancelled':
                          setStatusText(undefined);
                          break;
                        default:
                          setStatusText(undefined);
                      }
                    } else if (statusData.notification) {
                      setStatusText(statusData.message || statusData.title || undefined);
                    } else {
                      setStatusText(typeof event.data === 'string' ? event.data : undefined);
                    }
                  } catch {
                    setStatusText(event.data || undefined);
                  }
                  break;
                }

                case 'result': {
                  try {
                    const resultData = JSON.parse(event.data);
                    if (resultData.usage) {
                      tokenUsage = resultData.usage;
                    }
                  } catch {
                    /* skip */
                  }
                  setStatusText(undefined);
                  break;
                }

                case 'permission_request': {
                  try {
                    const permData: PermissionRequestEvent = JSON.parse(event.data);
                    console.log('[approval-debug] 🟢 Frontend received permission_request:', permData.toolName, permData.permissionRequestId?.slice(0, 8));
                    setPermissionQueue((q) => [...q, permData]);
                    setPermissionResolved(null);
                    setPendingApprovalSessionId('project-feed');
                  } catch (parseErr) {
                    console.error('[approval-debug] ❌ Failed to parse permission_request:', parseErr, 'raw:', event.data?.slice(0, 200));
                  }
                  break;
                }

                case 'memory_observation': {
                  try {
                    const memData: MemoryObservationEvent = JSON.parse(event.data);
                    const fileName =
                      memData.file.replace(/\\/g, '/').split('/').pop() || memData.file;
                    if (memData.auto_approve) {
                      addToast({
                        type: 'memory',
                        message: `Memory updated: ${fileName}`,
                        detail: memData.file,
                      });
                    }
                  } catch {
                    /* skip */
                  }
                  break;
                }

                case 'project_tag': {
                  // Tag was auto-inferred — notify sidebar
                  window.dispatchEvent(new CustomEvent('turn-updated'));
                  break;
                }

                case 'turn_created': {
                  // Custom event from turn-based flow with turn ID
                  window.dispatchEvent(new CustomEvent('turn-created'));
                  break;
                }

                case 'error': {
                  // Append error inline so it's preserved with any prior content
                  accumulated += '\n\n**Error:** ' + event.data;
                  accumulatedRef.current = accumulated;
                  setStreamingContent(accumulated);
                  // Don't continue the stream loop — break out so the
                  // accumulated content (including the error) is saved as
                  // a message and the finally block resets streaming state.
                  // Without this, the UI stays stuck in streaming mode
                  // waiting for a 'done' event that may never arrive.
                  shouldStopStream = true;
                  break;
                }

                case 'done':
                  break;
              }
            } catch {
              // skip malformed SSE lines
            }
          }
        }

        // Build content with tool blocks if any
        const buildContent = (): string => {
          if (toolUsesAccum.length === 0) return accumulated.trim();
          const blocks: unknown[] = [];
          if (accumulated.trim()) {
            blocks.push({ type: 'text', text: accumulated.trim() });
          }
          for (const tu of toolUsesAccum) {
            blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
            const tr = toolResultsAccum.find((r) => r.tool_use_id === tu.id);
            if (tr) {
              blocks.push({ type: 'tool_result', tool_use_id: tu.id, content: tr.content });
            }
          }
          return JSON.stringify(blocks);
        };

        // Add the assistant message
        if (accumulated.trim() || toolUsesAccum.length > 0) {
          const assistantMessage: Message = {
            id: 'temp-assistant-' + Date.now(),
            session_id: '',
            role: 'assistant',
            content: buildContent(),
            created_at: new Date().toISOString(),
            token_usage: tokenUsage ? JSON.stringify(tokenUsage) : null,
          };
          setMessages((prev) => [...prev, assistantMessage]);
        }

        // Notify sidebar to refresh
        window.dispatchEvent(new CustomEvent('turn-created'));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // User stopped generation — add partial content
          if (accumulated.trim()) {
            const partialMessage: Message = {
              id: 'temp-assistant-' + Date.now(),
              session_id: '',
              role: 'assistant',
              content: accumulated.trim() + '\n\n*(generation stopped)*',
              created_at: new Date().toISOString(),
              token_usage: null,
            };
            setMessages((prev) => [...prev, partialMessage]);
          }
        } else {
          const errMsg = error instanceof Error ? error.message : 'Unknown error';
          const errorMessage: Message = {
            id: 'temp-error-' + Date.now(),
            session_id: '',
            role: 'assistant',
            content: `**Error:** ${errMsg}`,
            created_at: new Date().toISOString(),
            token_usage: null,
          };
          setMessages((prev) => [...prev, errorMessage]);
        }
      } finally {
        if (rafIdRef.current) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = 0;
        }
        setIsStreaming(false);
        setStreamingContent('');
        accumulatedRef.current = '';
        setToolUses([]);
        setToolResults([]);
        setStreamingToolOutput('');
        setStatusText(undefined);
        setPermissionQueue([]);
        setPermissionResolved(null);
        setPendingApprovalSessionId('');
        abortControllerRef.current = null;
        // Notify file tree to refresh after AI finishes
        window.dispatchEvent(new CustomEvent('refresh-file-tree'));
      }
    },
    [
      isStreaming,
      mode,
      currentModel,
      projectTag,
      workingDir,
      setPendingApprovalSessionId,
      flushStreamingContent,
      addToast,
    ]
  );

  const handleCommand = useCallback(
    (command: string) => {
      switch (command) {
        case '/help': {
          const helpMessage: Message = {
            id: 'cmd-' + Date.now(),
            session_id: '',
            role: 'assistant',
            content: `## Available Commands\n\n- **/help** — Show this help\n- **/clear** — Clear feed display\n- **/cost** — Show token usage\n\n**Tips:**\n- Type \`/\` to browse commands\n- Type \`@\` to mention files\n- Use Shift+Enter for new line`,
            created_at: new Date().toISOString(),
            token_usage: null,
          };
          setMessages((prev) => [...prev, helpMessage]);
          break;
        }
        case '/clear':
          setMessages([]);
          break;
        case '/cost': {
          let totalInput = 0;
          let totalOutput = 0;
          let turnCount = 0;
          for (const msg of messages) {
            if (msg.token_usage) {
              try {
                const usage =
                  typeof msg.token_usage === 'string'
                    ? JSON.parse(msg.token_usage)
                    : msg.token_usage;
                totalInput += usage.input_tokens || 0;
                totalOutput += usage.output_tokens || 0;
                turnCount++;
              } catch {
                /* skip */
              }
            }
          }
          const total = totalInput + totalOutput;
          const costMessage: Message = {
            id: 'cmd-' + Date.now(),
            session_id: '',
            role: 'assistant',
            content:
              turnCount === 0
                ? `## Token Usage\n\nNo token usage data yet.`
                : `## Token Usage\n\n| Metric | Count |\n|--------|-------|\n| Input tokens | ${totalInput.toLocaleString()} |\n| Output tokens | ${totalOutput.toLocaleString()} |\n| **Total** | **${total.toLocaleString()}** |\n| Turns | ${turnCount} |`,
            created_at: new Date().toISOString(),
            token_usage: null,
          };
          setMessages((prev) => [...prev, costMessage]);
          break;
        }
        default:
          sendMessage(command);
      }
    },
    [messages, sendMessage]
  );

  // Auto-send queued message when streaming completes
  useEffect(() => {
    if (!isStreaming && queuedMessage) {
      const { content, files } = queuedMessage;
      const wasInterrupt = interruptRef.current;
      interruptRef.current = false;
      setQueuedMessage(null);
      setTimeout(() => sendMessage(content, files), wasInterrupt ? 0 : 100);
    }
  }, [isStreaming, queuedMessage, sendMessage]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MessageList
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        toolUses={toolUses}
        toolResults={toolResults}
        streamingToolOutput={streamingToolOutput}
        statusText={statusText}
        pendingPermission={currentPermission}
        permissionQueueLength={permissionQueue.length}
        onPermissionResponse={handlePermissionResponse}
        permissionResolved={permissionResolved}
        onForceStop={stopStreaming}
        contentWidth={contentWidth}
      />
      <MessageInput
        onSend={sendMessage}
        onCommand={handleCommand}
        onStop={stopStreaming}
        onInterrupt={interruptStreaming}
        hasQueuedMessage={!!queuedMessage}
        onClearQueue={() => setQueuedMessage(null)}
        disabled={false}
        isStreaming={isStreaming}
        modelName={currentModel}
        onModelChange={setCurrentModel}
        workingDirectory={workingDir}
        onWorkingDirectoryChange={handleWorkingDirectoryChange}
        mode={mode}
        onModeChange={setMode}
        messages={messages}
        contentWidth={contentWidth}
      />
    </div>
  );
}
