'use client';

import { useState, useEffect, useRef } from 'react';
import { usePanel } from '@/hooks/usePanel';
import { ImageLightbox } from './ImageLightbox';

interface ToolPair {
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
}

/**
 * Extract image file paths from bash tool output.
 * Only scans the output (not the command) to avoid false positives from
 * code that mentions image extensions in variable names or comments.
 */
function extractImagePaths(_command: string, output: string): string[] {
  const paths: string[] = [];
  const imgExts = 'png|jpg|jpeg|gif|svg|webp|bmp|tiff';
  const pathPattern = new RegExp(
    `(?:['"\`]?)` +
    `([A-Za-z]:\\\\[^\\s'"\`<>|*?]+\\.(?:${imgExts})` +
    `|(?:\\/|\\.\\/|\\.\\.\\/)[^\\s'"\`<>|*?]+\\.(?:${imgExts})` +
    `|[\\w][^\\s'"\`<>|*?]*\\.(?:${imgExts})` +
    `)(?:['"\`]?)`,
    'gi'
  );
  let match;
  while ((match = pathPattern.exec(output)) !== null) {
    const p = match[1];
    if (p && !paths.includes(p)) {
      paths.push(p);
    }
  }
  return paths;
}

/** Tools whose output may contain image file paths. */
function canContainImagePaths(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'bash' || lower === 'execute' || lower === 'run' || lower === 'shell'
    || lower === 'execute_command' || lower === 'glob' || lower === 'read'
    || lower === 'write' || lower === 'list' || lower === 'tool_result';
}

function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p) || p.startsWith('/');
}

// Module-level cache for default figure width
let cachedDefaultWidth: number | null = null;

function getDefaultFigureWidth(): number {
  return cachedDefaultWidth ?? 100;
}

function ResizableFigure({
  src,
  alt,
  onClick,
}: {
  src: string;
  alt: string;
  onClick: () => void;
}) {
  const [width, setWidth] = useState(getDefaultFigureWidth);
  const [sliderValue, setSliderValue] = useState(getDefaultFigureWidth);
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  return (
    <div style={{ width: `${width}%` }} className="min-w-[120px]">
      <div className="rounded-lg overflow-hidden border border-border/30 bg-muted/20">
        <button
          type="button"
          onClick={onClick}
          className="w-full cursor-pointer hover:opacity-80 transition"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            className="w-full object-contain"
            onError={() => setFailed(true)}
          />
        </button>
        <div className="px-2 py-1.5 flex items-center gap-2">
          <input
            type="range"
            min={20}
            max={100}
            step={5}
            value={sliderValue}
            onChange={(e) => setSliderValue(parseInt(e.target.value, 10))}
            onMouseUp={() => setWidth(sliderValue)}
            onTouchEnd={() => setWidth(sliderValue)}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 h-1 accent-primary cursor-pointer"
            title={`${sliderValue}% width`}
          />
          <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right shrink-0">
            {sliderValue}%
          </span>
        </div>
        <div className="px-2 pb-1 text-xs text-muted-foreground truncate">{alt}</div>
      </div>
    </div>
  );
}

export function InlineFigures({ tools }: { tools: ToolPair[] }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const { workingDirectory } = usePanel();
  const fetchedRef = useRef(false);
  const [, setDefaultLoaded] = useState(false);

  // Fetch default figure width once
  useEffect(() => {
    if (fetchedRef.current || cachedDefaultWidth !== null) return;
    fetchedRef.current = true;
    fetch('/api/settings/app')
      .then((r) => r.json())
      .then((data) => {
        const w = parseInt(data.settings?.default_figure_width, 10);
        if (w >= 20 && w <= 100) {
          cachedDefaultWidth = w;
          setDefaultLoaded(true); // trigger re-render so ResizableFigure picks up the new default
        }
      })
      .catch(() => {});
  }, []);

  const allImagePaths: string[] = [];
  for (const tool of tools) {
    if (canContainImagePaths(tool.name) && tool.result && !tool.isError) {
      const paths = extractImagePaths('', tool.result);
      for (const p of paths) {
        if (!allImagePaths.includes(p)) {
          allImagePaths.push(p);
        }
      }
    }
  }

  if (allImagePaths.length === 0) return null;

  const images = allImagePaths.map((p, i) => {
    const params = new URLSearchParams({ path: p });
    if (workingDirectory) {
      params.set('cwd', workingDirectory);
    }
    return {
      src: `/api/files/raw?${params.toString()}`,
      alt: p.split(/[/\\]/).pop() || `Figure ${i + 1}`,
    };
  });

  return (
    <div className="my-2 space-y-2">
      {images.map((img, i) => (
        <ResizableFigure
          key={img.src}
          src={img.src}
          alt={img.alt}
          onClick={() => { setLightboxIndex(i); setLightboxOpen(true); }}
        />
      ))}
      <ImageLightbox
        images={images}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
      />
    </div>
  );
}
