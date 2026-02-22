"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckListIcon,
  Database02Icon,
  RotateClockwiseIcon,
  Cancel01Icon,
  Tick01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface CompactionResult {
  original: string;
  proposed: string;
  diff: string;
  stagingCount: number;
}

interface PromotionCandidate {
  text: string;
  targetFile: "me.md" | "workflows.md";
  targetSection: string;
  action: "add" | "replace";
  replaceTarget?: string;
  rationale: string;
}

interface WorkspacePanelProps {
  width?: number;
}

// ---------------------------------------------------------------------------
// DiffView — lightweight unified diff renderer
// ---------------------------------------------------------------------------

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  const startIdx = lines[0]?.startsWith("Index:") || lines[0]?.startsWith("===")
    ? lines.findIndex((l) => l.startsWith("@@"))
    : lines[0]?.startsWith("---")
      ? 2
      : 0;

  return (
    <div className="overflow-auto max-h-[50vh] rounded border border-border/30 bg-muted/20">
      <pre className="text-[0.6875rem] leading-relaxed font-mono p-2 whitespace-pre-wrap break-words">
        {lines.slice(startIdx).map((line, i) => {
          let className = "text-muted-foreground/70";
          if (line.startsWith("@@")) {
            className = "text-sky-400/60 font-semibold";
          } else if (line.startsWith("+") && !line.startsWith("+++")) {
            className = "text-green-400/80 bg-green-400/5";
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            className = "text-red-400/80 bg-red-400/5";
          }
          return (
            <div key={i} className={className}>
              {line || "\u00A0"}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkspacePanel
// ---------------------------------------------------------------------------

export function WorkspacePanel({ width }: WorkspacePanelProps) {
  const { addToast } = useToast();
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
  const lastNudgedCountsRef = useRef<Record<string, number>>({});
  const hasNudgedOnMountRef = useRef(false);

  // Compaction flow state
  const [compacting, setCompacting] = useState<string | null>(null);
  const [compactingFile, setCompactingFile] = useState<string | null>(null);
  const [compactionResult, setCompactionResult] = useState<CompactionResult | null>(null);
  const [compactionError, setCompactionError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Promotion flow state
  const [promoting, setPromoting] = useState<string | null>(null); // project name
  const [promotingFile, setPromotingFile] = useState<string | null>(null);
  const [promotionCandidates, setPromotionCandidates] = useState<PromotionCandidate[] | null>(null);
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const [candidateApprovals, setCandidateApprovals] = useState<boolean[]>([]);
  const [applyingPromotion, setApplyingPromotion] = useState(false);

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

    window.addEventListener("memory-observation", handler);
    return () => window.removeEventListener("memory-observation", handler);
  }, [fetchMemoryStatus, addToast]);

  // --- Compaction handlers ---

  const handleConsolidate = useCallback(
    async (projectName: string, projectFile: string) => {
      setCompacting(projectName);
      setCompactingFile(projectFile);
      setCompactionResult(null);
      setCompactionError(null);

      try {
        const res = await fetch("/api/consolidate/compact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectFile }),
        });

        const data = await res.json();

        if (!res.ok) {
          setCompactionError(data.error || "Compaction failed");
          return;
        }

        if (data.noChanges) {
          setCompacting(null);
          setCompactingFile(null);
          addToast({ type: "info", message: `${projectName}: staging is empty, nothing to compact.` });
          return;
        }

        setCompactionResult(data);
      } catch (err) {
        setCompactionError(err instanceof Error ? err.message : "Network error");
      }
    },
    [addToast]
  );

  // Trigger promotion analysis for a project
  const triggerPromotion = useCallback(
    async (projectName: string, projectFile: string) => {
      setPromoting(projectName);
      setPromotingFile(projectFile);
      setPromotionCandidates(null);
      setPromotionError(null);
      setCandidateApprovals([]);

      try {
        const res = await fetch("/api/consolidate/promote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectFile }),
        });

        const data = await res.json();

        if (!res.ok) {
          setPromotionError(data.error || "Promotion analysis failed");
          return;
        }

        const candidates: PromotionCandidate[] = data.candidates || [];
        if (candidates.length === 0) {
          setPromoting(null);
          setPromotingFile(null);
          addToast({ type: "info", message: `${projectName}: no promotion candidates found.` });
          fetchMemoryStatus();
          return;
        }

        setPromotionCandidates(candidates);
        // Default all to skipped (conservative)
        setCandidateApprovals(new Array(candidates.length).fill(false));
      } catch (err) {
        setPromotionError(err instanceof Error ? err.message : "Network error");
      }
    },
    [addToast, fetchMemoryStatus]
  );

  const handleApproveCompaction = useCallback(async () => {
    if (!compactionResult || !compactingFile || !compacting) return;
    setApplying(true);

    try {
      const res = await fetch("/api/consolidate/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: compactingFile,
          content: compactionResult.proposed,
          commitMessage: `memory: compact ${compacting} staging (${compactionResult.stagingCount} observations)`,
        }),
      });

      const data = await res.json();

      if (data.success) {
        addToast({
          type: "success",
          message: `Compacted ${compacting}: ${compactionResult.stagingCount} observations`,
          detail: data.gitError ? `Warning: git error — ${data.gitError}` : undefined,
        });

        // Transition to promotion phase
        const projectName = compacting;
        const projectFile = compactingFile;

        // Clear compaction state
        setCompacting(null);
        setCompactingFile(null);
        setCompactionResult(null);
        setCompactionError(null);
        setApplying(false);

        // Auto-trigger promotion
        triggerPromotion(projectName, projectFile);
      } else {
        addToast({ type: "info", message: `Apply failed: ${data.error}` });
        setApplying(false);
      }
    } catch (err) {
      addToast({ type: "info", message: `Apply error: ${err instanceof Error ? err.message : "unknown"}` });
      setApplying(false);
    }
  }, [compactionResult, compactingFile, compacting, addToast, triggerPromotion]);

  const handleRejectCompaction = useCallback(() => {
    setCompacting(null);
    setCompactingFile(null);
    setCompactionResult(null);
    setCompactionError(null);
  }, []);

  // --- Promotion handlers ---

  const toggleCandidateApproval = useCallback((index: number) => {
    setCandidateApprovals((prev) => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  }, []);

  const handleApplyPromotion = useCallback(async () => {
    if (!promotionCandidates || !promoting) return;

    const approved = promotionCandidates.filter((_, i) => candidateApprovals[i]);
    if (approved.length === 0) {
      addToast({ type: "info", message: "No candidates approved. Skipping promotion." });
      setPromoting(null);
      setPromotingFile(null);
      setPromotionCandidates(null);
      setPromotionError(null);
      fetchMemoryStatus();
      return;
    }

    setApplyingPromotion(true);

    try {
      const res = await fetch("/api/consolidate/promote-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidates: approved,
          projectName: promoting,
        }),
      });

      const data = await res.json();

      if (data.success) {
        addToast({
          type: "success",
          message: `Promoted ${data.candidateCount} pattern${data.candidateCount !== 1 ? "s" : ""} from ${promoting}`,
          detail: data.gitError ? `Warning: git error — ${data.gitError}` : `Updated: ${data.modifiedFiles.join(", ")}`,
        });
      } else {
        addToast({ type: "info", message: `Promote failed: ${data.error}` });
      }
    } catch (err) {
      addToast({ type: "info", message: `Promote error: ${err instanceof Error ? err.message : "unknown"}` });
    } finally {
      setPromoting(null);
      setPromotingFile(null);
      setPromotionCandidates(null);
      setPromotionError(null);
      setCandidateApprovals([]);
      setApplyingPromotion(false);
      fetchMemoryStatus();
    }
  }, [promotionCandidates, promoting, candidateApprovals, addToast, fetchMemoryStatus]);

  const handleSkipPromotion = useCallback(() => {
    setPromoting(null);
    setPromotingFile(null);
    setPromotionCandidates(null);
    setPromotionError(null);
    setCandidateApprovals([]);
    fetchMemoryStatus();
  }, [fetchMemoryStatus]);

  // --- Derived state ---

  const totalStaged = memoryStatus?.projects.reduce(
    (sum, p) => sum + p.observation_count,
    0
  ) ?? 0;

  const isCompacting = compacting !== null;
  const isPromoting = promoting !== null;
  const isBusy = isCompacting || isPromoting;
  const approvedCount = candidateApprovals.filter(Boolean).length;

  // --- Render ---

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
            {totalStaged > 0 && !isBusy && (
              <span className="ml-2 text-[0.625rem] font-mono text-amber-400/70 bg-amber-400/10 px-1.5 py-0.5 rounded">
                {totalStaged}
              </span>
            )}
          </div>
          {!isBusy && (
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
          )}
        </div>
        <div className="flex-1 overflow-auto px-4 pb-4 space-y-2">
          {isPromoting ? (
            /* ---- Promotion review state ---- */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground/80">
                  Promote: {promoting}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleSkipPromotion}
                  title="Skip promotion"
                  disabled={applyingPromotion}
                >
                  <HugeiconsIcon icon={Cancel01Icon} className="h-3.5 w-3.5" />
                </Button>
              </div>

              {!promotionCandidates && !promotionError && (
                <div className="flex items-center gap-2 py-4">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
                  <span className="text-xs text-muted-foreground/60">
                    Analyzing for promotions...
                  </span>
                </div>
              )}

              {promotionError && (
                <div className="rounded border border-red-400/30 bg-red-400/5 px-3 py-2">
                  <p className="text-xs text-red-400">{promotionError}</p>
                </div>
              )}

              {promotionCandidates && (
                <>
                  <p className="text-[0.625rem] text-muted-foreground/60">
                    {promotionCandidates.length} candidate{promotionCandidates.length !== 1 ? "s" : ""} found — select patterns to promote to global files
                  </p>

                  <div className="space-y-2">
                    {promotionCandidates.map((candidate, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => toggleCandidateApproval(i)}
                        disabled={applyingPromotion}
                        className={`w-full text-left rounded border px-2.5 py-2 transition-colors ${
                          candidateApprovals[i]
                            ? "border-green-400/40 bg-green-400/5"
                            : "border-border/30 bg-muted/10 hover:bg-muted/20"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <div className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm border flex items-center justify-center ${
                            candidateApprovals[i]
                              ? "border-green-400/60 bg-green-400/20"
                              : "border-muted-foreground/30"
                          }`}>
                            {candidateApprovals[i] && (
                              <HugeiconsIcon icon={Tick01Icon} className="h-2.5 w-2.5 text-green-400" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[0.6875rem] text-foreground/80 leading-snug">
                              {candidate.text}
                            </p>
                            <div className="flex items-center gap-1.5 mt-1.5">
                              <span className={`text-[0.5625rem] font-mono px-1 py-0.5 rounded ${
                                candidate.targetFile === "me.md"
                                  ? "text-violet-400/80 bg-violet-400/10"
                                  : "text-sky-400/80 bg-sky-400/10"
                              }`}>
                                {candidate.targetFile}
                              </span>
                              <HugeiconsIcon icon={ArrowRight01Icon} className="h-2.5 w-2.5 text-muted-foreground/30" />
                              <span className="text-[0.5625rem] text-muted-foreground/50 truncate">
                                {candidate.targetSection}
                              </span>
                            </div>
                            <p className="text-[0.5625rem] text-muted-foreground/40 mt-1 leading-snug italic">
                              {candidate.rationale}
                            </p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>

                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      onClick={handleApplyPromotion}
                      disabled={applyingPromotion || approvedCount === 0}
                      className="flex-1 h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
                    >
                      {applyingPromotion
                        ? "Applying..."
                        : approvedCount > 0
                          ? `Promote ${approvedCount}`
                          : "None selected"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleSkipPromotion}
                      disabled={applyingPromotion}
                      className="flex-1 h-7 text-xs"
                    >
                      Skip
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : isCompacting ? (
            /* ---- Compaction review state ---- */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground/80">
                  Compact: {compacting}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleRejectCompaction}
                  title="Cancel"
                  disabled={applying}
                >
                  <HugeiconsIcon icon={Cancel01Icon} className="h-3.5 w-3.5" />
                </Button>
              </div>

              {!compactionResult && !compactionError && (
                <div className="flex items-center gap-2 py-4">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
                  <span className="text-xs text-muted-foreground/60">
                    Generating compaction...
                  </span>
                </div>
              )}

              {compactionError && (
                <div className="rounded border border-red-400/30 bg-red-400/5 px-3 py-2">
                  <p className="text-xs text-red-400">{compactionError}</p>
                </div>
              )}

              {compactionResult && (
                <>
                  <p className="text-[0.625rem] text-muted-foreground/60">
                    {compactionResult.stagingCount} observation{compactionResult.stagingCount !== 1 ? "s" : ""} compacted
                  </p>
                  <DiffView diff={compactionResult.diff} />
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      onClick={handleApproveCompaction}
                      disabled={applying}
                      className="flex-1 h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
                    >
                      {applying ? "Applying..." : "Approve"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRejectCompaction}
                      disabled={applying}
                      className="flex-1 h-7 text-xs"
                    >
                      Reject
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : (
            /* ---- Idle state: project list ---- */
            <>
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
                          onClick={() => handleConsolidate(project.name, project.file)}
                          className="text-[0.625rem] h-6 px-2 shrink-0"
                        >
                          Consolidate
                        </Button>
                      )}
                    </div>
                  ))}

                  {memoryStatus.projects.every((p) => p.observation_count === 0) && (
                    <p className="text-xs text-muted-foreground/40 italic pt-1">
                      All staging areas empty.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
