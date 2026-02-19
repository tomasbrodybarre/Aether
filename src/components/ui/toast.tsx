'use client';

import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, CheckmarkCircle02Icon, InformationCircleIcon } from '@hugeicons/core-free-icons';

export interface Toast {
  id: string;
  message: string;
  type: 'info' | 'success' | 'memory';
  /** If set, shows approve/reject buttons instead of auto-dismiss */
  action?: {
    onApprove: () => void;
    onReject: () => void;
  };
  /** Detail text shown on expand */
  detail?: string;
}

interface ToastContextValue {
  addToast: (toast: Omit<Toast, 'id'>) => string;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counterRef = useRef(0);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = `toast-${++counterRef.current}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
    // Auto-dismiss non-action toasts after 5 seconds
    if (!toast.action) {
      setTimeout(() => removeToast(id), 5000);
    }
    return id;
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);

  const iconMap = {
    info: InformationCircleIcon,
    success: CheckmarkCircle02Icon,
    memory: InformationCircleIcon,
  };

  const colorMap = {
    info: 'border-blue-500/30 bg-blue-500/5',
    success: 'border-green-500/30 bg-green-500/5',
    memory: 'border-purple-500/30 bg-purple-500/5',
  };

  const iconColorMap = {
    info: 'text-blue-500',
    success: 'text-green-500',
    memory: 'text-purple-500',
  };

  return (
    <div
      className={`rounded-lg border p-3 shadow-lg backdrop-blur-sm transition-all ${colorMap[toast.type]}`}
      style={{ animation: 'slideInRight 0.2s ease-out' }}
    >
      <div className="flex items-start gap-2">
        <HugeiconsIcon icon={iconMap[toast.type]} className={`h-4 w-4 mt-0.5 shrink-0 ${iconColorMap[toast.type]}`} />
        <div className="flex-1 min-w-0">
          <button
            className="text-xs text-foreground text-left w-full"
            onClick={() => toast.detail && setExpanded(!expanded)}
          >
            {toast.message}
          </button>
          {expanded && toast.detail && (
            <p className="mt-1 text-xs text-muted-foreground font-mono break-all">{toast.detail}</p>
          )}
          {toast.action && (
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => {
                  toast.action!.onApprove();
                  onDismiss(toast.id);
                }}
                className="rounded border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-xs text-green-600 hover:bg-green-500/20 dark:text-green-400"
              >
                Approve
              </button>
              <button
                onClick={() => {
                  toast.action!.onReject();
                  onDismiss(toast.id);
                }}
                className="rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs text-red-600 hover:bg-red-500/20 dark:text-red-400"
              >
                Reject
              </button>
            </div>
          )}
        </div>
        <button
          onClick={() => onDismiss(toast.id)}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
