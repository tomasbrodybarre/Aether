/**
 * Aether — Phase 0 Sanity Check
 *
 * Verify that @google/gemini-cli-core can be:
 * 1. Imported as an ESM library
 * 2. Used to create a Config + GeminiClient
 * 3. Used to stream events from a prompt via Turn.run()
 * 4. Used to subscribe to the MessageBus
 *
 * Usage: node test-core-import.mjs
 */

import { randomUUID } from 'node:crypto';

// ── Step 1: Import Core ─────────────────────────────────────────────
console.log('=== Step 1: Import @google/gemini-cli-core ===');
let core;
try {
  core = await import('@google/gemini-cli-core');
  console.log('✓ Import successful');

  // Log key exports to verify API surface
  const keyExports = [
    'Config', 'GeminiClient', 'Turn', 'MessageBus', 'PolicyEngine',
    'GeminiEventType', 'PolicyDecision', 'ApprovalMode',
    'DEFAULT_GEMINI_MODEL', 'AuthType'
  ];

  for (const name of keyExports) {
    const exists = name in core;
    console.log(`  ${exists ? '✓' : '✗'} ${name}: ${exists ? typeof core[name] : 'MISSING'}`);
  }
} catch (err) {
  console.error('✗ Import failed:', err.message);
  process.exit(1);
}

// ── Step 2: Create Config ───────────────────────────────────────────
console.log('\n=== Step 2: Create Config ===');

const { Config, GeminiClient, Turn, MessageBus, PolicyEngine,
        GeminiEventType, PolicyDecision, ApprovalMode,
        DEFAULT_GEMINI_MODEL, MessageBusType, AuthType } = core;

let config;
try {
  // Minimal config — mirror what the CLI does but stripped down
  config = new Config({
    sessionId: randomUUID(),
    clientVersion: '0.0.1-aether-sanity',
    targetDir: process.cwd(),
    cwd: process.cwd(),
    model: DEFAULT_GEMINI_MODEL || 'gemini-2.5-pro',
    debugMode: false,
    interactive: false,
    approvalMode: ApprovalMode?.DEFAULT || 'default',
  });

  console.log('✓ Config created');
  console.log(`  Model: ${config.getModel?.() || 'unknown'}`);
} catch (err) {
  console.error('✗ Config creation failed:', err.message);
  console.error('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

// ── Step 3: Initialize ──────────────────────────────────────────────
console.log('\n=== Step 3: Initialize Config ===');
try {
  await config.initialize();
  console.log('✓ Config initialized');

  // Set up auth — use OAuth (LOGIN_WITH_GOOGLE) which reuses cached credentials
  console.log('  Setting up auth (OAuth)...');
  await config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);
  console.log('✓ Auth configured (OAuth/LOGIN_WITH_GOOGLE)');
} catch (err) {
  console.error('✗ Config initialization failed:', err.message);
  console.error('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

// ── Step 4: Check MessageBus ────────────────────────────────────────
console.log('\n=== Step 4: Verify MessageBus ===');
try {
  const bus = config.getMessageBus();
  console.log(`✓ MessageBus available: ${!!bus}`);
  console.log(`  Type: ${bus?.constructor?.name}`);

  // Subscribe to tool confirmation events
  if (bus && bus.subscribe) {
    const confirmationType = MessageBusType?.TOOL_CONFIRMATION_REQUEST || 'tool-confirmation-request';
    bus.subscribe(confirmationType, (msg) => {
      console.log(`  [MessageBus] Tool confirmation request: ${msg.toolCall?.name}`);
    });
    console.log('✓ Subscribed to tool confirmation events');
  }
} catch (err) {
  console.error('✗ MessageBus setup failed:', err.message);
}

// ── Step 5: Get GeminiClient and start chat ─────────────────────────
console.log('\n=== Step 5: Start Chat & Stream ===');
try {
  const client = config.getGeminiClient();
  console.log(`✓ GeminiClient obtained: ${!!client}`);

  // Start a chat session
  const chat = await client.startChat();
  console.log(`✓ Chat started`);

  // Create abort controller
  const ac = new AbortController();

  // Set a 30s timeout
  const timeout = setTimeout(() => {
    console.log('  [Timeout] Aborting after 30s');
    ac.abort();
  }, 30000);

  // Stream a simple prompt
  const promptId = randomUUID();
  console.log(`  Sending prompt: "What is 2+2? Reply with just the number."`);
  console.log('  ---');

  const stream = client.sendMessageStream(
    [{ text: 'What is 2+2? Reply with just the number.' }],
    ac.signal,
    promptId
  );

  let eventCount = 0;
  for await (const event of stream) {
    eventCount++;

    switch (event.type) {
      case GeminiEventType?.Content || 'content':
        process.stdout.write(`  [Content] ${event.value}`);
        break;
      case GeminiEventType?.Thought || 'thought':
        console.log(`  [Thought] (thinking...)`);
        break;
      case GeminiEventType?.ToolCallRequest || 'tool_call_request':
        console.log(`  [ToolCall] ${event.value?.name}(${JSON.stringify(event.value?.args)})`);
        break;
      case GeminiEventType?.ToolCallConfirmation || 'tool_call_confirmation':
        console.log(`  [Confirmation] Needs approval: ${event.value?.details?.type}`);
        break;
      case GeminiEventType?.Finished || 'finished':
        console.log(`\n  [Finished] Reason: ${event.value?.reason}`);
        if (event.value?.usageMetadata) {
          const usage = event.value.usageMetadata;
          console.log(`  [Usage] Input: ${usage.promptTokenCount}, Output: ${usage.candidatesTokenCount}, Total: ${usage.totalTokenCount}`);
        }
        break;
      case GeminiEventType?.Error || 'error':
        console.error(`  [Error] ${event.value?.error?.message}`);
        break;
      default:
        console.log(`  [${event.type}] ${JSON.stringify(event.value).slice(0, 100)}`);
    }
  }

  clearTimeout(timeout);
  console.log(`\n✓ Stream complete. Total events: ${eventCount}`);

} catch (err) {
  console.error('✗ Streaming failed:', err.message);
  console.error('  Stack:', err.stack?.split('\n').slice(0, 8).join('\n'));
}

// ── Step 6: Cleanup ─────────────────────────────────────────────────
console.log('\n=== Step 6: Cleanup ===');
try {
  if (config.dispose) {
    await config.dispose();
    console.log('✓ Config disposed');
  }
} catch (err) {
  console.error('✗ Disposal failed:', err.message);
}

console.log('\n=== Phase 0 Sanity Check Complete ===');
process.exit(0);
