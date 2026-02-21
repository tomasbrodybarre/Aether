"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useCallback, useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  Search01Icon,
  FileImportIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ProjectTagEditor } from "@/components/chat/ProjectTagEditor";

import { ImportSessionDialog } from "./ImportSessionDialog";
import type { ChatSession, TurnRecord } from "@/types";
import { getEffectiveProjectTag } from "@/types";

interface ChatListPanelProps {
  open: boolean;
  width?: number;
}

// ─── Helpers ──────────────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr.includes("T") ? dateStr : dateStr + "Z");
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

const MODE_BADGE_CONFIG: Record<string, { label: string; className: string }> = {
  code: { label: "Code", className: "bg-blue-500/10 text-blue-500" },
  plan: { label: "Plan", className: "bg-sky-500/10 text-sky-500" },
  ask: { label: "Ask", className: "bg-green-500/10 text-green-500" },
};

const CURRENT_PROJECT_KEY = "__current__";

interface ProjectGroup {
  tag: string; // CURRENT_PROJECT_KEY for untagged
  displayName: string;
  turns: TurnRecord[];
  latestTime: string; // for sorting
}

function groupTurnsByProject(turns: TurnRecord[]): ProjectGroup[] {
  const map = new Map<string, TurnRecord[]>();

  for (const turn of turns) {
    const key = turn.project_tag || CURRENT_PROJECT_KEY;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(turn);
  }

  const groups: ProjectGroup[] = [];
  for (const [key, groupTurns] of map) {
    // Sort turns within group: newest first for sidebar display
    groupTurns.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    groups.push({
      tag: key,
      displayName: key === CURRENT_PROJECT_KEY ? "Current" : key,
      turns: groupTurns,
      latestTime: groupTurns[0].created_at,
    });
  }

  // Sort groups: "Current" always first, then by most recent activity
  groups.sort((a, b) => {
    if (a.tag === CURRENT_PROJECT_KEY) return -1;
    if (b.tag === CURRENT_PROJECT_KEY) return 1;
    return (
      new Date(b.latestTime).getTime() - new Date(a.latestTime).getTime()
    );
  });

  return groups;
}

// ─── Component ────────────────────────────────────────────

