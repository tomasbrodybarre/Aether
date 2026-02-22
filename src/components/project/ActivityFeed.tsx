"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  File01Icon,
  FileEditIcon,
  CommandLineIcon,
  Search01Icon,
  Wrench01Icon,
  Loading02Icon,
  CheckmarkCircle02Icon,
  CancelCircleIcon,
  Idea01Icon,
} from "@hugeicons/core-free-icons";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { TurnToolCall, TurnThought } from "@/types";

// ---------------------------------------------------------------------------
// Tool categorization (mirrors tool-actions-group.tsx)
// ---------------------------------------------------------------------------

type ToolCategory = "read" | "write" | "bash" | "search" | "other";

function getToolCategory(name: string): ToolCategory {
  const lower = name.toLowerCase();
  if (lower === "read" || lower === "readfile" || lower === "read_file")
    return "read";
  if (
    lower === "write" || lower === "edit" || lower === "writefile" ||
    lower === "write_file" || lower === "create_file" || lower === "createfile" ||
    lower === "notebookedit" || lower === "notebook_edit"
  )
    return "write";
  if (
    lower === "bash" || lower === "execute" || lower === "run" ||
    lower === "shell" || lower === "execute_command" ||
    lower === "run_shell_command"
  )
    return "bash";
  if (
    lower === "search" || lower === "glob" || lower === "grep" ||
    lower === "find_files" || lower === "search_files" ||
    lower === "websearch" || lower === "web_search"
  )
    return "search";
  return "other";
}

function getToolIcon(category: ToolCategory): IconSvgElement {
  switch (category) {
    case "read":   return File01Icon;
    case "write":  return FileEditIcon;
    case "bash":   return CommandLineIcon;
    case "search": return Search01Icon;
    case "other":  return Wrench01Icon;
  }
}

function getCategoryColor(category: ToolCategory): string {
  switch (category) {
    case "read":   return "text-blue-400/70";
    case "write":  return "text-amber-400/70";
    case "bash":   return "text-green-400/70";
    case "search": return "text-violet-400/70";
    case "other":  return "text-muted-foreground/60";
  }
}

// ---------------------------------------------------------------------------
// Activity item types
// ---------------------------------------------------------------------------

interface ActivityItem {
  id: string;
  type: "tool_call" | "thought";
  timestamp: string;
  // tool_call fields
  toolName?: string;
  toolInput?: string | null;
  status?: "running" | "done" | "error";
  // thought fields
  text?: string;
}

// ---------------------------------------------------------------------------
// ActivityFeed
// ---------------------------------------------------------------------------

interface ActivityFeedProps {
  projectTag: string | null;
}

