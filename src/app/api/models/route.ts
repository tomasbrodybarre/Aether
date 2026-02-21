/**
 * GET /api/models — returns the list of available Gemini models.
 *
 * Reads model constants directly from @google/gemini-cli-core so the
 * selector stays in sync whenever the Core library is upgraded.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Import from Core's internal models module (not re-exported at top level)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const models = await import('@google/gemini-cli-core/dist/src/config/models.js');

interface ModelOption {
  value: string;
  label: string;
  group: 'gemini-3' | 'gemini-2.5' | 'gemini-2';
  preview?: boolean;
}

/**
 * Build the ordered model list from Core's constants.
 * All models in VALID_GEMINI_MODELS are exposed — the Core library handles
 * access/availability checks at runtime when a model is actually used.
 */
function buildModelList(): ModelOption[] {
  const {
    VALID_GEMINI_MODELS,
    PREVIEW_GEMINI_MODEL,
    PREVIEW_GEMINI_FLASH_MODEL,
    DEFAULT_GEMINI_MODEL,
    DEFAULT_GEMINI_FLASH_MODEL,
    DEFAULT_GEMINI_FLASH_LITE_MODEL,
    isPreviewModel,
  } = models;

  // Curated ordering: Gemini 3 → 2.5 → 2
  const orderedModels: Array<{ id: string; group: ModelOption['group'] }> = [
    { id: PREVIEW_GEMINI_MODEL, group: 'gemini-3' },        // gemini-3-pro-preview
    { id: PREVIEW_GEMINI_FLASH_MODEL, group: 'gemini-3' },  // gemini-3-flash-preview
    { id: DEFAULT_GEMINI_MODEL, group: 'gemini-2.5' },      // gemini-2.5-pro
    { id: DEFAULT_GEMINI_FLASH_MODEL, group: 'gemini-2.5' },// gemini-2.5-flash
    { id: DEFAULT_GEMINI_FLASH_LITE_MODEL, group: 'gemini-2.5' }, // gemini-2.5-flash-lite
  ];

  // Also pick up any models in VALID_GEMINI_MODELS we haven't listed
  // (future-proofing in case Core adds new ones)
  for (const m of VALID_GEMINI_MODELS) {
    if (!orderedModels.some((o) => o.id === m)) {
      const group = m.includes('3') ? 'gemini-3' as const
        : m.includes('2.5') ? 'gemini-2.5' as const
        : 'gemini-2' as const;
      orderedModels.push({ id: m, group });
    }
  }

  return orderedModels.map((m) => ({
    value: m.id,
    label: formatLabel(m.id),
    group: m.group,
    ...(isPreviewModel(m.id) ? { preview: true } : {}),
  }));
}

/** Produce a short human-friendly label from the model ID. */
function formatLabel(model: string): string {
  // gemini-3-pro-preview   → "3 Pro (Preview)"
  // gemini-3-flash-preview → "3 Flash (Preview)"
  // gemini-2.5-pro         → "2.5 Pro"
  // gemini-2.5-flash       → "2.5 Flash"
  // gemini-2.5-flash-lite  → "2.5 Flash Lite"
  const preview = model.includes('preview');
  const cleaned = model
    .replace(/^gemini-/, '')
    .replace(/-preview$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase()); // title-case
  return preview ? `${cleaned} (Preview)` : cleaned;
}

export async function GET() {
  try {
    const list = buildModelList();
    return NextResponse.json({ models: list });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load models';
    return NextResponse.json({ error: message, models: [] }, { status: 500 });
  }
}
