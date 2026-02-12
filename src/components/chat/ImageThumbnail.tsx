'use client';

import { cn } from '@/lib/utils';

interface ImageThumbnailProps {
  src: string;
  alt: string;
  onClick: () => void;
  maxHeight?: string;
}

export function ImageThumbnail({ src, alt, onClick, maxHeight = 'max-h-32' }: ImageThumbnailProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className={cn(maxHeight, "w-full object-contain rounded-lg")}
      />
    </button>
  );
}
