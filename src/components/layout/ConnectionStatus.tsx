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

interface AuthInfo {
  method: string;
  subscriptionType: string | null;
  expired: boolean;
  expiresAt: string | null;
  providerName?: string;
}

interface ClaudeStatus {
  connected: boolean;
  version: string | null;
  auth: AuthInfo | null;
}

function getAuthLabel(auth: AuthInfo | null): string {
  if (!auth) return "";
  switch (auth.method) {
    case "cli":
      if (auth.expired) return "Expired";
      if (auth.subscriptionType === "max") return "Max";
      if (auth.subscriptionType === "pro") return "Pro";
      if (auth.subscriptionType) return auth.subscriptionType;
      return "CLI";
    case "api_key":
      return "API Key";
    case "env":
      return "Env Key";
    case "none":
      return "No Auth";
    default:
      return "";
  }
}

function getAuthColor(auth: AuthInfo | null): { pill: string; dot: string } {
  if (!auth || auth.method === "none") {
    return {
      pill: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
      dot: "bg-amber-500",
    };
  }
  if (auth.expired) {
    return {
      pill: "bg-red-500/15 text-red-700 dark:text-red-400",
      dot: "bg-red-500",
    };
  }
  if (auth.method === "cli") {
    return {
      pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
      dot: "bg-emerald-500",
    };
  }
  // api_key / env
  return {
    pill: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    dot: "bg-blue-500",
  };
}

interface ConnectionStatusProps {
  /** Compact mode: just a dot with tooltip, for narrow layouts like NavRail */
  compact?: boolean;
}

export function ConnectionStatus({ compact = false }: ConnectionStatusProps) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/claude-status");
      if (res.ok) {
        const data: ClaudeStatus = await res.json();
        setStatus(data);
      }
    } catch {
      setStatus({ connected: false, version: null, auth: null });
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

  // Combined label: "Connected · Max" or "Disconnected" or "No Auth"
  const pillLabel = status === null
    ? "Checking"
    : !connected
      ? "Disconnected"
      : authLabel
        ? `Connected · ${authLabel}`
        : "Connected";

  const pillColor = status === null
    ? "bg-muted text-muted-foreground"
    : !connected
      ? "bg-red-500/15 text-red-700 dark:text-red-400"
      : authColor.pill;

  const dotColor = status === null
    ? "bg-muted-foreground/40"
    : !connected
      ? "bg-red-500"
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
              {connected ? "Claude Code Connected" : "Claude Code Not Connected"}
            </DialogTitle>
            <DialogDescription>
              {connected
                ? `Claude Code CLI v${status?.version} is running and ready.`
                : "Claude Code CLI is required to use this application."}
            </DialogDescription>
          </DialogHeader>

          {connected ? (
            <div className="space-y-3 text-sm">
              {/* CLI status */}
              <div className="flex items-center gap-3 rounded-lg bg-emerald-500/10 px-4 py-3">
                <span className="block h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
                <div>
                  <p className="font-medium text-emerald-700 dark:text-emerald-400">Active</p>
                  <p className="text-xs text-muted-foreground">Version {status?.version}</p>
                </div>
              </div>

              {/* Auth status */}
              {auth && (
                <div className={cn(
                  "flex items-center gap-3 rounded-lg px-4 py-3",
                  auth.method === "none" ? "bg-amber-500/10" :
                  auth.expired ? "bg-red-500/10" :
                  auth.method === "cli" ? "bg-emerald-500/10" : "bg-blue-500/10"
                )}>
                  <span className={cn("block h-2.5 w-2.5 shrink-0 rounded-full", dotColor)} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">
                      {auth.method === "cli" && !auth.expired && (
                        <span className="text-emerald-700 dark:text-emerald-400">
                          {auth.subscriptionType === "max" ? "Max Subscription" : auth.subscriptionType ? `${auth.subscriptionType} Subscription` : "CLI Authenticated"}
                        </span>
                      )}
                      {auth.method === "cli" && auth.expired && (
                        <span className="text-red-700 dark:text-red-400">Token Expired</span>
                      )}
                      {auth.method === "api_key" && (
                        <span className="text-blue-700 dark:text-blue-400">
                          API Key{auth.providerName ? ` (${auth.providerName})` : ""}
                        </span>
                      )}
                      {auth.method === "env" && (
                        <span className="text-blue-700 dark:text-blue-400">Environment Variable</span>
                      )}
                      {auth.method === "none" && (
                        <span className="text-amber-700 dark:text-amber-400">No Authentication</span>
                      )}
                    </p>
                    {auth.method === "cli" && auth.expiresAt && (
                      <p className="text-xs text-muted-foreground">
                        {auth.expired ? "Expired" : "Expires"}: {new Date(auth.expiresAt).toLocaleDateString()}
                      </p>
                    )}
                    {auth.method === "none" && (
                      <p className="text-xs text-muted-foreground">
                        Run <code className="bg-muted px-1 rounded">claude login</code> to authenticate
                      </p>
                    )}
                    {auth.method === "cli" && auth.expired && (
                      <p className="text-xs text-muted-foreground">
                        Run <code className="bg-muted px-1 rounded">claude login</code> to re-authenticate
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="flex items-center gap-3 rounded-lg bg-red-500/10 px-4 py-3">
                <span className="block h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />
                <p className="font-medium text-red-700 dark:text-red-400">Not detected</p>
              </div>

              <div>
                <h4 className="font-medium mb-1.5">1. Install Claude Code</h4>
                <code className="block rounded-md bg-muted px-3 py-2 text-xs">
                  npm install -g @anthropic-ai/claude-code
                </code>
              </div>

              <div>
                <h4 className="font-medium mb-1.5">2. Authenticate</h4>
                <code className="block rounded-md bg-muted px-3 py-2 text-xs">
                  claude login
                </code>
              </div>

              <div>
                <h4 className="font-medium mb-1.5">3. Verify Installation</h4>
                <code className="block rounded-md bg-muted px-3 py-2 text-xs">
                  claude --version
                </code>
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
