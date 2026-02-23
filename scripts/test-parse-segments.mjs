/**
 * Quick validation script for parseResponseSegments roundtrip correctness.
 * Run: node scripts/test-parse-segments.mjs
 */

// We can't import TypeScript directly, so we test the logic inline
// (the same algorithm as parse-segments.ts)

function parseResponseSegments(markdown) {
  const segments = [];
  const lines = markdown.split('\n');
  let textLines = [];
  let codeLines = [];
  let inCode = false;
  let fenceChar = '';
  let fenceCount = 0;
  let language = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inCode) {
      const openMatch = line.match(/^(`{3,}|~{3,})\s*([\w.-]*)\s*$/);
      if (openMatch) {
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
      const closeRegex = fenceChar === '`'
        ? new RegExp(`^\`{${fenceCount},}\\s*$`)
        : new RegExp(`^~{${fenceCount},}\\s*$`);

      if (closeRegex.test(line)) {
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

  if (inCode) {
    const openingFence = fenceChar.repeat(fenceCount) + (language ? language : '');
    textLines.push(openingFence, ...codeLines);
  }

  if (textLines.length > 0) {
    segments.push({ type: 'text', content: textLines.join('\n') });
  }

  return segments;
}

function reconstructMarkdown(segments) {
  return segments.map((seg) => {
    if (seg.type === 'text') return seg.content;
    const fence = seg.fenceChar.repeat(seg.fenceCount);
    const openingLine = seg.language ? `${fence}${seg.language}` : fence;
    return `${openingLine}\n${seg.content}\n${fence}`;
  }).join('\n');
}

const EDITABLE = new Set(['text', 'prose', 'markdown', 'md']);
function isEditableCell(seg) {
  return seg.type === 'code' && EDITABLE.has(seg.language.toLowerCase());
}

// --- Tests ---
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected:\n${JSON.stringify(b)}\nGot:\n${JSON.stringify(a)}`);
}

console.log('Testing parseResponseSegments...\n');

test('plain text — no code blocks', () => {
  const md = 'Hello world\nSecond line';
  const segs = parseResponseSegments(md);
  assert(segs.length === 1);
  assertEqual(segs[0].type, 'text');
  assertEqual(segs[0].content, md);
  assertEqual(reconstructMarkdown(segs), md);
});

test('single code block', () => {
  const md = '```python\nprint("hi")\n```';
  const segs = parseResponseSegments(md);
  assert(segs.length === 1);
  assertEqual(segs[0].type, 'code');
  assertEqual(segs[0].language, 'python');
  assertEqual(segs[0].content, 'print("hi")');
  assertEqual(reconstructMarkdown(segs), md);
});

test('text + code + text', () => {
  const md = 'Before\n```text\nEditable prose\n```\nAfter';
  const segs = parseResponseSegments(md);
  assert(segs.length === 3, `Expected 3 segments, got ${segs.length}`);
  assertEqual(segs[0].type, 'text');
  assertEqual(segs[0].content, 'Before');
  assertEqual(segs[1].type, 'code');
  assertEqual(segs[1].language, 'text');
  assertEqual(segs[1].content, 'Editable prose');
  assertEqual(segs[2].type, 'text');
  assertEqual(segs[2].content, 'After');
  assertEqual(reconstructMarkdown(segs), md);
});

test('multiple code blocks', () => {
  const md = 'Start\n```python\ncode1\n```\nMiddle\n```prose\nmy prose\n```\nEnd';
  const segs = parseResponseSegments(md);
  assert(segs.length === 5, `Expected 5 segments, got ${segs.length}`);
  assertEqual(segs[1].language, 'python');
  assertEqual(segs[3].language, 'prose');
  assert(!isEditableCell(segs[1]), 'python should not be editable');
  assert(isEditableCell(segs[3]), 'prose should be editable');
  assertEqual(reconstructMarkdown(segs), md);
});

test('tilde fences', () => {
  const md = '~~~markdown\n# Title\n~~~';
  const segs = parseResponseSegments(md);
  assert(segs.length === 1);
  assertEqual(segs[0].type, 'code');
  assertEqual(segs[0].fenceChar, '~');
  assertEqual(segs[0].fenceCount, 3);
  assertEqual(segs[0].language, 'markdown');
  assert(isEditableCell(segs[0]));
  assertEqual(reconstructMarkdown(segs), md);
});

test('longer fences (4+ backticks)', () => {
  const md = '````text\nSome content with ```backticks```\n````';
  const segs = parseResponseSegments(md);
  assert(segs.length === 1);
  assertEqual(segs[0].fenceCount, 4);
  assertEqual(segs[0].content, 'Some content with ```backticks```');
  assertEqual(reconstructMarkdown(segs), md);
});

test('unterminated code block treated as text', () => {
  const md = '```python\nno closing fence';
  const segs = parseResponseSegments(md);
  // Unterminated: opening fence + content become text
  assert(segs.length === 1, `Expected 1 segment, got ${segs.length}`);
  assertEqual(segs[0].type, 'text');
  assertEqual(segs[0].content, '```python\nno closing fence');
});

test('unterminated code block with preceding text', () => {
  const md = 'Start\n```python\nno closing fence';
  const segs = parseResponseSegments(md);
  // "Start" flushed as text before fence, then unterminated fence+content becomes second text segment
  assert(segs.length === 2, `Expected 2 segments, got ${segs.length}: ${JSON.stringify(segs.map(s => s.type))}`);
  assertEqual(segs[0].type, 'text');
  assertEqual(segs[0].content, 'Start');
  assertEqual(segs[1].type, 'text');
  assertEqual(segs[1].content, '```python\nno closing fence');
});

test('empty code block', () => {
  const md = '```text\n\n```';
  const segs = parseResponseSegments(md);
  assert(segs.length === 1);
  assertEqual(segs[0].type, 'code');
  assertEqual(segs[0].content, '');
  assertEqual(reconstructMarkdown(segs), md);
});

test('editable languages: text, prose, markdown, md', () => {
  for (const lang of ['text', 'prose', 'markdown', 'md']) {
    const md = `\`\`\`${lang}\ncontent\n\`\`\``;
    const segs = parseResponseSegments(md);
    assert(isEditableCell(segs[0]), `${lang} should be editable`);
  }
  for (const lang of ['python', 'javascript', 'bash', '']) {
    const md = `\`\`\`${lang}\ncontent\n\`\`\``;
    const segs = parseResponseSegments(md);
    assert(!isEditableCell(segs[0]), `${lang} should NOT be editable`);
  }
});

test('roundtrip with complex mixed content', () => {
  const md = `Here's some text with **bold** and $math$.

\`\`\`python
def hello():
    print("world")
\`\`\`

Some more text.

\`\`\`prose
This is a creative writing passage.
It spans multiple lines.
\`\`\`

Final paragraph.`;

  const segs = parseResponseSegments(md);
  assertEqual(reconstructMarkdown(segs), md, 'Roundtrip failed for complex content');
  assert(segs.length === 5, `Expected 5 segments, got ${segs.length}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
