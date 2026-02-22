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

import { ImportSessionDialog } from "./ImportSessionDialog";
import type { ChatSession, TurnRecord } from "@/types";
import { getEffectiveProjectTag } from "@/types";

interface ChatListPanelProps {
  open: boolean;
  width?: number;
}

// ─── Constants ─────────────────────────────────────────────

const TIMELINE_KEY = "__timeline__";
const UNTAGGED_KEY = "__untagged__";

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

interface NavGroup {
  key: string;
  displayName: string;
  href: string;
  count: number;
  latestTime: string | null;
}

function buildNavGroups(turns: TurnRecord[]): NavGroup[] {
  const groups: NavGroup[] = [];

  // Timeline: all turns
  if (turns.length > 0) {
    const newest = turns.reduce((a, b) =>
      new Date(b.created_at).getTime() > new Date(a.created_at).getTime() ? b : a
    );
    groups.push({
      key: TIMELINE_KEY,
      displayName: "Timeline",
      href: "/project/timeline",
      count: turns.length,
      latestTime: newest.created_at,
    });
  } else {
    groups.push({
      key: TIMELINE_KEY,
      displayName: "Timeline",
      href: "/project/timeline",
      count: 0,
      latestTime: null,
    });
  }

  // Untagged
  const untagged = turns.filter((t) => !t.project_tag);
  if (untagged.length > 0) {
    const newest = untagged.reduce((a, b) =>
      new Date(b.created_at).getTime() > new Date(a.created_at).getTime() ? b : a
    );
    groups.push({
      key: UNTAGGED_KEY,
      displayName: "Untagged",
      href: "/project/untagged",
      count: untagged.length,
      latestTime: newest.created_at,
    });
  }

  // Per-project groups, sorted by most recent activity
  const projectMap = new Map<string, TurnRecord[]>();
  for (const turn of turns) {
    if (!turn.project_tag) continue;
    if (!projectMap.has(turn.project_tag)) projectMap.set(turn.project_tag, []);
    projectMap.get(turn.project_tag)!.push(turn);
  }

  const projectGroups: NavGroup[] = [];
  for (const [tag, projectTurns] of projectMap) {
    const newest = projectTurns.reduce((a, b) =>
      new Date(b.created_at).getTime() > new Date(a.created_at).getTime() ? b : a
    );
    projectGroups.push({
      key: tag,
      displayName: tag,
      href: `/project/${encodeURIComponent(tag)}`,
      count: projectTurns.length,
      latestTime: newest.created_at,
    });
  }

  // Sort project groups by recency
  projectGroups.sort(
    (a, b) =>
      new Date(b.latestTime!).getTime() - new Date(a.latestTime!).getTime()
  );

  groups.push(...projectGroups);
  return groups;
}

// ─── Component ────────────────────────────────────────────

export function ChatListPanel({ open, width }: ChatListPanelProps) {
  const pathname = usePathname();
  const router = useRouter();

  // Data
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);

  // UI state
  const [showLegacy, setShowLegacy] = useState(false);
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

  // Initial fetch
  useEffect(() => {
    fetchTurns();
    fetchSessions();
  }, [fetchTurns, fetchSessions]);

  // Refresh on navigation
  useEffect(() => {
    fetchTurns();
  }, [pathname, fetchTurns]);

  // Refresh on events
  useEffect(() => {
    const handler = () => {
      fetchTurns();
    };
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
  }, [fetchTurns]);

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

  const navGroups = useMemo(
    () => buildNavGroups(filteredTurns),
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

  // ─── Actions ──────────────────────────────────────────

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
          router.push("/project/timeline");
        }
      }
    } catch {
      // Silently fail
    } finally {
      setDeletingId(null);
    }
  };

  // ─── Render ───────────────────────────────────────────

  if (!open) return null;

  const isActiveGroup = (group: NavGroup) => {
    if (group.key === TIMELINE_KEY) return pathname === "/project/timeline";
    if (group.key === UNTAGGED_KEY) return pathname === "/project/untagged";
    return pathname === group.href || pathname.startsWith(group.href + "#");
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

      {/* Navigation groups */}
      <ScrollArea className="flex-1 min-h-0 px-3">
        <div className="flex flex-col gap-0.5 pb-3">
          {navGroups.length === 0 && !filteredSessions.length ? (
            <p className="px-2.5 py-3 text-[0.6875rem] text-muted-foreground/60">
              {searchQuery ? "No matching turns" : "No conversations yet"}
            </p>
          ) : (
            <>
              {navGroups.map((group) => {
                const active = isActiveGroup(group);

                return (
                  <Link
                    key={group.key}
                    href={group.href}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                      active
                        ? "bg-sidebar-accent/50 text-sidebar-accent-foreground font-medium"
                        : "text-sidebar-foreground hover:bg-accent/40"
                    )}
                  >
                    <span className="text-[0.8125rem] leading-tight truncate">
                      {group.displayName}
                    </span>
                    <span className="ml-auto text-[0.625rem] text-muted-foreground/40 shrink-0">
                      {group.count}
                    </span>
                  </Link>
                );
              })}

              {/* Legacy sessions (expandable section) */}
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
