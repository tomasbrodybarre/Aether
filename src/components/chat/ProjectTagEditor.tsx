"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle01Icon, Cancel01Icon, Tag01Icon, ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ProjectTagEditorProps {
  /** The current effective tag (project_tag override or auto-derived project_name) */
  currentTag: string;
  /** Whether this tag was manually set (overrides auto) */
  isManualOverride: boolean;
  /** The auto-derived project_name (for "revert" action) */
  autoTag: string;
  /** All known project tags for the suggestion list */
  allTags: string[];
  /** Called when the user sets a new tag */
  onTagChange: (newTag: string | null) => void;
  /** Visual variant */
  variant?: "sidebar" | "header";
}

export function ProjectTagEditor({
  currentTag,
  isManualOverride,
  autoTag,
  allTags,
  onTagChange,
  variant = "sidebar",
}: ProjectTagEditorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSearch("");
      // Focus the input when popover opens
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filteredTags = allTags.filter(
    (tag) =>
      tag.toLowerCase().includes(search.toLowerCase()) && tag !== currentTag
  );

  const handleSelect = useCallback(
    (tag: string) => {
      onTagChange(tag);
      setOpen(false);
    },
    [onTagChange]
  );

  const handleRevert = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onTagChange(null); // null = clear override, revert to auto
      setOpen(false);
    },
    [onTagChange]
  );

  const handleCustomSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = search.trim();
      if (trimmed) {
        onTagChange(trimmed);
        setOpen(false);
      }
    },
    [search, onTagChange]
  );

  if (variant === "sidebar") {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className={cn(
              "inline-flex items-center gap-0.5 max-w-full rounded px-1 py-0.5 text-[0.625rem] leading-none transition-colors",
              "hover:bg-accent/60 cursor-pointer",
              isManualOverride
                ? "bg-violet-500/10 text-violet-400"
                : "text-muted-foreground/50"
            )}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen(true);
            }}
          >
            {isManualOverride && (
              <HugeiconsIcon icon={Tag01Icon} className="h-2 w-2 shrink-0" />
            )}
            <span className="truncate">{currentTag || "untagged"}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="right"
          className="w-56 p-2"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <TagPickerContent
            search={search}
            setSearch={setSearch}
            inputRef={inputRef}
            filteredTags={filteredTags}
            currentTag={currentTag}
            isManualOverride={isManualOverride}
            autoTag={autoTag}
            onSelect={handleSelect}
            onRevert={handleRevert}
            onCustomSubmit={handleCustomSubmit}
          />
        </PopoverContent>
      </Popover>
    );
  }

  // Header variant (used in chat header area)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-6 gap-1 px-2 text-xs",
                isManualOverride
                  ? "text-violet-400 hover:text-violet-300"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <HugeiconsIcon icon={Tag01Icon} className="h-3 w-3" />
              {currentTag || "untagged"}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {isManualOverride
            ? `Project tag (manual override, auto: ${autoTag})`
            : "Project tag (auto-derived from working directory)"}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        className="w-56 p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <TagPickerContent
          search={search}
          setSearch={setSearch}
          inputRef={inputRef}
          filteredTags={filteredTags}
          currentTag={currentTag}
          isManualOverride={isManualOverride}
          autoTag={autoTag}
          onSelect={handleSelect}
          onRevert={handleRevert}
          onCustomSubmit={handleCustomSubmit}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Shared inner content for the tag picker popover */
function TagPickerContent({
  search,
  setSearch,
  inputRef,
  filteredTags,
  currentTag,
  isManualOverride,
  autoTag,
  onSelect,
  onRevert,
  onCustomSubmit,
}: {
  search: string;
  setSearch: (s: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  filteredTags: string[];
  currentTag: string;
  isManualOverride: boolean;
  autoTag: string;
  onSelect: (tag: string) => void;
  onRevert: (e: React.MouseEvent) => void;
  onCustomSubmit: (e: React.FormEvent) => void;
}) {
  const trimmedSearch = search.trim();
  const isNewTag =
    trimmedSearch &&
    !filteredTags.includes(trimmedSearch) &&
    trimmedSearch !== currentTag;

  return (
    <div className="flex flex-col gap-1.5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[0.6875rem] font-medium text-muted-foreground">
          Project Tag
        </span>
        {isManualOverride && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.625rem] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                onClick={onRevert}
              >
                <HugeiconsIcon icon={ArrowTurnBackwardIcon} className="h-2.5 w-2.5" />
                Revert to auto
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Revert to auto-derived tag: {autoTag}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Search/create input */}
      <form onSubmit={onCustomSubmit}>
        <Input
          ref={inputRef}
          placeholder="Search or create tag..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 text-xs"
        />
      </form>

      {/* Current tag indicator */}
      <div className="flex items-center gap-1.5 px-1 py-0.5">
        <span className="text-[0.625rem] text-muted-foreground/60">Current:</span>
        <span
          className={cn(
            "text-[0.625rem] font-medium",
            isManualOverride ? "text-violet-400" : "text-foreground/70"
          )}
        >
          {currentTag || "untagged"}
        </span>
        {isManualOverride && (
          <span className="text-[0.5625rem] text-muted-foreground/40">
            (auto: {autoTag})
          </span>
        )}
      </div>

      {/* Tag suggestions list */}
      <div className="flex flex-col gap-0.5 max-h-36 overflow-y-auto">
        {filteredTags.map((tag) => (
          <button
            key={tag}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-left hover:bg-accent transition-colors"
            onClick={() => onSelect(tag)}
          >
            <HugeiconsIcon icon={Tag01Icon} className="h-3 w-3 shrink-0 text-muted-foreground/60" />
            <span className="truncate">{tag}</span>
          </button>
        ))}

        {/* Create new tag option */}
        {isNewTag && (
          <button
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-left hover:bg-accent transition-colors text-violet-400"
            onClick={() => onSelect(trimmedSearch)}
          >
            <HugeiconsIcon icon={CheckmarkCircle01Icon} className="h-3 w-3 shrink-0" />
            <span>
              Create &ldquo;{trimmedSearch}&rdquo;
            </span>
          </button>
        )}

        {filteredTags.length === 0 && !isNewTag && (
          <span className="px-2 py-1 text-[0.625rem] text-muted-foreground/50">
            {search ? "No matching tags" : "No other tags available"}
          </span>
        )}
      </div>

      {/* Clear tag option */}
      {currentTag && (
        <>
          <div className="h-px bg-border" />
          <button
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-left hover:bg-accent transition-colors text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onSelect("");
            }}
          >
            <HugeiconsIcon icon={Cancel01Icon} className="h-3 w-3 shrink-0" />
            <span>Remove tag</span>
          </button>
        </>
      )}
    </div>
  );
}
