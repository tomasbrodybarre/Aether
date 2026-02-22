"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface GeminiAuth {
  method: string;
  authenticated: boolean;
}

interface ModelHealth {
  status: "idle" | "ok" | "error";
  error?: string;
  timestamp: number;
}

interface GeminiStatus {
  connected: boolean;
  auth: GeminiAuth;
  health?: ModelHealth;
}

function getAuthLabel(auth: GeminiAuth | null): string {
  if (!auth) return "";
  switch (auth.method) {
    case "google-oauth":
      return auth.authenticated ? "Google" : "No Auth";
    case "api-key":
      return auth.authenticated ? "API Key" : "No Auth";
    case "none":
      return "No Auth";
    default:
      return "";
  }
}

/**
 * Derive the pill/dot color from model health (primary) + auth state (fallback).
 * Health takes priority: error → red, ok → green, idle → use auth state.
 */
function getStatusColor(
  health: ModelHealth | null,
  auth: GeminiAuth | null,
  connected: boolean,
): { pill: string; dot: string } {
  // Error state — red
  if (health?.status === "error") {
    return {
      pill: "bg-red-500/15 text-red-700 dark:text-red-400",
      dot: "bg-red-500",
    };
  }

  // Healthy — green
  if (health?.status === "ok") {
    return {
      pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
      dot: "bg-emerald-500",
    };
  }

  // Not yet initialized but connected (idle) — neutral
  if (connected) {
    return {
      pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
      dot: "bg-emerald-500",
    };
  }

  // Not connected — amber (waiting for first message)
  if (!auth || auth.method === "none" || !auth.authenticated) {
    return {
      pill: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
      dot: "bg-amber-500",
    };
  }

  return {
    pill: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/40",
  };
}

function formatTimestamp(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

interface ConnectionStatusProps {
  /** Compact mode: just a dot with tooltip, for narrow layouts like NavRail */
  compact?: boolean;
}

export function ConnectionStatus({ compact = false }: ConnectionStatusProps) {
  const [status, setStatus] = useState<GeminiStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/gemini-status");
      if (res.ok) {
        const data: GeminiStatus = await res.json();
        setStatus(data);
      }
    } catch {
      setStatus({ connected: false, auth: { method: "none", authenticated: false } });
    }
  }, []);

  // Also refresh on successful model responses (turn-created/turn-updated events)
  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 30000);
    const onTurnEvent = () => {
      // Small delay to let the server update health state
      setTimeout(checkStatus, 500);
    };
    window.addEventListener("turn-created", onTurnEvent);
    window.addEventListener("turn-updated", onTurnEvent);
    return () => {
      clearInterval(interval);
      window.removeEventListener("turn-created", onTurnEvent);
      window.removeEventListener("turn-updated", onTurnEvent);
    };
  }, [checkStatus]);

  const connected = status?.connected ?? false;
  const auth = status?.auth ?? null;
  const health = status?.health ?? null;
  const authLabel = getAuthLabel(auth);
  const colors = getStatusColor(health, auth, connected);

  // Pill label logic:
  // - error → "Error · API Key" (or "Error")
  // - ok → "Connected · API Key" (or "Connected · Google")
  // - idle + connected → "Ready · API Key"
  // - idle + not connected → "Ready" (lazy init, not an error)
  // - null → "Checking"
  let pillLabel: string;
  if (status === null) {
    pillLabel = "Checking";
  } else if (health?.status === "error") {
    pillLabel = authLabel ? `Error · ${authLabel}` : "Error";
  } else if (health?.status === "ok") {
    pillLabel = authLabel ? `Connected · ${authLabel}` : "Connected";
  } else if (connected) {
    pillLabel = authLabel ? `Ready · ${authLabel}` : "Ready";
  } else {
    pillLabel = "Ready";
  }

  return (
    <>
      {compact ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setDialogOpen(true)}
              className="flex h-8 w-8 items-center justify-center"
            >
              <span className={cn("block h-2.5 w-2.5 shrink-0 rounded-full", colors.dot)} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{pillLabel}</TooltipContent>
        </Tooltip>
      ) : (
        <button
          onClick={() => setDialogOpen(true)}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[0.6875rem] font-medium transition-colors",
            colors.pill
          )}
        >
          <span className={cn("block h-1.5 w-1.5 shrink-0 rounded-full", colors.dot)} />
          {pillLabel}
        </button>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {health?.status === "error"
                ? "Model Error"
                : connected
                  ? "Gemini Core Active"
                  : "Gemini Core"}
            </DialogTitle>
            <DialogDescription>
              {health?.status === "error"
                ? "The last model request failed."
                : connected
                  ? "Gemini CLI Core is running in-process and ready."
                  : "Gemini Core initializes on the first message. Send a message to start."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            {/* Model health */}
            {health?.status === "error" && (
              <div className="flex items-start gap-3 rounded-lg bg-red-500/10 px-4 py-3">
                <span className="mt-0.5 block h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-red-700 dark:text-red-400">Error</p>
                  <p className="text-xs text-muted-foreground mt-0.5 break-words">
                    {health.error || "Unknown error"}
                  </p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    {formatTimestamp(health.timestamp)}
                  </p>
                </div>
              </div>
            )}

            {health?.status === "ok" && (
              <div className="flex items-center gap-3 rounded-lg bg-emerald-500/10 px-4 py-3">
                <span className="block h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
                <div>
                  <p className="font-medium text-emerald-700 dark:text-emerald-400">Healthy</p>
                  <p className="text-xs text-muted-foreground">
                    Last successful response {formatTimestamp(health.timestamp)}
                  </p>
                </div>
              </div>
            )}

            {(!health || health.status === "idle") && (
              <div className={cn(
                "flex items-center gap-3 rounded-lg px-4 py-3",
                connected ? "bg-emerald-500/10" : "bg-muted/50",
              )}>
                <span className={cn(
                  "block h-2.5 w-2.5 shrink-0 rounded-full",
                  connected ? "bg-emerald-500" : "bg-muted-foreground/40",
                )} />
                <div>
                  <p className={cn(
                    "font-medium",
                    connected
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-muted-foreground",
                  )}>
                    {connected ? "Initialized" : "Waiting for first message"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {connected
                      ? "No model requests yet this session"
                      : "Core initializes automatically when you send a message"}
                  </p>
                </div>
              </div>
            )}

            {/* Auth status */}
            {auth && (
              <div className={cn(
                "flex items-center gap-3 rounded-lg px-4 py-3",
                auth.authenticated ? "bg-emerald-500/10" : "bg-amber-500/10"
              )}>
                <span className={cn(
                  "block h-2.5 w-2.5 shrink-0 rounded-full",
                  auth.authenticated ? "bg-emerald-500" : "bg-amber-500",
                )} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium">
                    {auth.authenticated ? (
                      <span className="text-emerald-700 dark:text-emerald-400">
                        {auth.method === "api-key" ? "API Key" : "Google OAuth"}
                      </span>
                    ) : (
                      <span className="text-amber-700 dark:text-amber-400">
                        Not Authenticated
                      </span>
                    )}
                  </p>
                  {auth.authenticated && auth.method === "api-key" && (
                    <p className="text-xs text-muted-foreground">
                      Using GEMINI_API_KEY environment variable
                    </p>
                  )}
                  {!auth.authenticated && (
                    <p className="text-xs text-muted-foreground">
                      Set GEMINI_API_KEY in .env.local, or run `gemini auth login` for OAuth.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                checkStatus();
              }}
            >
              Refresh
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
