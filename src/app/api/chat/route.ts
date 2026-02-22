import { NextRequest } from 'next/server';
import { streamGemini, createTagDetectionTransform } from '@/lib/gemini-core';
import { addMessage, getSession, updateSessionTitle, getSetting, createTurn, updateTurnResponse, getRecentTurnContext } from '@/lib/db';
import type { SendMessageRequest, SSEEvent, TokenUsage, MessageContentBlock, FileAttachment } from '@/types';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as SendMessageRequest & {
      files?: FileAttachment[];
      toolTimeout?: number;
      // Turn-based flow fields
      project_tag?: string | null;
      working_directory?: string;
    };
    const { session_id, content, model, mode, files } = body;

    if (!content) {
      return new Response(JSON.stringify({ error: 'content is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Route to turn-based or session-based flow
    if (!session_id) {
      return handleTurnFlow(request, body);
    }
    return handleSessionFlow(request, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ---------------------------------------------------------------------------
// Turn-based flow (new — project-based model)
// ---------------------------------------------------------------------------

async function handleTurnFlow(
  request: NextRequest,
  body: {
    content: string;
    model?: string;
    mode?: string;
    files?: FileAttachment[];
    project_tag?: string | null;
    working_directory?: string;
  },
) {
  const { content, model, mode, files, project_tag, working_directory } = body;

  const effectiveMode = mode || 'code';
  const effectiveModel = model || getSetting('default_model') || 'gemini-2.5-pro';
  const workDir = working_directory || getSetting('default_working_directory') || process.cwd();

  // Create the turn record with the effective model (so the UI can display it)
  const turn = createTurn(content, project_tag, effectiveModel, workDir, effectiveMode);

  // Handle file uploads
  let fileAttachments: FileAttachment[] | undefined;
  if (files && files.length > 0) {
    const uploadDir = path.join(workDir, '.aether-uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    fileAttachments = files.map((f, i) => ({
      id: f.id || `file-${Date.now()}-${i}`,
      name: f.name,
      type: f.type,
      size: f.size,
      data: f.data,
    }));
  }

  // Determine permission mode from chat mode
  let permissionMode: string;
  let systemPromptOverride: string | undefined;
  switch (effectiveMode) {
    case 'plan':
      permissionMode = 'plan';
      break;
    case 'ask':
      permissionMode = 'default';
      systemPromptOverride = 'You are in Ask mode. Answer questions and provide information only. Do not use any tools, do not read or write files, do not execute commands. Only respond with text.';
      break;
    default: // 'code'
      permissionMode = 'acceptEdits';
      break;
  }

  const abortController = new AbortController();
  request.signal.addEventListener('abort', () => {
    abortController.abort();
  });

  // Tag detection: always detect unless turn was manually tagged
  const shouldDetectTag = turn.project_tag_source !== 'manual';

  // Fetch recent turns for context injection (project-scoped if tagged, global otherwise)
  // Results come back DESC (newest first) — reverse for chronological preamble order
  const recentTurns = project_tag
    ? getRecentTurnContext(5, project_tag).reverse()
    : getRecentTurnContext(5).reverse();

  const rawStream = streamGemini({
    prompt: content,
    model: effectiveModel,
    systemPrompt: systemPromptOverride,
    workingDirectory: workDir,
    abortController,
    permissionMode,
    files: fileAttachments,
    projectTag: turn.project_tag || undefined,
    recentTurns,
  });

  // Pipe through tag detection (routes to updateTurnProjectTag)
  const taggedStream = rawStream.pipeThrough(
    createTagDetectionTransform(turn.id, shouldDetectTag, 'turn'),
  );

  // Tee: one for client, one for collecting the response into the turn
  const [streamForClient, streamForCollect] = taggedStream.tee();

  // Save turn response in background
  collectTurnResponse(streamForCollect, turn.id);

  // Prepend a turn_created event so the frontend knows the turn ID
  const turnCreatedEvent = `data: ${JSON.stringify({
    type: 'turn_created',
    data: JSON.stringify({ turn_id: turn.id, project_tag: turn.project_tag }),
  })}\n\n`;

  const prependStream = new ReadableStream<string>({
    async start(controller) {
      controller.enqueue(turnCreatedEvent);
      const reader = streamForClient.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(prependStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ---------------------------------------------------------------------------
// Session-based flow (legacy — kept for backward compatibility)
// ---------------------------------------------------------------------------

async function handleSessionFlow(
  request: NextRequest,
  body: SendMessageRequest & { files?: FileAttachment[] },
) {
  const { session_id, content, model, mode, files } = body;

  if (!session_id) {
    return new Response(JSON.stringify({ error: 'session_id is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = getSession(session_id);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Save user message — persist file metadata so attachments survive page reload
  let savedContent = content;
  if (files && files.length > 0) {
    const workDir = session.working_directory || process.cwd();
    const uploadDir = path.join(workDir, '.aether-uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const fileMeta = files.map((f) => {
      const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
      const buffer = Buffer.from(f.data, 'base64');
      fs.writeFileSync(filePath, buffer);
      return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
    });
    savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${content}`;
  }
  addMessage(session_id, 'user', savedContent);

  // Auto-generate title from first message if still default
  if (session.title === 'New Chat') {
    const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
    updateSessionTitle(session_id, title);
  }

  // Determine model: request override > session model > default setting
  const effectiveModel = model || session.model || getSetting('default_model') || undefined;

  // Determine permission mode from chat mode
  const effectiveMode = mode || session.mode || 'code';
  let permissionMode: string;
  let systemPromptOverride: string | undefined;
  switch (effectiveMode) {
    case 'plan':
      permissionMode = 'plan';
      break;
    case 'ask':
      permissionMode = 'default';
      systemPromptOverride = (session.system_prompt || '') +
        '\n\nYou are in Ask mode. Answer questions and provide information only. Do not use any tools, do not read or write files, do not execute commands. Only respond with text.';
      break;
    default: // 'code'
      permissionMode = 'acceptEdits';
      break;
  }

  const abortController = new AbortController();
  request.signal.addEventListener('abort', () => {
    abortController.abort();
  });

  // Convert file attachments to the format expected by streamGemini
  const fileAttachments: FileAttachment[] | undefined = files && files.length > 0
    ? files.map((f, i) => ({
        id: f.id || `file-${Date.now()}-${i}`,
        name: f.name,
        type: f.type,
        size: f.size,
        data: f.data,
      }))
    : undefined;

  // Stream Gemini response via Core library (in-process, no subprocess)
  // Only pass real tags (manual or inferred) to the preamble, not working-dir basenames
  const realTag = session.project_tag || undefined;
  const shouldDetectTag = session.project_tag_source !== 'manual';

  const rawStream = streamGemini({
    prompt: content,
    model: effectiveModel,
    systemPrompt: systemPromptOverride || session.system_prompt || undefined,
    workingDirectory: session.working_directory || undefined,
    abortController,
    permissionMode,
    files: fileAttachments,
    projectTag: realTag,
  });

  // Pipe through tag detection transform (passthrough when disabled)
  const taggedStream = rawStream.pipeThrough(
    createTagDetectionTransform(session_id, shouldDetectTag, 'session'),
  );

  // Tee the stream: one for client, one for collecting the response
  const [streamForClient, streamForCollect] = taggedStream.tee();

  // Save assistant message in background
  collectSessionResponse(streamForCollect, session_id);

  return new Response(streamForClient, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ---------------------------------------------------------------------------
// Response collection helpers
// ---------------------------------------------------------------------------

// Safety-strip any leaked project tag markers from saved text
const TAG_MARKER_SAFETY_RE = /<!--\s*project:\s*.+?\s*-->/g;

/** Collect stream response and save to turns table */
async function collectTurnResponse(stream: ReadableStream<string>, turnId: string) {
  const { contentBlocks, tokenUsage } = await _collectStreamBlocks(stream);

  if (contentBlocks.length > 0) {
    const hasToolBlocks = contentBlocks.some(
      (b) => b.type === 'tool_use' || b.type === 'tool_result'
    );
    const content = hasToolBlocks
      ? JSON.stringify(contentBlocks)
      : contentBlocks
          .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();

    if (content) {
      const toolCallCount = contentBlocks.filter(b => b.type === 'tool_use').length;
      updateTurnResponse(
        turnId,
        content,
        tokenUsage?.input_tokens ?? null,
        tokenUsage?.output_tokens ?? null,
        toolCallCount,
        null, // duration_ms — computed client-side if needed
      );
    }
  }
}

/** Collect stream response and save to messages table (legacy sessions) */
async function collectSessionResponse(stream: ReadableStream<string>, sessionId: string) {
  const { contentBlocks, tokenUsage } = await _collectStreamBlocks(stream);

  if (contentBlocks.length > 0) {
    const hasToolBlocks = contentBlocks.some(
      (b) => b.type === 'tool_use' || b.type === 'tool_result'
    );
    const content = hasToolBlocks
      ? JSON.stringify(contentBlocks)
      : contentBlocks
          .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();

    if (content) {
      addMessage(
        sessionId,
        'assistant',
        content,
        tokenUsage ? JSON.stringify(tokenUsage) : null,
      );
    }
  }
}

/** Shared stream block collector — parses SSE events into content blocks */
async function _collectStreamBlocks(stream: ReadableStream<string>): Promise<{
  contentBlocks: MessageContentBlock[];
  tokenUsage: TokenUsage | null;
}> {
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  let tokenUsage: TokenUsage | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event: SSEEvent = JSON.parse(line.slice(6));
            if (event.type === 'permission_request' || event.type === 'tool_output' || event.type === 'memory_observation' || event.type === 'project_tag') {
              // Skip — not saved as message content
            } else if (event.type === 'text') {
              currentText += event.data;
            } else if (event.type === 'tool_use') {
              if (currentText.trim()) {
                contentBlocks.push({ type: 'text', text: currentText });
                currentText = '';
              }
              try {
                const toolData = JSON.parse(event.data);
                contentBlocks.push({
                  type: 'tool_use',
                  id: toolData.id,
                  name: toolData.name,
                  input: toolData.input,
                });
              } catch {
                // skip malformed tool_use data
              }
            } else if (event.type === 'tool_result') {
              try {
                const resultData = JSON.parse(event.data);
                contentBlocks.push({
                  type: 'tool_result',
                  tool_use_id: resultData.tool_use_id,
                  content: resultData.content,
                  is_error: resultData.is_error || false,
                });
              } catch {
                // skip malformed tool_result data
              }
            } else if (event.type === 'result') {
              try {
                const resultData = JSON.parse(event.data);
                if (resultData.usage) {
                  tokenUsage = resultData.usage;
                }
              } catch {
                // skip malformed result data
              }
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    }
  } catch {
    // Stream reading error — best effort
  }

  // Flush any remaining text (safety-strip leaked markers)
  currentText = currentText.replace(TAG_MARKER_SAFETY_RE, '');
  if (currentText.trim()) {
    contentBlocks.push({ type: 'text', text: currentText });
  }

  return { contentBlocks, tokenUsage };
}