export function ActivityFeed({ projectTag }: ActivityFeedProps) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch historical activity for the most recent turn
  const fetchActivity = useCallback(
    async (turnId: string) => {
      try {
        const res = await fetch(`/api/turns/${encodeURIComponent(turnId)}/activity`);
        if (!res.ok) return;
        const data = await res.json();

        const newItems: ActivityItem[] = [];

        // Merge tool calls and thoughts by timestamp
        const toolCalls: TurnToolCall[] = data.toolCalls || [];
        const thoughts: TurnThought[] = data.thoughts || [];

        for (const tc of toolCalls) {
          newItems.push({
            id: tc.id,
            type: "tool_call",
            timestamp: tc.created_at,
            toolName: tc.tool_name,
            toolInput: tc.tool_input,
            status: tc.result_content !== null
              ? (tc.is_error ? "error" : "done")
              : "done", // historical items are always complete
          });
        }

        for (const th of thoughts) {
          newItems.push({
            id: th.id,
            type: "thought",
            timestamp: th.created_at,
            text: th.text,
          });
        }

        // Sort chronologically
        newItems.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        setItems(newItems);
      } catch {
        // silent
      }
    },
    [],
  );

  // Fetch recent turn to load initial activity
  useEffect(() => {
    if (!projectTag) return;

    const fetchRecentTurn = async () => {
      try {
        const res = await fetch(
          `/api/turns?project_tag=${encodeURIComponent(projectTag)}&limit=1`,
        );
        if (!res.ok) return;
        const data = await res.json();
        const turns = data.turns || [];
        if (turns.length > 0) {
          setCurrentTurnId(turns[0].id);
          fetchActivity(turns[0].id);
        }
      } catch {
        // silent
      }
    };

    fetchRecentTurn();
  }, [projectTag, fetchActivity]);

  // Listen for turn-created events — clear and track new turn
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.turnId) {
        setCurrentTurnId(detail.turnId);
        setItems([]);
      }
    };
    window.addEventListener("turn-created", handler);
    return () => window.removeEventListener("turn-created", handler);
  }, []);

  // Listen for live activity events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;

      if (detail.type === "tool_use") {
        setItems((prev) => {
          // Deduplicate
          if (prev.some((i) => i.id === detail.id)) return prev;
          return [
            ...prev,
            {
              id: detail.id,
              type: "tool_call",
              timestamp: new Date().toISOString(),
              toolName: detail.name,
              toolInput: typeof detail.input === "string"
                ? detail.input
                : JSON.stringify(detail.input),
              status: "running",
            },
          ];
        });
      } else if (detail.type === "tool_result") {
        setItems((prev) =>
          prev.map((item) => {
            // Match by tool_call_id from the tool_use that started this
            if (
              item.type === "tool_call" &&
              item.id === detail.tool_use_id &&
              item.status === "running"
            ) {
              return {
                ...item,
                status: detail.is_error ? "error" : "done",
              };
            }
            return item;
          }),
        );
      } else if (detail.type === "thought") {
        setItems((prev) => [
          ...prev,
          {
            id: `thought-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: "thought",
            timestamp: new Date().toISOString(),
            text: detail.text,
          },
        ]);
      }

      // Auto-scroll to bottom
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      });
    };

    window.addEventListener("turn-activity", handler);
    return () => window.removeEventListener("turn-activity", handler);
  }, []);

  if (items.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-muted-foreground/40 italic">
        No activity yet
      </p>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col gap-1 pb-2">
        {items.map((item) =>
          item.type === "tool_call" ? (
            <ToolCallItem key={item.id} item={item} />
          ) : (
            <ThoughtItem key={item.id} item={item} />
          ),
        )}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// Item renderers
// ---------------------------------------------------------------------------

function ToolCallItem({ item }: { item: ActivityItem }) {
  const category = getToolCategory(item.toolName || "");
  const icon = getToolIcon(category);
  const colorClass = getCategoryColor(category);

  // Extract a short summary from tool input
  const summary = getToolSummary(item.toolName || "", item.toolInput);

  return (
    <div className="flex items-start gap-2 rounded px-1.5 py-1 hover:bg-muted/20 transition-colors group">
      <HugeiconsIcon
        icon={icon}
        className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${colorClass}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[0.6875rem] font-medium text-foreground/80 truncate">
            {item.toolName}
          </span>
          <StatusIndicator status={item.status || "done"} />
        </div>
        {summary && (
          <p className="text-[0.625rem] text-muted-foreground/50 truncate leading-snug">
            {summary}
          </p>
        )}
      </div>
    </div>
  );
}

/** Try to extract readable text from a thought string that may be raw JSON. */
function parseThoughtText(raw: string): { subject?: string; body: string } {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj === "object" && obj !== null) {
      const subject = obj.subject || obj.title || undefined;
      const body =
        obj.description || obj.text || obj.summary || obj.thought || obj.content ||
        // Fallback: join remaining string values
        Object.entries(obj)
          .filter(([k]) => k !== "subject" && k !== "title")
          .map(([, v]) => (typeof v === "string" ? v : ""))
          .filter(Boolean)
          .join(" — ") ||
        raw;
      return { subject, body };
    }
  } catch {
    // Not JSON — use as-is
  }
  return { body: raw };
}

function ThoughtItem({ item }: { item: ActivityItem }) {
  const [expanded, setExpanded] = useState(false);
  const { subject, body } = parseThoughtText(item.text || "");
  const isLong = body.length > 80;

  return (
    <button
      type="button"
      onClick={() => isLong && setExpanded(!expanded)}
      className="flex items-start gap-2 rounded px-1.5 py-1 hover:bg-muted/20 transition-colors text-left w-full"
    >
      <HugeiconsIcon
        icon={Idea01Icon}
        className="h-3.5 w-3.5 mt-0.5 shrink-0 text-yellow-400/50"
      />
      <div className="min-w-0 flex-1">
        {subject && (
          <p className="text-[0.6875rem] text-muted-foreground/60 font-medium leading-snug truncate">
            {subject}
          </p>
        )}
        <p
          className={`text-[0.625rem] text-muted-foreground/40 italic leading-snug ${
            expanded ? "" : "line-clamp-2"
          }`}
        >
          {body}
        </p>
      </div>
    </button>
  );
}

function StatusIndicator({ status }: { status: "running" | "done" | "error" }) {
  if (status === "running") {
    return (
      <HugeiconsIcon
        icon={Loading02Icon}
        className="h-3 w-3 text-muted-foreground/40 animate-spin shrink-0"
      />
    );
  }
  if (status === "error") {
    return (
      <HugeiconsIcon
        icon={CancelCircleIcon}
        className="h-3 w-3 text-red-400/60 shrink-0"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={CheckmarkCircle02Icon}
      className="h-3 w-3 text-green-400/40 shrink-0"
    />
  );
}

// ---------------------------------------------------------------------------
// Tool input summary extraction
// ---------------------------------------------------------------------------

function getToolSummary(toolName: string, toolInput: string | null | undefined): string {
  if (!toolInput) return "";
  try {
    const input = JSON.parse(toolInput);
    const lower = toolName.toLowerCase();

    // File operations — show filename
    if (lower === "read" || lower === "readfile" || lower === "read_file") {
      return extractFilename(input.file_path || input.path || "");
    }
    if (
      lower === "write" || lower === "edit" || lower === "writefile" ||
      lower === "write_file" || lower === "create_file"
    ) {
      return extractFilename(input.file_path || input.path || "");
    }
    // Bash — show command snippet
    if (
      lower === "bash" || lower === "execute" || lower === "run" ||
      lower === "shell" || lower === "execute_command" ||
      lower === "run_shell_command"
    ) {
      const cmd = input.command || input.cmd || "";
      return cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
    }
    // Search — show query/pattern
    if (lower === "grep" || lower === "search" || lower === "search_files") {
      return input.pattern || input.query || "";
    }
    if (lower === "glob" || lower === "find_files") {
      return input.pattern || input.glob || "";
    }
  } catch {
    // not JSON
  }
  return "";
}

function extractFilename(filepath: string): string {
  if (!filepath) return "";
  const parts = filepath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filepath;
}
