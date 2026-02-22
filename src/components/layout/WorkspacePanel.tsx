"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckListIcon,
  Database02Icon,
  RotateClockwiseIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

interface MemoryProject {
  name: string;
  file: string;
  observation_count: number;
  needs_consolidation: boolean;
}

interface MemoryStatus {
  enabled: boolean;
  threshold: number;
  projects: MemoryProject[];
  environments: Array<{ name: string; file: string; observation_count: number }>;
  needs_consolidation: boolean;
  consolidation_candidates: string[];
}

interface WorkspacePanelProps {
  width?: number;
}

export function WorkspacePanel({ width }: WorkspacePanelProps) {
  const { addToast } = useToast();
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const lastNudgedCountsRef = useRef<Record<string, number>>({});
  const hasNudgedOnMountRef = useRef(false);

  const fetchMemoryStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/memory");
      if (res.ok) {
        const data: MemoryStatus = await res.json();
        setMemoryStatus(data);
        return data;
      }
    } catch {
      // silent
    }
    return null;
  }, []);

  // Initial fetch + session-start nudge
  useEffect(() => {
    fetchMemoryStatus().then((data) => {
      if (!data || hasNudgedOnMountRef.current) return;
      hasNudgedOnMountRef.current = true;

      const overThreshold = data.projects.filter(
        (p) => p.observation_count >= data.threshold
      );
      if (overThreshold.length > 0) {
        const names = overThreshold.map((p) => p.name).join(", ");
        addToast({
          type: "info",
          message: `Consolidation available: ${names}`,
          detail: `${data.threshold}+ observations staged. Use the Memory panel to consolidate.`,
        });
      }

      // Seed last-nudged counts
      const counts: Record<string, number> = {};
      for (const p of data.projects) {
        counts[p.name] = p.observation_count;
      }
      lastNudgedCountsRef.current = counts;
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for memory observation events to refresh counts
  useEffect(() => {
    const handler = () => {
      fetchMemoryStatus().then((data) => {
        if (!data) return;

        // Recurring nudge: fire when crossing a 5-observation boundary past threshold
        for (const p of data.projects) {
          const prev = lastNudgedCountsRef.current[p.name] ?? 0;
          const threshold = data.threshold;
          if (p.observation_count >= threshold) {
            const prevBucket = Math.floor((prev - threshold) / 5);
            const curBucket = Math.floor(
              (p.observation_count - threshold) / 5
            );
            if (curBucket > prevBucket || (prev < threshold && p.observation_count >= threshold)) {
              addToast({
                type: "info",
                message: `${p.name}: ${p.observation_count} observations staged`,
                detail: `Consolidation recommended. Use the Memory panel to review.`,
              });
            }
          }
          lastNudgedCountsRef.current[p.name] = p.observation_count;
        }
      });
    };

    // Custom event dispatched when memory_observation SSE arrives
    window.addEventListener("memory-observation", handler);
    return () => window.removeEventListener("memory-observation", handler);
  }, [fetchMemoryStatus, addToast]);

  const handleConsolidate = useCallback(
    async (_projectName: string) => {
      // Placeholder — will be wired to consolidation backend in Phase 2-3
      setLoading(true);
      addToast({
        type: "info",
        message: "Consolidation not yet implemented",
        detail: "The consolidation backend will be added in a future phase.",
      });
      setLoading(false);
    },
    [addToast]
  );

  const projectsWithStaging = memoryStatus?.projects.filter(
    (p) => p.observation_count > 0
  ) ?? [];

  const totalStaged = memoryStatus?.projects.reduce(
    (sum, p) => sum + p.observation_count,
    0
  ) ?? 0;

  return (
    <aside
      className="hidden h-full shrink-0 flex-col overflow-hidden bg-background border-l border-border/30 lg:flex"
      style={{ width: width ?? 288 }}
    >
      {/* ===== Top: Tasks ===== */}
      <div className="flex flex-col min-h-0 flex-1">
        <div className="flex h-10 shrink-0 items-center px-4">
          <HugeiconsIcon
            icon={CheckListIcon}
            className="h-3.5 w-3.5 text-muted-foreground/60 mr-2"
          />
          <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Tasks
          </span>
        </div>
        <div className="flex-1 overflow-auto px-4 pb-2">
          <p className="text-xs text-muted-foreground/40 italic">
            No active tasks
          </p>
        </div>
      </div>

      {/* Divider */}
      <div className="h-px bg-border/50 mx-3" />

      {/* ===== Bottom: Memory ===== */}
      <div className="flex flex-col min-h-0 flex-1">
        <div className="flex h-10 shrink-0 items-center justify-between px-4">
          <div className="flex items-center">
            <HugeiconsIcon
              icon={Database02Icon}
              className="h-3.5 w-3.5 text-muted-foreground/60 mr-2"
            />
            <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Memory
            </span>
            {totalStaged > 0 && (
              <span className="ml-2 text-[0.625rem] font-mono text-amber-400/70 bg-amber-400/10 px-1.5 py-0.5 rounded">
                {totalStaged}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => fetchMemoryStatus()}
            title="Refresh"
          >
            <HugeiconsIcon
              icon={RotateClockwiseIcon}
              className="h-3.5 w-3.5"
            />
          </Button>
        </div>
        <div className="flex-1 overflow-auto px-4 pb-4 space-y-2">
          {!memoryStatus ? (
            <p className="text-xs text-muted-foreground/40 italic">
              Loading...
            </p>
          ) : !memoryStatus.enabled ? (
            <p className="text-xs text-muted-foreground/40 italic">
              Memory system disabled. Enable in Settings &gt; Memory.
            </p>
          ) : memoryStatus.projects.length === 0 ? (
            <p className="text-xs text-muted-foreground/40 italic">
              No project files found.
            </p>
          ) : (
            <>
              {memoryStatus.projects.map((project) => (
                <div
                  key={project.name}
                  className="flex items-center justify-between gap-2 py-1"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-foreground/80 truncate">
                      {project.name}
                    </span>
                    <span
                      className={`text-[0.625rem] font-mono px-1 py-0.5 rounded ${
                        project.needs_consolidation
                          ? "text-amber-400 bg-amber-400/10"
                          : "text-muted-foreground/40 bg-muted/30"
                      }`}
                    >
                      {project.observation_count}
                    </span>
                  </div>
                  {project.observation_count > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={loading}
                      onClick={() => handleConsolidate(project.name)}
                      className="text-[0.625rem] h-6 px-2 shrink-0"
                    >
                      Consolidate
                    </Button>
                  )}
                </div>
              ))}

              {/* Summary line */}
              {projectsWithStaging.length === 0 && (
                <p className="text-xs text-muted-foreground/40 italic pt-1">
                  All staging areas empty.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
