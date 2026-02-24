'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useTheme } from 'next-themes';
import type { CodeSegment } from '@/lib/parse-segments';
import {
  PencilIcon,
  XIcon,
  MessageSquareIcon,
  CheckIcon,
  CopyIcon,
  CloudIcon,
  FileIcon,
} from 'lucide-react';

/** Language tags that indicate prose content (serif font, line-wrapped view) */
const PROSE_LANGUAGES = new Set(['text', 'prose', 'markdown', 'md']);

interface EditableCellProps {
  segment: CodeSegment;
  segmentIndex: number;
  turnId: string;
  onDiscuss: (segmentIndex: number, newContent: string) => void;
  onSave: (segmentIndex: number, newContent: string) => Promise<{ gdocsPush?: boolean; fileWritten?: boolean }> | void;
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
  const [showFileWritten, setShowFileWritten] = useState(false);
  const { resolvedTheme } = useTheme();
  const editorContainerRef = useRef<HTMLDivElement>(null);

  const isProse = PROSE_LANGUAGES.has(segment.language.toLowerCase());

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
    if (result?.fileWritten) {
      setShowFileWritten(true);
      setTimeout(() => setShowFileWritten(false), 2500);
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
          <div className="flex items-center gap-2 min-w-0">
            <PencilIcon className="h-3 w-3 shrink-0" />
            <span className="font-medium shrink-0">Editing</span>
            <span className="bg-amber-800/50 rounded px-1.5 py-0.5 shrink-0">{langLabel}</span>
            {segment.filePath && (
              <span className="text-amber-400/70 font-mono text-[0.65rem] truncate" title={`Saves to: ${segment.filePath}`}>
                → {segment.filePath}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
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
            language={segment.language}
            isProse={isProse}
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
        <div className="flex items-center gap-2 min-w-0">
          <span className="bg-zinc-700/50 rounded px-1.5 py-0.5 shrink-0">{langLabel}</span>
          {segment.filePath && (
            <span className="text-zinc-500 font-mono text-[0.7rem] truncate max-w-[300px]" title={segment.filePath}>
              {segment.filePath}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {showCloud && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-blue-400 animate-pulse">
              <CloudIcon className="h-3 w-3" />
              <span className="text-xs">Synced</span>
            </span>
          )}
          {showFileWritten && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-green-400 animate-pulse">
              <FileIcon className="h-3 w-3" />
              <span className="text-xs">Written</span>
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

      {/* Content — prose gets serif font, code gets monospace */}
      {isProse ? (
        <div className="bg-zinc-900 dark:bg-zinc-950 px-5 py-4 text-[0.9375rem] leading-[1.8] text-zinc-200 break-words font-serif" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
          {segment.content}
        </div>
      ) : (
        <div className="bg-zinc-900 dark:bg-zinc-950 px-4 py-3 text-sm leading-relaxed text-zinc-300 font-mono overflow-x-auto" style={{ whiteSpace: 'pre', tabSize: 4 }}>
          {segment.content}
        </div>
      )}
    </div>
  );
}

/**
 * Lazy-loaded CodeMirror editor to avoid SSR issues and reduce initial bundle.
 * CodeMirror is only loaded when the user enters edit mode.
 * Supports language-specific syntax highlighting via @codemirror/language-data.
 */
function LazyCodeMirrorEditor({
  value,
  onChange,
  isDark,
  language,
  isProse,
}: {
  value: string;
  onChange: (val: string) => void;
  isDark: boolean;
  language?: string;
  isProse?: boolean;
}) {
  const [CodeMirror, setCodeMirror] = useState<typeof import('@uiw/react-codemirror').default | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [langExtension, setLangExtension] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [themes, setThemes] = useState<{ oneDark: any } | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [lineWrapping, setLineWrapping] = useState<any>(null);
  const [langLoaded, setLangLoaded] = useState(false);

  // Load CodeMirror core + theme
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      import('@uiw/react-codemirror'),
      import('@codemirror/theme-one-dark'),
    ]).then(([cm, theme]) => {
      if (cancelled) return;
      setCodeMirror(() => cm.default);
      setThemes({ oneDark: theme.oneDark });
      setLineWrapping(() => cm.EditorView.lineWrapping);
    });
    return () => { cancelled = true; };
  }, []);

  // Load language extension
  useEffect(() => {
    let cancelled = false;
    if (!language) {
      setLangLoaded(true);
      return;
    }

    if (isProse) {
      // For prose languages, use markdown mode
      import('@codemirror/lang-markdown').then((md) => {
        if (cancelled) return;
        setLangExtension(() => md.markdown());
        setLangLoaded(true);
      });
    } else {
      // For code languages, use @codemirror/language-data for auto-matching
      import('@codemirror/language-data').then(({ languages }) => {
        if (cancelled) return;
        const lang = language.toLowerCase();
        const desc = languages.find(l =>
          l.name.toLowerCase() === lang
          || l.alias.some(a => a.toLowerCase() === lang)
        );
        if (desc) {
          desc.load().then(sup => {
            if (cancelled) return;
            setLangExtension(() => sup);
            setLangLoaded(true);
          });
        } else {
          setLangLoaded(true);
        }
      });
    }
    return () => { cancelled = true; };
  }, [language, isProse]);

  if (!CodeMirror || !themes || !lineWrapping || !langLoaded) {
    // Loading fallback — plain textarea
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full min-h-[200px] bg-zinc-900 text-zinc-200 p-4 border-0 outline-none resize-y ${isProse ? 'font-serif text-[0.9375rem] leading-[1.8]' : 'font-mono text-sm leading-relaxed'}`}
        autoFocus
      />
    );
  }

  const extensions = [lineWrapping];
  if (langExtension) extensions.push(langExtension);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={isDark ? themes.oneDark : 'light'}
      basicSetup={{
        lineNumbers: true,
        foldGutter: !isProse,
        highlightActiveLine: true,
        bracketMatching: !isProse,
      }}
      autoFocus
      minHeight="100px"
      className="text-sm"
    />
  );
}
