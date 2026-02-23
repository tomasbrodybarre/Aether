/**
 * parse-segments.ts — Splits markdown into text and code segments.
 *
 * Used by SegmentedResponse to render editable cells for code/prose blocks
 * while passing plain text through Streamdown unchanged.
 *
 * Key invariant: reconstructMarkdown(parseResponseSegments(md)) === md
 */

export interface TextSegment {
  type: 'text';
  content: string;
}

export interface CodeSegment {
  type: 'code';
  /** Raw content inside the fences (no fence markers) */
  content: string;
  /** Language tag from the opening fence (e.g. 'python', 'text', 'prose') */
  language: string;
  /** The fence character used ('`' or '~') */
  fenceChar: string;
  /** Number of fence characters (3+) */
  fenceCount: number;
}

export type ResponseSegment = TextSegment | CodeSegment;

/** Language tags that make a code block editable as prose in Phase 1 */
const EDITABLE_PROSE_LANGUAGES = new Set(['text', 'prose', 'markdown', 'md']);

/**
 * Returns true if this segment should be rendered as an editable cell.
 * Phase 1: only prose languages. Phase 2 will add all code languages.
 */
export function isEditableCell(segment: ResponseSegment): boolean {
  return segment.type === 'code' && EDITABLE_PROSE_LANGUAGES.has(segment.language.toLowerCase());
}

/**
 * Parse a markdown string into an array of text and code segments.
 *
 * Handles:
 * - Backtick (```) and tilde (~~~) fences
 * - Variable-length fences (3+ chars)
 * - Nested fences (longer fence inside shorter)
 * - Language tags on opening fence
 * - Preserves all whitespace for lossless roundtrip
 */
export function parseResponseSegments(markdown: string): ResponseSegment[] {
  const segments: ResponseSegment[] = [];
  const lines = markdown.split('\n');
  let textLines: string[] = [];
  let codeLines: string[] = [];
  let inCode = false;
  let fenceChar = '';
  let fenceCount = 0;
  let language = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inCode) {
      // Check for opening fence
      const openMatch = line.match(/^(`{3,}|~{3,})\s*([\w.-]*)\s*$/);
      if (openMatch) {
        // Flush accumulated text
        if (textLines.length > 0) {
          segments.push({ type: 'text', content: textLines.join('\n') });
          textLines = [];
        }
        inCode = true;
        fenceChar = openMatch[1][0];
        fenceCount = openMatch[1].length;
        language = openMatch[2] || '';
        codeLines = [];
      } else {
        textLines.push(line);
      }
    } else {
      // Check for closing fence — must use same char and at least same count
      const closeRegex = fenceChar === '`'
        ? new RegExp(`^\`{${fenceCount},}\\s*$`)
        : new RegExp(`^~{${fenceCount},}\\s*$`);

      if (closeRegex.test(line)) {
        // End of code block
        segments.push({
          type: 'code',
          content: codeLines.join('\n'),
          language,
          fenceChar,
          fenceCount,
        });
        inCode = false;
        fenceChar = '';
        fenceCount = 0;
        language = '';
        codeLines = [];
      } else {
        codeLines.push(line);
      }
    }
  }

  // Handle unterminated code block — treat opening fence + content as text
  if (inCode) {
    const openingFence = fenceChar.repeat(fenceCount) + (language ? language : '');
    textLines.push(openingFence, ...codeLines);
  }

  // Flush remaining text
  if (textLines.length > 0) {
    segments.push({ type: 'text', content: textLines.join('\n') });
  }

  return segments;
}

/**
 * Reconstruct the original markdown from segments.
 * Invariant: reconstructMarkdown(parseResponseSegments(md)) === md
 */
export function reconstructMarkdown(segments: ResponseSegment[]): string {
  return segments.map((seg) => {
    if (seg.type === 'text') return seg.content;
    const fence = seg.fenceChar.repeat(seg.fenceCount);
    const openingLine = seg.language ? `${fence}${seg.language}` : fence;
    return `${openingLine}\n${seg.content}\n${fence}`;
  }).join('\n');
}

/**
 * Replace one code segment's content and reconstruct the full markdown.
 * Used when saving an edit — updates the segment at the given index.
 */
export function replaceSegmentContent(
  segments: ResponseSegment[],
  segmentIndex: number,
  newContent: string,
): string {
  const updated = segments.map((seg, i) => {
    if (i === segmentIndex && seg.type === 'code') {
      return { ...seg, content: newContent };
    }
    return seg;
  });
  return reconstructMarkdown(updated);
}

/**
 * Handle the JSON-array response format from the chat API.
 * turns.response can be either raw text or a JSON array with tool blocks.
 * This extracts the display text and provides a way to update it.
 */
export function extractDisplayText(response: string): string {
  if (!response.startsWith('[')) return response;
  try {
    const blocks = JSON.parse(response) as Array<{ type: string; text?: string }>;
    return blocks
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('');
  } catch {
    return response;
  }
}

/**
 * Update the display text within a response that may be a JSON array.
 * Preserves tool blocks while replacing text content.
 */
export function updateResponseContent(original: string, newDisplayText: string): string {
  if (!original.startsWith('[')) return newDisplayText;
  try {
    const blocks = JSON.parse(original) as Array<{ type: string; [key: string]: unknown }>;
    const toolBlocks = blocks.filter((b) => b.type !== 'text');
    return JSON.stringify([{ type: 'text', text: newDisplayText }, ...toolBlocks]);
  } catch {
    return newDisplayText;
  }
}