export function ChatListPanel({ open, width }: ChatListPanelProps) {
  const pathname = usePathname();
  const router = useRouter();

  // Data
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [allProjectTags, setAllProjectTags] = useState<string[]>([]);

  // UI state
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set([CURRENT_PROJECT_KEY])
  );
  const [showLegacy, setShowLegacy] = useState(false);
  const [hoveredTurn, setHoveredTurn] = useState<string | null>(null);
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  // ─── Data fetching ────────────────────────────────────

  const fetchTurns = useCallback(async () => {
    try {
      const res = await fetch("/api/turns?limit=200");
      if (res.ok) {
        const data = await res.json();
        setTurns(data.turns || []);
      }
    } catch {
      // API may not be available yet
    }
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch {
      // API may not be available yet
    }
  }, []);

  const fetchProjectTags = useCallback(async () => {
    try {
      const res = await fetch("/api/turns/projects");
      if (res.ok) {
        const data = await res.json();
        setAllProjectTags(data.tags || []);
      }
    } catch {
      // API may not be available yet
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchTurns();
    fetchSessions();
    fetchProjectTags();
  }, [fetchTurns, fetchSessions, fetchProjectTags]);

  // Refresh on navigation
  useEffect(() => {
    fetchTurns();
  }, [pathname, fetchTurns]);

  // Refresh on events
  useEffect(() => {
    const handler = () => {
      fetchTurns();
      fetchProjectTags();
    };
    // Listen for both legacy session events and new turn events
    window.addEventListener("session-created", handler);
    window.addEventListener("session-updated", handler);
    window.addEventListener("turn-created", handler);
    window.addEventListener("turn-updated", handler);
    return () => {
      window.removeEventListener("session-created", handler);
      window.removeEventListener("session-updated", handler);
      window.removeEventListener("turn-created", handler);
      window.removeEventListener("turn-updated", handler);
    };
  }, [fetchTurns, fetchProjectTags]);

  // ─── Filtering ────────────────────────────────────────

  const filteredTurns = useMemo(() => {
    if (!searchQuery) return turns;
    const q = searchQuery.toLowerCase();
    return turns.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.prompt.toLowerCase().includes(q) ||
        (t.project_tag && t.project_tag.toLowerCase().includes(q))
    );
  }, [turns, searchQuery]);

  const projectGroups = useMemo(
    () => groupTurnsByProject(filteredTurns),
    [filteredTurns]
  );

  const filteredSessions = useMemo(() => {
    if (!searchQuery) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.project_name && s.project_name.toLowerCase().includes(q)) ||
        (s.project_tag && s.project_tag.toLowerCase().includes(q))
    );
  }, [sessions, searchQuery]);

  // ─── Expand / collapse ─────────────────────────────────

  // Auto-expand the active project based on current pathname
  useEffect(() => {
    const match = pathname.match(/^\/project\/(.+?)(?:#|$)/);
    if (match) {
      const tag = decodeURIComponent(match[1]);
      const key = tag === "current" ? CURRENT_PROJECT_KEY : tag;
      setExpandedProjects((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    }
  }, [pathname]);

  const toggleProject = useCallback((key: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ─── Actions ──────────────────────────────────────────

  const handleDeleteTurn = async (e: React.MouseEvent, turnId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this turn?")) return;
    setDeletingId(turnId);
    try {
      const res = await fetch(`/api/turns/${turnId}`, { method: "DELETE" });
      if (res.ok) {
        setTurns((prev) => prev.filter((t) => t.id !== turnId));
        fetchProjectTags();
      }
    } catch {
      // Silently fail
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteSession = async (
    e: React.MouseEvent,
    sessionId: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this conversation?")) return;
    setDeletingId(sessionId);
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (pathname === `/chat/${sessionId}`) {
          router.push("/project/current");
        }
      }
    } catch {
      // Silently fail
    } finally {
      setDeletingId(null);
    }
  };

  const handleTurnTagChange = useCallback(
    async (turnId: string, newTag: string | null) => {
      const newSource = newTag ? ("manual" as const) : null;
      // Optimistic update
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId
            ? { ...t, project_tag: newTag, project_tag_source: newSource }
            : t
        )
      );
      try {
        await fetch(`/api/turns/${turnId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project_tag: newTag,
            project_tag_source: newSource,
          }),
        });
        fetchProjectTags();
        window.dispatchEvent(new CustomEvent("turn-updated"));
      } catch {
        fetchTurns();
      }
    },
    [fetchTurns, fetchProjectTags]
  );

  // ─── Render ───────────────────────────────────────────

  if (!open) return null;

  const projectHref = (tag: string) =>
    tag === CURRENT_PROJECT_KEY
      ? "/project/current"
      : `/project/${encodeURIComponent(tag)}`;

  const turnHref = (turn: TurnRecord) => {
    const base = turn.project_tag
      ? `/project/${encodeURIComponent(turn.project_tag)}`
      : "/project/current";
    return `${base}#${turn.id}`;
  };

  return (
    <aside
      className="hidden h-full shrink-0 flex-col overflow-hidden bg-sidebar lg:flex"
      style={{ width: width ?? 240 }}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between px-3 mt-5 pl-6">
        <span className="text-[0.8125rem] font-semibold tracking-tight text-sidebar-foreground">
          Projects
        </span>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder="Search turns..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {/* Project list */}
      <ScrollArea className="flex-1 min-h-0 px-3">
        <div className="flex flex-col pb-3">
          {/* Turns grouped by project */}
          {projectGroups.length === 0 && !filteredSessions.length ? (
            <p className="px-2.5 py-3 text-[0.6875rem] text-muted-foreground/60">
              {searchQuery ? "No matching turns" : "No conversations yet"}
            </p>
          ) : (
            <>
              {projectGroups.map((group) => {
                const isExpanded = expandedProjects.has(group.tag);
                const isActiveProject =
                  pathname === projectHref(group.tag) ||
                  pathname.startsWith(
                    group.tag === CURRENT_PROJECT_KEY
                      ? "/project/current"
                      : `/project/${encodeURIComponent(group.tag)}`
                  );

                return (
                  <div key={group.tag} className="mt-1 first:mt-0">
                    {/* Project header */}
                    <button
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left transition-colors",
                        isActiveProject
                          ? "bg-sidebar-accent/50 text-sidebar-accent-foreground"
                          : "text-sidebar-foreground hover:bg-accent/40"
                      )}
                      onClick={() => toggleProject(group.tag)}
                    >
                      <HugeiconsIcon
                        icon={isExpanded ? ArrowDown01Icon : ArrowRight01Icon}
                        className="h-3 w-3 shrink-0 text-muted-foreground"
                      />
                      <span className="text-[0.8125rem] font-medium leading-tight truncate">
                        {group.displayName}
                      </span>
                      <span className="ml-auto text-[0.625rem] text-muted-foreground/40 shrink-0">
                        {group.turns.length}
                      </span>
                    </button>

                    {/* Turns list (when expanded) */}
                    {isExpanded && (
                      <div className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-border/40 pl-2">
                        {group.turns.map((turn) => {
                          const isHovered = hoveredTurn === turn.id;
                          const isDeleting = deletingId === turn.id;
                          const mode = turn.mode || "code";
                          const badgeCfg =
                            MODE_BADGE_CONFIG[mode] || MODE_BADGE_CONFIG.code;
                          const isManualTag =
                            turn.project_tag_source === "manual";

                          return (
                            <div
                              key={turn.id}
                              className="group relative"
                              onMouseEnter={() => setHoveredTurn(turn.id)}
                              onMouseLeave={() => setHoveredTurn(null)}
                            >
                              <Link
                                href={turnHref(turn)}
                                className={cn(
                                  "flex flex-col gap-0.5 rounded-md px-2 py-1.5 transition-all duration-150",
                                  "text-sidebar-foreground hover:bg-accent/50"
                                )}
                              >
                                <span className="line-clamp-2 text-[0.75rem] leading-tight break-all">
                                  {turn.title}
                                </span>
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span
                                    className={cn(
                                      "text-[0.5625rem] px-1 py-0.5 rounded font-medium leading-none shrink-0",
                                      badgeCfg.className
                                    )}
                                  >
                                    {badgeCfg.label}
                                  </span>
                                  {turn.project_tag && (
                                    <ProjectTagEditor
                                      currentTag={turn.project_tag}
                                      isManualOverride={isManualTag}
                                      autoTag=""
                                      allTags={allProjectTags}
                                      onTagChange={(tag) =>
                                        handleTurnTagChange(turn.id, tag)
                                      }
                                      variant="sidebar"
                                    />
                                  )}
                                  <span className="text-[0.625rem] text-muted-foreground/40 shrink-0 ml-auto">
                                    {formatRelativeTime(turn.created_at)}
                                  </span>
                                </div>
                              </Link>
                              {(isHovered || isDeleting) && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      className="absolute right-0.5 top-1 text-muted-foreground/60 hover:text-destructive"
                                      onClick={(e) =>
                                        handleDeleteTurn(e, turn.id)
                                      }
                                      disabled={isDeleting}
                                    >
                                      <HugeiconsIcon
                                        icon={Delete02Icon}
                                        className="h-3 w-3"
                                      />
                                      <span className="sr-only">
                                        Delete turn
                                      </span>
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="right">
                                    Delete
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                          );
                        })}

                        {/* Link to full project feed */}
                        <Link
                          href={projectHref(group.tag)}
                          className="px-2 py-1 text-[0.625rem] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                        >
                          View all in feed
                        </Link>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Legacy sessions (collapsed section) */}
              {filteredSessions.length > 0 && (
                <div className="mt-3">
                  <div className="h-px bg-border/40 mb-2" />
                  <button
                    className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-sidebar-foreground hover:bg-accent/40 transition-colors"
                    onClick={() => setShowLegacy(!showLegacy)}
                  >
                    <HugeiconsIcon
                      icon={
                        showLegacy ? ArrowDown01Icon : ArrowRight01Icon
                      }
                      className="h-3 w-3 shrink-0 text-muted-foreground"
                    />
                    <span className="text-[0.75rem] font-medium text-muted-foreground">
                      Legacy Sessions
                    </span>
                    <span className="ml-auto text-[0.625rem] text-muted-foreground/40 shrink-0">
                      {filteredSessions.length}
                    </span>
                  </button>

                  {showLegacy && (
                    <div className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-border/40 pl-2">
                      {filteredSessions.map((session) => {
                        const isActive =
                          pathname === `/chat/${session.id}`;
                        const isHovered =
                          hoveredSession === session.id;
                        const isDeleting = deletingId === session.id;
                        const effectiveTag =
                          getEffectiveProjectTag(session);

                        return (
                          <div
                            key={session.id}
                            className="group relative"
                            onMouseEnter={() =>
                              setHoveredSession(session.id)
                            }
                            onMouseLeave={() =>
                              setHoveredSession(null)
                            }
                          >
                            <Link
                              href={`/chat/${session.id}`}
                              className={cn(
                                "flex flex-col gap-0.5 rounded-md px-2 py-1.5 transition-all duration-150",
                                isActive
                                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                  : "text-sidebar-foreground hover:bg-accent/50"
                              )}
                            >
                              <span className="line-clamp-2 text-[0.75rem] leading-tight break-all">
                                {session.title}
                              </span>
                              <div className="flex items-center gap-1.5 min-w-0">
                                {effectiveTag && (
                                  <span className="text-[0.625rem] text-muted-foreground/50 truncate">
                                    {effectiveTag}
                                  </span>
                                )}
                                <span className="text-[0.625rem] text-muted-foreground/40 shrink-0 ml-auto">
                                  {formatRelativeTime(
                                    session.updated_at
                                  )}
                                </span>
                              </div>
                            </Link>
                            {(isHovered || isDeleting) && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="absolute right-0.5 top-1 text-muted-foreground/60 hover:text-destructive"
                                    onClick={(e) =>
                                      handleDeleteSession(
                                        e,
                                        session.id
                                      )
                                    }
                                    disabled={isDeleting}
                                  >
                                    <HugeiconsIcon
                                      icon={Delete02Icon}
                                      className="h-3 w-3"
                                    />
                                    <span className="sr-only">
                                      Delete session
                                    </span>
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                  Delete
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      {/* Import + Version footer */}
      <div className="shrink-0 px-3 py-2 flex flex-col gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 h-7 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setImportDialogOpen(true)}
            >
              <HugeiconsIcon icon={FileImportIcon} className="h-3 w-3" />
              Import CLI Session
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            Import conversations from Gemini CLI
          </TooltipContent>
        </Tooltip>
        <span className="text-[0.625rem] text-muted-foreground/40 text-center">
          v{process.env.NEXT_PUBLIC_APP_VERSION}
        </span>
      </div>

      {/* Import CLI Session Dialog */}
      <ImportSessionDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
      />
    </aside>
  );
}
