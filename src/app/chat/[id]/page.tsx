'use client';

import { useEffect, useState, useCallback, useRef, use } from 'react';
import type { Message, MessagesResponse, ChatSession } from '@/types';
import { getEffectiveProjectTag } from '@/types';
import { ChatView } from '@/components/chat/ChatView';
import { ProjectTagEditor } from '@/components/chat/ProjectTagEditor';
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { usePanel } from '@/hooks/usePanel';
import { ConnectionStatus } from '@/components/layout/ConnectionStatus';

interface ChatSessionPageProps {
  params: Promise<{ id: string }>;
}

export default function ChatSessionPage({ params }: ChatSessionPageProps) {
  const { id } = use(params);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string>('');
  const [sessionModel, setSessionModel] = useState<string>('');
  const [sessionMode, setSessionMode] = useState<string>('');
  const [sessionProjectName, setSessionProjectName] = useState<string>('');
  const [sessionProjectTag, setSessionProjectTag] = useState<string | null>(null);
  const [sessionTagSource, setSessionTagSource] = useState<'inferred' | 'manual' | null>(null);
  const [allProjectTags, setAllProjectTags] = useState<string[]>([]);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingTitleValue, setEditingTitleValue] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const { setWorkingDirectory, setSessionId, setSessionTitle: setPanelSessionTitle } = usePanel();

  const saveTitle = useCallback(async (newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed || trimmed === sessionTitle) {
      setIsEditingTitle(false);
      return;
    }
    setSessionTitle(trimmed);
    setPanelSessionTitle(trimmed);
    setIsEditingTitle(false);
    try {
      await fetch(`/api/chat/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
    } catch {
      // Best effort
    }
  }, [id, sessionTitle, setPanelSessionTitle]);

  const startEditingTitle = useCallback(() => {
    setEditingTitleValue(sessionTitle);
    setIsEditingTitle(true);
  }, [sessionTitle]);

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  // Load session info and set working directory
  useEffect(() => {
    async function loadSession() {
      try {
        const res = await fetch(`/api/chat/sessions/${id}`);
        if (res.ok) {
          const data: { session: ChatSession } = await res.json();
          if (data.session.working_directory) {
            setWorkingDirectory(data.session.working_directory);
          }
          setSessionId(id);
          const title = data.session.title || 'New Conversation';
          setSessionTitle(title);
          setPanelSessionTitle(title);
          setSessionModel(data.session.model || '');
          setSessionMode(data.session.mode || 'code');
          setSessionProjectName(data.session.project_name || '');
          setSessionProjectTag(data.session.project_tag ?? null);
          setSessionTagSource(data.session.project_tag_source ?? null);
        }
      } catch {
        // Session info load failed - panel will still work without directory
      }
    }

    async function loadProjectTags() {
      try {
        const res = await fetch('/api/turns/projects');
        if (res.ok) {
          const data = await res.json();
          setAllProjectTags(data.tags || []);
        }
      } catch {
        // Best effort
      }
    }

    loadSession();
    loadProjectTags();
  }, [id, setWorkingDirectory, setSessionId, setPanelSessionTitle]);

  const handleProjectTagChange = useCallback(async (newTag: string | null) => {
    setSessionProjectTag(newTag);
    setSessionTagSource(newTag !== null ? 'manual' : null);
    try {
      await fetch(`/api/chat/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_tag: newTag,
          // Manual set → 'manual'; revert (null) → clear source too
          project_tag_source: newTag !== null ? 'manual' : null,
        }),
      });
      // Refresh tags list
      const res = await fetch('/api/turns/projects');
      if (res.ok) {
        const data = await res.json();
        setAllProjectTags(data.tags || []);
      }
      window.dispatchEvent(new CustomEvent('session-updated'));
    } catch {
      // Best effort
    }
  }, [id]);

  // Listen for LLM-inferred project tag updates from the stream
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tag: string; source: string };
      if (detail?.tag) {
        setSessionProjectTag(detail.tag);
        setSessionTagSource('inferred');
        // Refresh tags list
        fetch('/api/turns/projects').then(r => r.json()).then(data => {
          setAllProjectTags(data.tags || []);
        }).catch(() => { /* silent */ });
      }
    };
    window.addEventListener('session-project-tag', handler);
    return () => window.removeEventListener('session-project-tag', handler);
  }, []);

  useEffect(() => {
    // Reset state when switching sessions
    setLoading(true);
    setError(null);
    setMessages([]);

    let cancelled = false;

    async function loadMessages() {
      try {
        const res = await fetch(`/api/chat/sessions/${id}/messages`);
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 404) {
            setError('Session not found');
            return;
          }
          throw new Error('Failed to load messages');
        }
        const data: MessagesResponse = await res.json();
        if (cancelled) return;
        setMessages(data.messages);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load messages');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadMessages();

    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <HugeiconsIcon icon={Loading02Icon} className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-destructive font-medium">{error}</p>
          <a href="/project/current" className="text-sm text-muted-foreground hover:underline">
            Start a new chat
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Chat title bar */}
      <div className="flex items-center px-4 py-2">
        <div className="flex-1 min-w-0 flex items-center">
          <span className="text-[0.5625rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/60 font-medium">
            Legacy
          </span>
        </div>
        {sessionTitle && (
          isEditingTitle ? (
            <input
              ref={titleInputRef}
              value={editingTitleValue}
              onChange={(e) => setEditingTitleValue(e.target.value)}
              onBlur={() => saveTitle(editingTitleValue)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle(editingTitleValue);
                if (e.key === 'Escape') setIsEditingTitle(false);
              }}
              className="text-sm font-medium text-foreground/80 max-w-md bg-transparent border-b border-foreground/30 outline-none text-center"
            />
          ) : (
            <button
              type="button"
              onClick={startEditingTitle}
              className="text-sm font-medium text-foreground/80 truncate max-w-md hover:text-foreground transition-colors cursor-text"
            >
              {sessionTitle}
            </button>
          )
        )}
        <div className="flex-1 min-w-0 flex items-center justify-end gap-2">
          {(sessionProjectName || sessionProjectTag) && (
            <ProjectTagEditor
              currentTag={sessionProjectTag || sessionProjectName}
              isManualOverride={sessionTagSource === 'manual'}
              autoTag={sessionProjectName}
              allTags={allProjectTags}
              onTagChange={handleProjectTagChange}
              variant="header"
            />
          )}
          <ConnectionStatus />
        </div>
      </div>
      <ChatView key={id} sessionId={id} initialMessages={messages} modelName={sessionModel} initialMode={sessionMode} />
    </div>
  );
}
