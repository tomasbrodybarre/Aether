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

interface GeminiStatus {
  connected: boolean;
  auth: GeminiAuth;
}

function getAuthLabel(auth: GeminiAuth | null): string {
  if (!auth) return "";
  switch (auth.method) {
    case "google-oauth":
      return auth.authenticated ? "Google" : "No Auth";
    case "none":
      return "No Auth";
    default:
      return "";
  }
}

function getAuthColor(auth: GeminiAuth | null): { pill: string; dot: string } {
  if (!auth || auth.method === "none" || !auth.authenticated) {
    return {
      pill: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
      dot: "bg-amber-500",
    };
  }
  // google-oauth authenticated
  return {
    pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    dot: "bg-emerald-500",
  };
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

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 30000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const connected = status?.connected ?? false;
  const auth = status?.auth ?? null;
  const authLabel = getAuthLabel(auth);
  const authColor = getAuthColor(auth);

  // Combined label: "Connected · Google" or "Not Initialized"
  const pillLabel = status === null
    ? "Checking"
    : !connected
      ? "Not Initialized"
      : authLabel
        ? `Connected · ${authLabel}`
        : "Connected";

  const pillColor = status === null
    ? "bg-muted text-muted-foreground"
    : !connected
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
      : authColor.pill;

  const dotColor = status === null
    ? "bg-muted-foreground/40"
    : !connected
      ? "bg-amber-500"
      : authColor.dot;

  return (
    <>
      {compact ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setDialogOpen(true)}
              className="flex h-8 w-8 items-center justify-center"
            >
              <span className={cn("block h-2.5 w-2.5 shrink-0 rounded-full", dotColor)} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{pillLabel}</TooltipContent>
        </Tooltip>
      ) : (
        <button
          onClick={() => setDialogOpen(true)}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[0.6875rem] font-medium transition-colors",
            pillColor
          )}
        >
          <span className={cn("block h-1.5 w-1.5 shrink-0 rounded-full", dotColor)} />
          {pillLabel}
        </button>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {connected ? "Gemini Core Active" : "Gemini Core Not Initialized"}
            </DialogTitle>
            <DialogDescription>
              {connected
                ? "Gemini CLI Core is running in-process and ready."
                : "Gemini Core initializes on the first message. Send a message to start."}
            </DialogDescription>
          </DialogHeader>

          {connected ? (
            <div className="space-y-3 text-sm">
              {/* Core status */}
              <div className="flex items-center gap-3 rounded-lg bg-emerald-500/10 px-4 py-3">
                <span className="block h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
                <div>
                  <p className="font-medium text-emerald-700 dark:text-emerald-400">Active</p>
                  <p className="text-xs text-muted-foreground">In-process Gemini CLI Core</p>
                </div>
              </div>

              {/* Auth status */}
              {auth && (
                <div className={cn(
                  "flex items-center gap-3 rounded-lg px-4 py-3",
                  auth.authenticated ? "bg-emerald-500/10" : "bg-amber-500/10"
                )}>
                  <span className={cn("block h-2.5 w-2.5 shrink-0 rounded-full", dotColor)} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">
                      {auth.authenticated ? (
                        <span className="text-emerald-700 dark:text-emerald-400">
                          Google OAuth Authenticated
                        </span>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-400">
                          Not Authenticated
                        </span>
                      )}
                    </p>
                    {!auth.authenticated && (
                      <p className="text-xs text-muted-foreground">
                        Authentication is handled automatically on first use via Google login.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="flex items-center gap-3 rounded-lg bg-amber-500/10 px-4 py-3">
                <span className="block h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" />
                <p className="font-medium text-amber-700 dark:text-amber-400">Waiting for first message</p>
              </div>

              <div>
                <h4 className="font-medium mb-1.5">How it works</h4>
                <p className="text-xs text-muted-foreground">
                  Gemini Core runs in-process (no external CLI needed). It initializes
                  automatically when you send your first message and authenticates via Google
                  OAuth if needed.
                </p>
              </div>

              <div>
                <h4 className="font-medium mb-1.5">Requirements</h4>
                <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
                  <li>Node.js 18+ with the <code className="bg-muted px-1 rounded">@google/gemini-cli-core</code> package</li>
                  <li>A Google account for OAuth authentication</li>
                </ul>
              </div>
            </div>
          )}

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
