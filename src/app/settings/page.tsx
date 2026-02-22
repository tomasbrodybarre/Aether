"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FloppyDiskIcon,
  ReloadIcon,
  CodeIcon,
  SlidersHorizontalIcon,
  Loading02Icon,
} from "@hugeicons/core-free-icons";
import { ProviderManager } from "@/components/settings/ProviderManager";
import { FolderPicker } from "@/components/chat/FolderPicker";

interface SettingsData {
  [key: string]: unknown;
}

// Structured known fields from ~/.gemini/settings.json
const KNOWN_FIELDS = [
  {
    key: "permissions",
    label: "Permissions",
    description: "Configure permission settings for Gemini CLI",
    type: "object" as const,
  },
  {
    key: "env",
    label: "Environment Variables",
    description: "Environment variables passed to Gemini",
    type: "object" as const,
  },
] as const;

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <SettingsPageInner />
    </Suspense>
  );
}

// --- Gemini CLI Settings Section (manages ~/.gemini/settings.json) ---
function SettingsPageInner() {
  const [settings, setSettings] = useState<SettingsData>({});
  const [originalSettings, setOriginalSettings] = useState<SettingsData>({});
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingSaveAction, setPendingSaveAction] = useState<
    "form" | "json" | null
  >(null);

  // Skip-permissions toggle state
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [showSkipPermWarning, setShowSkipPermWarning] = useState(false);
  const [skipPermSaving, setSkipPermSaving] = useState(false);

  // Default model state
  const [defaultModel, setDefaultModel] = useState('');
  const [defaultModelSaving, setDefaultModelSaving] = useState(false);
  const [defaultModelSaved, setDefaultModelSaved] = useState(false);
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);

  // Font size state
  const [fontSize, setFontSize] = useState(100);
  const [fontSizeSaving, setFontSizeSaving] = useState(false);

  // Content width state
  const [contentWidth, setContentWidth] = useState(100);
  const [contentWidthSaving, setContentWidthSaving] = useState(false);

  // Default working directory state
  const [defaultWorkingDir, setDefaultWorkingDir] = useState('');
  const [defaultWorkingDirSaving, setDefaultWorkingDirSaving] = useState(false);
  const [defaultWorkingDirSaved, setDefaultWorkingDirSaved] = useState(false);
  const [showDirPicker, setShowDirPicker] = useState(false);

  // Shell inactivity timeout state
  const [shellTimeout, setShellTimeout] = useState(120);
  const [shellTimeoutSaving, setShellTimeoutSaving] = useState(false);
  const [shellTimeoutSaved, setShellTimeoutSaved] = useState(false);

  // Memory system state
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memoryRepoPath, setMemoryRepoPath] = useState('');
  const [memoryEnvId, setMemoryEnvId] = useState('');
  const [memoryAutoApprove, setMemoryAutoApprove] = useState(false);
  const [memoryTriggers, setMemoryTriggers] = useState({
    explicit_rules: true,
    corrections: true,
    error_recovery: true,
    project_status: true,
    project_shift: true,
  });
  const [memoryConsolidationThreshold, setMemoryConsolidationThreshold] = useState(15);
  const [memoryCustomRules, setMemoryCustomRules] = useState('');
  const [memorySaving, setMemorySaving] = useState(false);
  const [memorySaved, setMemorySaved] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        const s = data.settings || {};
        setSettings(s);
        setOriginalSettings(s);
        setJsonText(JSON.stringify(s, null, 2));
      }
    } catch {
      setSettings({});
      setOriginalSettings({});
      setJsonText("{}");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch app-level settings (dangerously_skip_permissions, font_size)
  const fetchAppSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/app");
      if (res.ok) {
        const data = await res.json();
        const appSettings = data.settings || {};
        setSkipPermissions(appSettings.dangerously_skip_permissions === "true");
        if (appSettings.default_model) {
          setDefaultModel(appSettings.default_model);
        }
        if (appSettings.font_size) {
          setFontSize(parseInt(appSettings.font_size, 10) || 100);
        }
        if (appSettings.default_working_directory) {
          setDefaultWorkingDir(appSettings.default_working_directory);
        }
        if (appSettings.content_width) {
          setContentWidth(parseInt(appSettings.content_width, 10) || 100);
        }
        if (appSettings.shell_inactivity_timeout) {
          setShellTimeout(parseInt(appSettings.shell_inactivity_timeout, 10) || 120);
        }
        // Memory settings
        if (appSettings.memory_enabled !== undefined) {
          setMemoryEnabled(appSettings.memory_enabled !== 'false');
        }
        if (appSettings.memory_repo_path) setMemoryRepoPath(appSettings.memory_repo_path);
        if (appSettings.memory_environment_id) setMemoryEnvId(appSettings.memory_environment_id);
        if (appSettings.memory_auto_approve) setMemoryAutoApprove(appSettings.memory_auto_approve === 'true');
        if (appSettings.memory_consolidation_threshold) {
          setMemoryConsolidationThreshold(parseInt(appSettings.memory_consolidation_threshold, 10) || 15);
        }
        if (appSettings.memory_custom_rules) setMemoryCustomRules(appSettings.memory_custom_rules);
        setMemoryTriggers({
          explicit_rules: appSettings.memory_trigger_explicit_rules !== 'false',
          corrections: appSettings.memory_trigger_corrections !== 'false',
          error_recovery: appSettings.memory_trigger_error_recovery !== 'false',
          project_status: appSettings.memory_trigger_project_status !== 'false',
          project_shift: appSettings.memory_trigger_project_shift !== 'false',
        });
      }
    } catch {
      // ignore
    }
  }, []);

  // Fetch available models from Core library
  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models');
      if (res.ok) {
        const data = await res.json();
        if (data.models && data.models.length > 0) {
          setModelOptions(data.models.map((m: { value: string; label: string }) => ({
            value: m.value,
            label: m.label,
          })));
        }
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchAppSettings();
    fetchModels();
  }, [fetchSettings, fetchAppSettings, fetchModels]);

  const hasChanges =
    JSON.stringify(settings) !== JSON.stringify(originalSettings);

  const handleSave = async (source: "form" | "json") => {
    let dataToSave: SettingsData;

    if (source === "json") {
      try {
        dataToSave = JSON.parse(jsonText);
        setJsonError("");
      } catch {
        setJsonError("Invalid JSON format");
        return;
      }
    } else {
      dataToSave = settings;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: dataToSave }),
      });

      if (res.ok) {
        setSettings(dataToSave);
        setOriginalSettings(dataToSave);
        setJsonText(JSON.stringify(dataToSave, null, 2));
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      }
    } catch {
      // Handle error silently
    } finally {
      setSaving(false);
      setShowConfirmDialog(false);
      setPendingSaveAction(null);
    }
  };

  const handleReset = () => {
    setSettings(originalSettings);
    setJsonText(JSON.stringify(originalSettings, null, 2));
    setJsonError("");
  };

  const handleFormatJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      setJsonText(JSON.stringify(parsed, null, 2));
      setJsonError("");
    } catch {
      setJsonError("Cannot format: invalid JSON");
    }
  };

  const confirmSave = (source: "form" | "json") => {
    setPendingSaveAction(source);
    setShowConfirmDialog(true);
  };

  const updateField = (key: string, value: unknown) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  // Handle skip-permissions toggle
  const handleSkipPermToggle = (checked: boolean) => {
    if (checked) {
      // Show warning dialog before enabling
      setShowSkipPermWarning(true);
    } else {
      // Disable immediately without warning
      saveSkipPermissions(false);
    }
  };

  const saveFontSize = async (size: number) => {
    setFontSizeSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { font_size: String(size) } }),
      });
      if (res.ok) {
        setFontSize(size);
        document.documentElement.style.fontSize = `${size}%`;
      }
    } catch {
      // ignore
    } finally {
      setFontSizeSaving(false);
    }
  };

  const saveContentWidth = async (size: number) => {
    setContentWidthSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { content_width: String(size) } }),
      });
      if (res.ok) {
        setContentWidth(size);
      }
    } catch {
      // ignore
    } finally {
      setContentWidthSaving(false);
    }
  };

  const saveDefaultModel = async (model: string) => {
    setDefaultModelSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { default_model: model } }),
      });
      if (res.ok) {
        setDefaultModel(model);
        setDefaultModelSaved(true);
        setTimeout(() => setDefaultModelSaved(false), 2000);
      }
    } catch {
      // ignore
    } finally {
      setDefaultModelSaving(false);
    }
  };

  const saveSkipPermissions = async (enabled: boolean) => {
    setSkipPermSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { dangerously_skip_permissions: enabled ? "true" : "" },
        }),
      });
      if (res.ok) {
        setSkipPermissions(enabled);
      }
    } catch {
      // ignore
    } finally {
      setSkipPermSaving(false);
      setShowSkipPermWarning(false);
    }
  };

  const saveDefaultWorkingDir = async (dir: string) => {
    setDefaultWorkingDirSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { default_working_directory: dir } }),
      });
      if (res.ok) {
        setDefaultWorkingDir(dir);
        setDefaultWorkingDirSaved(true);
        setTimeout(() => setDefaultWorkingDirSaved(false), 2000);
      }
    } catch {
      // ignore
    } finally {
      setDefaultWorkingDirSaving(false);
    }
  };

  const saveShellTimeout = async (seconds: number) => {
    setShellTimeoutSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { shell_inactivity_timeout: String(seconds) } }),
      });
      if (res.ok) {
        setShellTimeout(seconds);
        setShellTimeoutSaved(true);
        setTimeout(() => setShellTimeoutSaved(false), 2000);
      }
    } catch {
      // ignore
    } finally {
      setShellTimeoutSaving(false);
    }
  };

  const saveMemorySettings = async () => {
    setMemorySaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            memory_enabled: memoryEnabled ? 'true' : 'false',
            memory_repo_path: memoryRepoPath,
            memory_environment_id: memoryEnvId,
            memory_auto_approve: memoryAutoApprove ? 'true' : 'false',
            memory_trigger_explicit_rules: memoryTriggers.explicit_rules ? 'true' : 'false',
            memory_trigger_corrections: memoryTriggers.corrections ? 'true' : 'false',
            memory_trigger_error_recovery: memoryTriggers.error_recovery ? 'true' : 'false',
            memory_trigger_project_status: memoryTriggers.project_status ? 'true' : 'false',
            memory_trigger_project_shift: memoryTriggers.project_shift ? 'true' : 'false',
            memory_consolidation_threshold: String(memoryConsolidationThreshold),
            memory_custom_rules: memoryCustomRules,
          },
        }),
      });
      if (res.ok) {
        setMemorySaved(true);
        setTimeout(() => setMemorySaved(false), 2000);
      }
    } catch {
      // ignore
    } finally {
      setMemorySaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/50 px-6 pt-4 pb-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage Aether and Gemini CLI settings
        </p>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-3xl space-y-6">
          <ProviderManager />

          {/* Display Settings */}
          <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
            <h2 className="text-sm font-medium">Display</h2>
            <p className="mb-4 text-xs text-muted-foreground">
              Adjust the interface appearance.
            </p>

            {/* Font Size */}
            <div className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Font Size</h3>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Small</span>
                <span className="font-medium text-foreground">{fontSize}%</span>
                <span>Large</span>
              </div>
              <input
                type="range"
                min={75}
                max={150}
                step={5}
                value={fontSize}
                onChange={(e) => setFontSize(parseInt(e.target.value, 10))}
                onMouseUp={() => saveFontSize(fontSize)}
                onTouchEnd={() => saveFontSize(fontSize)}
                disabled={fontSizeSaving}
                className="w-full accent-primary"
              />
              <div className="flex items-center justify-between">
                <div className="flex gap-2">
                  {[85, 100, 120].map((preset) => (
                    <button
                      key={preset}
                      onClick={() => saveFontSize(preset)}
                      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                        fontSize === preset
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                      }`}
                    >
                      {preset === 85 ? "Small" : preset === 100 ? "Default" : "Large"}
                    </button>
                  ))}
                </div>
                {fontSize !== 100 && (
                  <button
                    onClick={() => saveFontSize(100)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            <hr className="my-4 border-border/30" />

            {/* Content Width */}
            <div className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Content Width</h3>
              <p className="text-xs text-muted-foreground">
                Maximum width of messages and input area. Narrower widths improve readability.
              </p>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Narrow</span>
                <span className="font-medium text-foreground">{contentWidth}%</span>
                <span>Full</span>
              </div>
              <input
                type="range"
                min={50}
                max={100}
                step={5}
                value={contentWidth}
                onChange={(e) => setContentWidth(parseInt(e.target.value, 10))}
                onMouseUp={() => saveContentWidth(contentWidth)}
                onTouchEnd={() => saveContentWidth(contentWidth)}
                disabled={contentWidthSaving}
                className="w-full accent-primary"
              />
              <div className="flex items-center justify-between">
                <div className="flex gap-2">
                  {[60, 80, 100].map((preset) => (
                    <button
                      key={preset}
                      onClick={() => saveContentWidth(preset)}
                      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                        contentWidth === preset
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                      }`}
                    >
                      {preset === 60 ? "Narrow" : preset === 80 ? "Medium" : "Full"}
                    </button>
                  ))}
                </div>
                {contentWidth !== 100 && (
                  <button
                    onClick={() => saveContentWidth(100)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Default Model */}
          <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
            <h2 className="text-sm font-medium">Default Model</h2>
            <p className="mb-4 text-xs text-muted-foreground">
              The Gemini model used for new conversations. Can be overridden per-conversation from the chat input bar.
            </p>
            <div className="space-y-3">
              {modelOptions.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {modelOptions.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => saveDefaultModel(opt.value)}
                      disabled={defaultModelSaving}
                      className={`rounded-md border px-2.5 py-1 text-xs font-mono transition-colors ${
                        (defaultModel || 'gemini-3-pro') === opt.value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">Loading models...</p>
              )}
              <div className="flex items-center gap-3">
                {defaultModel && defaultModel !== 'gemini-3-pro' && (
                  <button
                    onClick={() => saveDefaultModel('')}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Reset to default (3.0 Pro)
                  </button>
                )}
                {defaultModelSaved && (
                  <span className="text-xs text-green-600 dark:text-green-400">Saved</span>
                )}
              </div>
            </div>
          </div>

          {/* Default Working Directory */}
          <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
            <h2 className="text-sm font-medium">Default Working Directory</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              New sessions will start in this directory by default.
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={defaultWorkingDir}
                onChange={(e) => setDefaultWorkingDir(e.target.value)}
                placeholder="e.g., C:\Users\tomas\projects"
                className="flex-1 font-mono text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowDirPicker(true)}
              >
                Browse
              </Button>
              <Button
                size="sm"
                onClick={() => saveDefaultWorkingDir(defaultWorkingDir)}
                disabled={defaultWorkingDirSaving}
              >
                Save
              </Button>
              {defaultWorkingDirSaved && (
                <span className="text-xs text-green-600 dark:text-green-400">Saved</span>
              )}
            </div>
            {defaultWorkingDir && (
              <button
                onClick={() => saveDefaultWorkingDir('')}
                className="mt-2 text-xs text-muted-foreground hover:text-foreground"
              >
                Clear default
              </button>
            )}
          </div>

          {/* Shell Timeout */}
          <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
            <h2 className="text-sm font-medium">Shell Command Timeout</h2>
            <p className="mb-4 text-xs text-muted-foreground">
              How long to wait for shell commands before cancelling due to inactivity.
              Commands waiting for input or producing no output will be killed after this timeout.
            </p>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>30s</span>
                <span className="font-medium text-foreground">{shellTimeout}s ({Math.floor(shellTimeout / 60)}m {shellTimeout % 60}s)</span>
                <span>600s</span>
              </div>
              <input
                type="range"
                min={30}
                max={600}
                step={30}
                value={shellTimeout}
                onChange={(e) => setShellTimeout(parseInt(e.target.value, 10))}
                onMouseUp={() => saveShellTimeout(shellTimeout)}
                onTouchEnd={() => saveShellTimeout(shellTimeout)}
                disabled={shellTimeoutSaving}
                className="w-full accent-primary"
              />
              <div className="flex items-center justify-between">
                <div className="flex gap-2">
                  {[60, 120, 300].map((preset) => (
                    <button
                      key={preset}
                      onClick={() => saveShellTimeout(preset)}
                      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                        shellTimeout === preset
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                      }`}
                    >
                      {preset === 60 ? "1 min" : preset === 120 ? "2 min (default)" : "5 min"}
                    </button>
                  ))}
                </div>
                {shellTimeoutSaved && (
                  <span className="text-xs text-green-600 dark:text-green-400">Saved</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Takes effect on the next Gemini session. Lower values prevent commands from hanging.
              </p>
            </div>
          </div>

          {/* Memory System */}
          <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-medium">Memory</h2>
              <Switch
                checked={memoryEnabled}
                onCheckedChange={setMemoryEnabled}
              />
            </div>
            <p className="mb-4 text-xs text-muted-foreground">
              Automatic learning — Aether gets progressively better at your style and workflows.
            </p>

            {memoryEnabled && (
              <div className="space-y-4">
                {/* Memory repo path */}
                <div className="space-y-1.5">
                  <Label className="text-xs">Memory Repository Path</Label>
                  <Input
                    value={memoryRepoPath}
                    onChange={(e) => setMemoryRepoPath(e.target.value)}
                    placeholder="e.g., /home/user/memory or C:\Users\user\memory"
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Git repo where memory files are stored. Synced across machines.
                  </p>
                </div>

                {/* Environment ID */}
                <div className="space-y-1.5">
                  <Label className="text-xs">Environment ID</Label>
                  <Input
                    value={memoryEnvId}
                    onChange={(e) => setMemoryEnvId(e.target.value)}
                    placeholder="auto-detected from hostname"
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Identifies this machine. Auto-detected if empty. Used for environment-specific memory files.
                  </p>
                </div>

                {/* Auto-approve */}
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-xs">Auto-approve memory writes</Label>
                    <p className="text-xs text-muted-foreground">
                      Skip review — writes commit immediately. When off, a toast shows for approval.
                    </p>
                  </div>
                  <Switch
                    checked={memoryAutoApprove}
                    onCheckedChange={setMemoryAutoApprove}
                  />
                </div>

                <hr className="border-border/30" />

                {/* Trigger toggles */}
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Triggers</h3>
                  {([
                    ['explicit_rules', 'Explicit rules', 'User says "always/never do X"'],
                    ['corrections', 'Corrections', 'User corrects Gemini\'s output'],
                    ['error_recovery', 'Error recovery', 'Tool fails, retry with fix succeeds'],
                    ['project_status', 'Project status', 'Project direction or status changes'],
                    ['project_shift', 'Topic shift', 'Scan for lessons when conversation topic changes'],
                  ] as const).map(([key, label, desc]) => (
                    <div key={key} className="flex items-center justify-between py-1">
                      <div>
                        <span className="text-xs">{label}</span>
                        <p className="text-xs text-muted-foreground">{desc}</p>
                      </div>
                      <Switch
                        checked={memoryTriggers[key]}
                        onCheckedChange={(checked) =>
                          setMemoryTriggers((prev) => ({ ...prev, [key]: checked }))
                        }
                      />
                    </div>
                  ))}
                </div>

                <hr className="border-border/30" />

                {/* Consolidation threshold */}
                <div className="space-y-1.5">
                  <Label className="text-xs">Consolidation Threshold</Label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={5}
                      max={50}
                      step={5}
                      value={memoryConsolidationThreshold}
                      onChange={(e) => setMemoryConsolidationThreshold(parseInt(e.target.value, 10))}
                      className="flex-1 accent-primary"
                    />
                    <span className="text-xs font-medium w-8 text-right">{memoryConsolidationThreshold}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Observations per project file before triggering a consolidation review.
                  </p>
                </div>

                {/* Custom rules */}
                <div className="space-y-1.5">
                  <Label className="text-xs">Custom Memorization Rules</Label>
                  <Textarea
                    value={memoryCustomRules}
                    onChange={(e) => setMemoryCustomRules(e.target.value)}
                    placeholder={'e.g., "Always log which Python packages I install"\n"Never memorize anything about personal email"'}
                    className="font-mono text-xs"
                    rows={3}
                  />
                  <p className="text-xs text-muted-foreground">
                    Freeform instructions injected into the system prompt. One rule per line.
                  </p>
                </div>

                {/* Save button */}
                <div className="flex items-center gap-3 pt-1">
                  <Button
                    size="sm"
                    onClick={saveMemorySettings}
                    disabled={memorySaving}
                  >
                    {memorySaving ? "Saving..." : "Save Memory Settings"}
                  </Button>
                  {memorySaved && (
                    <span className="text-xs text-green-600 dark:text-green-400">Saved</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Dangerous Settings */}
          <div className={`rounded-lg border p-4 transition-shadow hover:shadow-sm ${skipPermissions ? "border-orange-500/50 bg-orange-500/5" : "border-border/50"}`}>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-medium">Auto-approve All Actions</h2>
                <p className="text-xs text-muted-foreground">
                  Skip all permission checks and auto-approve every tool action.
                  This is dangerous and should only be used for trusted tasks.
                </p>
              </div>
              <Switch
                checked={skipPermissions}
                onCheckedChange={handleSkipPermToggle}
                disabled={skipPermSaving}
              />
            </div>
            {skipPermissions && (
              <div className="mt-3 flex items-center gap-2 rounded-md bg-orange-500/10 px-3 py-2 text-xs text-orange-600 dark:text-orange-400">
                <span className="h-2 w-2 shrink-0 rounded-full bg-orange-500" />
                All tool actions will be auto-approved without confirmation. Use with caution.
              </div>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                Loading settings...
              </span>
            </div>
          ) : (
            <Tabs defaultValue="form">
              <TabsList className="mb-4">
                <TabsTrigger value="form" className="gap-2">
                  <HugeiconsIcon icon={SlidersHorizontalIcon} className="h-4 w-4" />
                  Visual Editor
                </TabsTrigger>
                <TabsTrigger value="json" className="gap-2">
                  <HugeiconsIcon icon={CodeIcon} className="h-4 w-4" />
                  JSON Editor
                </TabsTrigger>
              </TabsList>

              <TabsContent value="form">
                <div className="space-y-6">
                  {KNOWN_FIELDS.map((field) => (
                    <div
                      key={field.key}
                      className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm"
                    >
                      <Label className="text-sm font-medium">
                        {field.label}
                      </Label>
                      <p className="mb-2 text-xs text-muted-foreground">
                        {field.description}
                      </p>
                      <Textarea
                        value={
                          typeof settings[field.key] === "object"
                            ? JSON.stringify(settings[field.key], null, 2)
                            : String(settings[field.key] ?? "")
                        }
                        onChange={(e) => {
                          try {
                            const parsed = JSON.parse(e.target.value);
                            updateField(field.key, parsed);
                          } catch {
                            updateField(field.key, e.target.value);
                          }
                        }}
                        className="font-mono text-sm"
                        rows={4}
                      />
                    </div>
                  ))}

                  {Object.entries(settings)
                    .filter(
                      ([key]) => !KNOWN_FIELDS.some((f) => f.key === key)
                    )
                    .map(([key, value]) => (
                      <div
                        key={key}
                        className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm"
                      >
                        <Label className="text-sm font-medium">{key}</Label>
                        {typeof value === "boolean" ? (
                          <div className="mt-2 flex items-center gap-2">
                            <Switch
                              checked={value}
                              onCheckedChange={(checked) =>
                                updateField(key, checked)
                              }
                            />
                            <span className="text-sm text-muted-foreground">
                              {value ? "Enabled" : "Disabled"}
                            </span>
                          </div>
                        ) : typeof value === "string" ? (
                          <Input
                            value={value}
                            onChange={(e) =>
                              updateField(key, e.target.value)
                            }
                            className="mt-2"
                          />
                        ) : (
                          <Textarea
                            value={JSON.stringify(value, null, 2)}
                            onChange={(e) => {
                              try {
                                updateField(key, JSON.parse(e.target.value));
                              } catch {
                                updateField(key, e.target.value);
                              }
                            }}
                            className="mt-2 font-mono text-sm"
                            rows={4}
                          />
                        )}
                      </div>
                    ))}

                  <div className="flex items-center gap-3">
                    <Button
                      onClick={() => confirmSave("form")}
                      disabled={!hasChanges || saving}
                      className="gap-2"
                    >
                      {saving ? (
                        <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
                      ) : (
                        <HugeiconsIcon icon={FloppyDiskIcon} className="h-4 w-4" />
                      )}
                      {saving ? "Saving..." : "Save Changes"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleReset}
                      disabled={!hasChanges}
                      className="gap-2"
                    >
                      <HugeiconsIcon icon={ReloadIcon} className="h-4 w-4" />
                      Reset
                    </Button>
                    {saveSuccess && (
                      <span className="text-sm text-green-600 dark:text-green-400">
                        Settings saved successfully
                      </span>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="json">
                <div className="space-y-4">
                  <Textarea
                    value={jsonText}
                    onChange={(e) => {
                      setJsonText(e.target.value);
                      setJsonError("");
                    }}
                    className="min-h-[400px] font-mono text-sm"
                    placeholder='{"key": "value"}'
                  />
                  {jsonError && (
                    <p className="text-sm text-destructive">{jsonError}</p>
                  )}

                  <div className="flex items-center gap-3">
                    <Button
                      onClick={() => confirmSave("json")}
                      disabled={saving}
                      className="gap-2"
                    >
                      {saving ? (
                        <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
                      ) : (
                        <HugeiconsIcon icon={FloppyDiskIcon} className="h-4 w-4" />
                      )}
                      {saving ? "Saving..." : "Save JSON"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleFormatJson}
                      className="gap-2"
                    >
                      <HugeiconsIcon icon={CodeIcon} className="h-4 w-4" />
                      Format
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleReset}
                      className="gap-2"
                    >
                      <HugeiconsIcon icon={ReloadIcon} className="h-4 w-4" />
                      Reset
                    </Button>
                    {saveSuccess && (
                      <span className="text-sm text-green-600 dark:text-green-400">
                        Settings saved successfully
                      </span>
                    )}
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>

      {/* Folder picker for default working directory */}
      <FolderPicker
        open={showDirPicker}
        onOpenChange={setShowDirPicker}
        onSelect={(dir) => {
          setDefaultWorkingDir(dir);
          saveDefaultWorkingDir(dir);
        }}
        initialPath={defaultWorkingDir || undefined}
      />

      {/* Confirmation dialog */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Save</AlertDialogTitle>
            <AlertDialogDescription>
              This will overwrite your current ~/.gemini/settings.json file. Are
              you sure you want to continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingSaveAction && handleSave(pendingSaveAction)}
            >
              Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Skip-permissions warning dialog */}
      <AlertDialog open={showSkipPermWarning} onOpenChange={setShowSkipPermWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable Auto-approve All Actions?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This will bypass all permission checks. Gemini will be able to
                  execute any tool action without asking for your confirmation,
                  including:
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Running arbitrary shell commands</li>
                  <li>Reading, writing, and deleting files</li>
                  <li>Making network requests</li>
                </ul>
                <p className="font-medium text-orange-600 dark:text-orange-400">
                  Only enable this if you fully trust the task at hand. This
                  setting applies to all new chat sessions.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => saveSkipPermissions(true)}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              Enable Auto-approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
