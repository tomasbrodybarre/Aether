'use client';

import { useMemo, useCallback } from 'react';
import { MessageResponse } from './message';
import { EditableCell } from './editable-cell';
import {
  parseResponseSegments,
  isEditableCell,
  type ResponseSegment,
} from '@/lib/parse-segments';

interface SegmentedResponseProps {
  content: string;
  turnId: string;
  onDiscuss?: (turnId: string, cellIndex: number, newContent: string) => void;
  onSave?: (turnId: string, cellIndex: number, newContent: string) => void;
}

/**
 * Renders assistant response content by splitting it into text segments
 * (rendered via Streamdown) and editable code/prose segments (rendered
 * via EditableCell with CodeMirror for editing).
 *
 * Non-editable code blocks and plain text pass through to Streamdown
 * as a combined text block for normal rendering (syntax highlighting, etc).
 */
export function SegmentedResponse({
  content,
  turnId,
  onDiscuss,
  onSave,
}: SegmentedResponseProps) {
  const segments = useMemo(() => parseResponseSegments(content), [content]);

  // Check if there are ANY editable cells — if not, skip segmentation entirely
  const hasEditableCells = useMemo(
    () => segments.some(isEditableCell),
    [segments]
  );

  const handleDiscuss = useCallback(
    (segmentIndex: number, newContent: string) => {
      onDiscuss?.(turnId, segmentIndex, newContent);
    },
    [turnId, onDiscuss]
  );

  const handleSave = useCallback(
    (segmentIndex: number, newContent: string) => {
      onSave?.(turnId, segmentIndex, newContent);
    },
    [turnId, onSave]
  );

  // Fast path: no editable cells → render everything through Streamdown
  if (!hasEditableCells) {
    return <MessageResponse>{content}</MessageResponse>;
  }

  // Group consecutive non-editable segments together for Streamdown rendering
  const renderGroups = buildRenderGroups(segments);

  return (
    <div className="segmented-response">
      {renderGroups.map((group, i) => {
        if (group.type === 'streamdown') {
          return (
            <MessageResponse key={`text-${i}`}>
              {group.content}
            </MessageResponse>
          );
        }
        // Editable cell
        return (
          <EditableCell
            key={`cell-${group.segmentIndex}`}
            segment={group.segment}
            segmentIndex={group.segmentIndex}
            turnId={turnId}
            onDiscuss={handleDiscuss}
            onSave={handleSave}
          />
        );
      })}
    </div>
  );
}

// ---- Internal helpers ----

type RenderGroup =
  | { type: 'streamdown'; content: string }
  | { type: 'editable'; segment: import('@/lib/parse-segments').CodeSegment; segmentIndex: number };

/**
 * Groups consecutive non-editable segments into single Streamdown blocks.
 * Editable segments get their own render group.
 */
function buildRenderGroups(segments: ResponseSegment[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let textAccum: string[] = [];

  const flushText = () => {
    if (textAccum.length > 0) {
      groups.push({ type: 'streamdown', content: textAccum.join('\n') });
      textAccum = [];
    }
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'text') {
      textAccum.push(seg.content);
    } else {
      // seg.type === 'code'
      if (isEditableCell(seg)) {
        flushText();
        groups.push({ type: 'editable', segment: seg, segmentIndex: i });
      } else {
        // Non-editable code block — reconstruct as markdown for Streamdown
        const fence = seg.fenceChar.repeat(seg.fenceCount);
        const langTag = seg.language ? ' ' + seg.language : '';
        textAccum.push(`${fence}${langTag}\n${seg.content}\n${fence}`);
      }
    }
  }

  flushText();
  return groups;
}
