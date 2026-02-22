"use client";

import * as Diff from 'diff';
import { cn } from '@/lib/utils';

interface DiffViewProps {
  oldContent: string;
  newContent: string;
  splitView?: boolean;
}

const DiffView = ({ oldContent, newContent }: DiffViewProps) => {
  const diffs = Diff.diffLines(oldContent, newContent);

  return (
    <pre className="p-4 rounded-md bg-neutral-900 text-sm font-mono whitespace-pre-wrap">
      {diffs.map((part, index) => {
        const Icon = part.added ? '+' : part.removed ? '-' : ' ';
        const className = cn(
          'flex items-start',
          {
            'bg-green-900/20 text-green-400': part.added,
            'bg-red-900/20 text-red-400': part.removed,
            'text-neutral-400': !part.added && !part.removed,
          }
        );

        // Don't add a newline to the last part
        const value = part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value;

        return (
          <div key={index} className={className}>
            <span className="w-6 text-center shrink-0">{Icon}</span>
            <span className="flex-grow">{value}</span>
          </div>
        );
      })}
    </pre>
  );
};

export { DiffView };
