'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import type { CodeSegment } from '@/lib/parse-segments';
import {
  PencilIcon,
  XIcon,
  MessageSquareIcon,
  CheckIcon,
  CopyIcon,
  CloudIcon,
} from 'lucide-react';

interface EditableCellProps {
  segment: CodeSegment;
  segmentIndex: number;
  turnId: string;
  onDiscuss: (segmentIndex: number, newContent: string) => void;
  onSave: (segmentIndex: number, newContent: string) => Promise<{ gdocsPush?: boolean }> | void;
}

export function EditableCell({
  segment,
  segmentIndex,
  turnId,
  onDiscuss,
  onSave,
}: EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(segment.content);
  const [copied, setCopied] = useState(false);
  const [showCloud, setShowCloud] = useState(false);
  const { resolvedTheme } = useTheme();
  const editorContainerRef = useRef<HTMLDivElement>(null);

  // Sync content when segment changes (e.g. after save updates response)
  useEffect(() => {
    if (!isEditing) {
      setEditContent(segment.content);
    }
  }, [segment.content, isEditing]);

  const enterEditMode = useCallback(() => {
    setEditContent(segment.content);
    setIsEditing(true);
  }, [segment.content]);

  const handleDiscard = useCallback(() => {
    setEditContent(segment.content);
    setIsEditing(false);
  }, [segment.content]);

  const handleDiscuss = useCallback(() => {
    if (editContent === segment.content) {
      // No changes made
      setIsEditing(false);
      return;
    }
    onDiscuss(segmentIndex, editContent);
    setIsEditing(false);
  }, [editContent, segment.content, segmentIndex, onDiscuss]);

  const handleSave = useCallback(async () => {
    if (editContent === segment.content) {
      setIsEditing(false);
      return;
    }
    const result = await onSave(segmentIndex, editContent);
    setIsEditing(false);
    if (result?.gdocsPush) {
      setShowCloud(true);
      setTimeout(() => setShowCloud(false), 2500);
    }
  }, [editContent, segment.content, segmentIndex, onSave]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(segment.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  }, [segment.content]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDiscard();
      }
    },
    [handleDiscard]
  );

  const langLabel = segment.language.toUpperCase() || 'TEXT';

  if (isEditing) {
    return (
      <div
        className="relative my-3 rounded-lg overflow-hidden border-2 border-amber-500/50"
        onKeyDown={handleKeyDown}
      >
        {/* Edit mode header */}
        <div className="flex items-center justify-between px-4 py-1.5 text-xs bg-amber-950/30 dark:bg-amber-950/40 text-amber-200">
          <div className="flex items-center gap-2">
            <PencilIcon className="h-3 w-3" />
            <span className="font-medium">Editing</span>
            <span className="bg-amber-800/50 rounded px-1.5 py-0.5">{langLabel}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleDiscard}
              className="flex items-center gap-1 rounded px-2 py-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
              title="Discard (Escape)"
            >
              <XIcon className="h-3 w-3" />
              <span>Discard</span>
            </button>
            <button
              type="button"
              onClick={handleDiscuss}
              className="flex items-center gap-1 rounded px-2 py-1 text-blue-400 hover:text-blue-300 hover:bg-blue-900/30 transition-colors"
              title="Send diff to agent for discussion"
            >
              <MessageSquareIcon className="h-3 w-3" />
              <span>Discuss</span>
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="flex items-center gap-1 rounded px-2 py-1 text-green-400 hover:text-green-300 hover:bg-green-900/30 transition-colors"
              title="Save edit (finalize)"
            >
              <CheckIcon className="h-3 w-3" />
              <span>Save</span>
            </button>
          </div>
        </div>

        {/* CodeMirror editor — lazy loaded */}
        <div ref={editorContainerRef}>
          <LazyCodeMirrorEditor
            value={editContent}
            onChange={setEditContent}
            isDark={resolvedTheme === 'dark'}
          />
        </div>
      </div>
    );
  }

  // View mode
  return (
    <div
      className="relative group/cell my-3 rounded-lg overflow-hidden border border-zinc-700/50 cursor-pointer"
      onDoubleClick={enterEditMode}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-1.5 text-xs bg-zinc-800 dark:bg-zinc-900 text-zinc-400">
        <div className="flex items-center gap-2">
          <span className="bg-zinc-700/50 rounded px-1.5 py-0.5">{langLabel}</span>
        </div>
        <div className="flex items-center gap-1">
          {showCloud && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-blue-400 animate-pulse">
              <CloudIcon className="h-3 w-3" />
              <span className="text-xs">Synced</span>
            </span>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleCopy(); }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
            title="Copy content"
          >
            {copied ? (
              <><CheckIcon className="h-3 w-3" /><span>Copied</span></>
            ) : (
              <><CopyIcon className="h-3 w-3" /><span>Copy</span></>
            )}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); enterEditMode(); }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-400 hover:text-amber-300 hover:bg-amber-900/20 transition-colors"
            title="Edit this block"
          >
            <PencilIcon className="h-3 w-3" />
            <span>Edit</span>
          </button>
        </div>
      </div>

      {/* Content — rendered as literary prose */}
      <div className="bg-zinc-900 dark:bg-zinc-950 px-5 py-4 text-[0.9375rem] leading-[1.8] text-zinc-200 break-words font-serif" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        {segment.content}
      </div>
    </div>
  );
}

/**
 * Lazy-loaded CodeMirror editor to avoid SSR issues and reduce initial bundle.
 * CodeMirror is only loaded when the user enters edit mode.
 */
function LazyCodeMirrorEditor({
  value,
  onChange,
  isDark,
}: {
  value: string;
  onChange: (val: string) => void;
  isDark: boolean;
}) {
  const [CodeMirror, setCodeMirror] = useState<typeof import('@uiw/react-codemirror').default | null>(null);
  const [markdownLang, setMarkdownLang] = useState<typeof import('@codemirror/lang-markdown').markdown | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [themes, setThemes] = useState<{ oneDark: any } | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [lineWrapping, setLineWrapping] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      import('@uiw/react-codemirror'),
      import('@codemirror/lang-markdown'),
      import('@codemirror/theme-one-dark'),
    ]).then(([cm, md, theme]) => {
      if (cancelled) return;
      setCodeMirror(() => cm.default);
      setMarkdownLang(() => md.markdown);
      setThemes({ oneDark: theme.oneDark });
      setLineWrapping(() => cm.EditorView.lineWrapping);
    });
    return () => { cancelled = true; };
  }, []);

  if (!CodeMirror || !markdownLang || !themes || !lineWrapping) {
    // Loading fallback — plain textarea
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-h-[200px] bg-zinc-900 text-zinc-200 font-serif text-[0.9375rem] leading-[1.8] p-4 border-0 outline-none resize-y"
        autoFocus
      />
    );
  }

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={[markdownLang(), lineWrapping]}
      theme={isDark ? themes.oneDark : 'light'}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
        bracketMatching: false,
      }}
      autoFocus
      minHeight="100px"
      className="text-sm"
    />
  );
}
