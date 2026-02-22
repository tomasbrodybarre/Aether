'use client';

import { useEffect, useState, useCallback, use } from 'react';
import type { TurnRecord } from '@/types';
import { ProjectFeedView } from '@/components/chat/ProjectFeedView';
import { ProjectTagEditor } from '@/components/chat/ProjectTagEditor';
import { Button } from '@/components/ui/button';
import { HugeiconsIcon } from '@hugeicons/react';
import { Loading02Icon } from '@hugeicons/core-free-icons';
import { usePanel } from '@/hooks/usePanel';
import { ConnectionStatus } from '@/components/layout/ConnectionStatus';

// Special route keys
const TIMELINE_TAG = 'timeline';
const UNTAGGED_TAG = 'untagged';

interface ProjectPageProps {
  params: Promise<{ tag: string }>;
}

export default function ProjectPage({ params }: ProjectPageProps) {
  const { tag: rawTag } = use(params);
  const decodedTag = decodeURIComponent(rawTag);

  // Determine the view mode from the URL
  const isTimeline = decodedTag === TIMELINE_TAG;
  const isUntagged = decodedTag === UNTAGGED_TAG;
  // For the legacy 'current' route, treat as untagged
  const isLegacyCurrent = decodedTag === 'current';

  // The actual project_tag for DB queries (null = untagged)
  const projectTag = isTimeline ? '__all__'
    : (isUntagged || isLegacyCurrent) ? null
    : decodedTag;

  const { setWorkingDirectory } = usePanel();
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [allProjectTags, setAllProjectTags] = useState<string[]>([]);

  const fetchTurns = useCallback(async () => {
    try {
      let query: string;
      if (isTimeline) {
        // All turns, no filter
        query = 'limit=200';
      } else if (projectTag === null) {
        query = 'project_tag=__untagged__';
      } else {
        query = `project_tag=${encodeURIComponent(projectTag)}`;
      }
      const res = await fetch(`/api/turns?${query}`);
      if (res.ok) {
        const data = await res.json();
        // API returns DESC, but feed should show ASC (oldest first)
        const turnList: TurnRecord[] = data.turns || [];
        turnList.sort(
          (a: TurnRecord, b: TurnRecord) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
        setTurns(turnList);
      }
    } catch {
      // Best effort
    } finally {
      setLoading(false);
    }
  }, [isTimeline, projectTag]);

  const fetchProjectTags = useCallback(async () => {
    try {
      const res = await fetch('/api/turns/projects');
      if (res.ok) {
        const data = await res.json();
        setAllProjectTags(data.tags || []);
      }
    } catch {
      // Best effort
    }
  }, []);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchTurns();
    fetchProjectTags();
  }, [fetchTurns, fetchProjectTags]);

  // Refresh when turns are created or updated
  useEffect(() => {
    const handler = () => {
      fetchTurns();
      fetchProjectTags();
    };
    window.addEventListener('turn-created', handler);
    window.addEventListener('turn-updated', handler);
    return () => {
      window.removeEventListener('turn-created', handler);
      window.removeEventListener('turn-updated', handler);
    };
  }, [fetchTurns, fetchProjectTags]);

  // Set working directory from most recent turn
  useEffect(() => {
    if (turns.length > 0) {
      const lastWithDir = [...turns].reverse().find((t) => t.working_directory);
      if (lastWithDir?.working_directory) {
        setWorkingDirectory(lastWithDir.working_directory);
      }
    }
  }, [turns, setWorkingDirectory]);

  const [consolidating, setConsolidating] = useState(false);

  const handleConsolidate = useCallback(async () => {
    if (isTimeline || isUntagged || isLegacyCurrent || consolidating) return;
    setConsolidating(true);
    try {
      const res = await fetch('/api/memory/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName: decodedTag }),
      });
      if (!res.ok) {
        console.error('Consolidation failed:', await res.text());
      }
    } catch (err) {
      console.error('Consolidation error:', err);
    } finally {
      setConsolidating(false);
    }
  }, [isTimeline, isUntagged, isLegacyCurrent, decodedTag, consolidating]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <HugeiconsIcon
          icon={Loading02Icon}
          className="h-8 w-8 animate-spin text-muted-foreground"
        />
      </div>
    );
  }

  const displayName = isTimeline ? 'Timeline'
    : (isUntagged || isLegacyCurrent) ? 'Untagged'
    : decodedTag;

  // For ProjectFeedView, we pass the actual project tag (null for untagged/timeline)
  // Timeline sends new turns without a project tag — they'll appear in the feed
  const feedProjectTag = isTimeline ? null : projectTag;

  const isProjectView = !isTimeline && !isUntagged && !isLegacyCurrent;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Project header bar */}
      <div className="flex items-center px-4 py-2">
        <div className="flex-1 min-w-0" />
        <span className="text-sm font-medium text-foreground/80 truncate max-w-md">
          {displayName}
        </span>
        <div className="flex-1 min-w-0 flex items-center justify-end gap-2">
          {isProjectView && (
            <>
              <ProjectTagEditor
                currentTag={decodedTag}
                isManualOverride={false}
                autoTag=""
                allTags={allProjectTags}
                onTagChange={() => {
                  // Tag rename would be a bulk operation — for now, show as read-only
                }}
                variant="header"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleConsolidate}
                disabled={consolidating}
              >
                {consolidating ? 'Consolidating...' : 'Consolidate Memory'}
              </Button>
            </>
          )}
          <ConnectionStatus />
        </div>
      </div>

      <ProjectFeedView
        key={rawTag}
        projectTag={feedProjectTag}
        initialTurns={turns}
        isTimeline={isTimeline}
      />
    </div>
  );
}
