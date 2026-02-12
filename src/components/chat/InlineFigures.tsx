'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ImageThumbnail } from './ImageThumbnail';
import { ImageLightbox } from './ImageLightbox';

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|svg|webp|bmp|tiff)$/i;

interface ToolPair {
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
}

/**
 * Extract image file paths from bash command input and output text.
 */
function extractImagePaths(command: string, output: string): string[] {
  const combined = command + '\n' + output;
  const paths: string[] = [];
  // Match absolute paths (Unix or Windows) or relative paths ending in image extension
  const pathPattern = /(?:['"]?)([A-Za-z]:\\[^\s'"<>|*?]+\.(png|jpg|jpeg|gif|svg|webp|bmp|tiff)|(?:\/|\.\/|\.\.\/)[^\s'"<>|*?]+\.(png|jpg|jpeg|gif|svg|webp|bmp|tiff))(?:['"]?)/gi;
  let match;
  while ((match = pathPattern.exec(combined)) !== null) {
    const p = match[1];
    if (p && !paths.includes(p)) {
      paths.push(p);
    }
  }
  return paths;
}

function isBashTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'bash' || lower === 'execute' || lower === 'run' || lower === 'shell' || lower === 'execute_command';
}

/**
 * Renders inline figures extracted from bash tool results.
 * Displayed at the message level (outside collapsed tool blocks) for notebook-like UX.
 */
export function InlineFigures({ tools }: { tools: ToolPair[] }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  // Collect all image paths from bash tool results
  const allImagePaths: string[] = [];
  for (const tool of tools) {
    if (isBashTool(tool.name) && tool.result && !tool.isError) {
      const inp = tool.input as Record<string, unknown> | undefined;
      const command = (inp?.command || inp?.cmd || '') as string;
      const paths = extractImagePaths(command, tool.result);
      for (const p of paths) {
        if (!allImagePaths.includes(p)) {
          allImagePaths.push(p);
        }
      }
    }
  }

  if (allImagePaths.length === 0) return null;

  const images = allImagePaths.map((p, i) => ({
    src: `/api/files/raw?path=${encodeURIComponent(p)}`,
    alt: p.split(/[/\\]/).pop() || `Figure ${i + 1}`,
  }));

  return (
    <div className="my-2">
      <div className={cn(
        "grid gap-2",
        images.length === 1 && "grid-cols-1 max-w-lg",
        images.length === 2 && "grid-cols-2 max-w-2xl",
        images.length >= 3 && "grid-cols-3 max-w-3xl",
      )}>
        {images.map((img, i) => (
          <div key={img.src} className="rounded-lg overflow-hidden border border-border/30 bg-muted/20">
            <ImageThumbnail
              src={img.src}
              alt={img.alt}
              maxHeight="max-h-72"
              onClick={() => { setLightboxIndex(i); setLightboxOpen(true); }}
            />
            <div className="px-2 py-1 text-xs text-muted-foreground truncate">{img.alt}</div>
          </div>
        ))}
      </div>
      <ImageLightbox
        images={images}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
      />
    </div>
  );
}
