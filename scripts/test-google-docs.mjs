/**
 * Test script for Google Docs integration.
 *
 * Usage: node scripts/test-google-docs.mjs [token-path]
 *
 * Tests:
 * 1. Read and parse token.json
 * 2. Refresh access token
 * 3. Create a test document
 * 4. Append first content
 * 5. Append second content (with separator)
 * 6. Verify both sections are present
 * 7. Delete the test document (cleanup)
 */

import fs from 'fs';
import path from 'path';

const TOKEN_PATH = process.argv[2] || 'C:/agent-hub/config/token.json';
const DOCS_API = 'https://docs.googleapis.com/v1/documents';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log(`  PASS  ${label}`);
}

function fail(label, err) {
  failed++;
  console.log(`  FAIL  ${label}: ${err}`);
}

// --- Step 1: Read token.json ---
console.log('\n1. Reading token.json...');
let tokenData;
try {
  const raw = fs.readFileSync(TOKEN_PATH, 'utf8');
  tokenData = JSON.parse(raw);
  if (!tokenData.refresh_token) throw new Error('No refresh_token found');
  if (!tokenData.client_id) throw new Error('No client_id found');
  if (!tokenData.client_secret) throw new Error('No client_secret found');
  ok(`Token file parsed (client_id: ${tokenData.client_id.slice(0, 12)}...)`);
} catch (err) {
  fail('Read token.json', err.message);
  console.log('\nCannot continue without valid token.json.');
  process.exit(1);
}

// --- Step 2: Refresh access token ---
console.log('\n2. Refreshing access token...');
let accessToken;
try {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: tokenData.client_id,
      client_secret: tokenData.client_secret,
      refresh_token: tokenData.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  accessToken = data.access_token;
  if (!accessToken) throw new Error('No access_token in response');
  ok(`Got access token (expires_in: ${data.expires_in}s)`);
} catch (err) {
  fail('Refresh token', err.message);
  console.log('\nCannot continue without access token.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
};

// --- Step 3: Create test document ---
console.log('\n3. Creating test document...');
let docId;
try {
  const res = await fetch(DOCS_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: `Aether Test — ${new Date().toISOString()}` }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const doc = await res.json();
  docId = doc.documentId;
  ok(`Created doc: ${docId}`);
} catch (err) {
  fail('Create document', err.message);
  console.log('\nCannot continue without test document.');
  process.exit(1);
}

// --- Step 4: Append content (first append) ---
console.log('\n4. Appending first content...');
const firstContent = 'Hello from Aether!\n\nThis is the first paragraph.';
try {
  const getRes = await fetch(`${DOCS_API}/${docId}`, { headers });
  const getDoc = await getRes.json();
  const bodyContent = getDoc.body.content;
  const endIndex = bodyContent[bodyContent.length - 1].endIndex - 1;

  // First append — no separator needed (doc is empty)
  const updateRes = await fetch(`${DOCS_API}/${docId}:batchUpdate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requests: [{
        insertText: {
          location: { index: endIndex },
          text: firstContent + '\n',
        },
      }],
    }),
  });
  if (!updateRes.ok) {
    const text = await updateRes.text();
    throw new Error(`HTTP ${updateRes.status}: ${text}`);
  }
  ok('First content appended');
} catch (err) {
  fail('First append', err.message);
}

// --- Step 5: Append content (second append with separator) ---
console.log('\n5. Appending second content...');
const secondContent = 'This is the second paragraph, appended later.';
try {
  const getRes = await fetch(`${DOCS_API}/${docId}`, { headers });
  const getDoc = await getRes.json();
  const bodyContent = getDoc.body.content;
  const endIndex = bodyContent[bodyContent.length - 1].endIndex - 1;

  const textToInsert = '\n---\n\n' + secondContent + '\n';
  const updateRes = await fetch(`${DOCS_API}/${docId}:batchUpdate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requests: [{
        insertText: {
          location: { index: endIndex },
          text: textToInsert,
        },
      }],
    }),
  });
  if (!updateRes.ok) {
    const text = await updateRes.text();
    throw new Error(`HTTP ${updateRes.status}: ${text}`);
  }
  ok('Second content appended');
} catch (err) {
  fail('Second append', err.message);
}

// --- Step 6: Verify both sections present ---
console.log('\n6. Verifying accumulated content...');
try {
  const res = await fetch(`${DOCS_API}/${docId}`, { headers });
  const doc = await res.json();
  let docText = '';
  for (const el of doc.body.content) {
    if (el.paragraph) {
      for (const elem of el.paragraph.elements) {
        if (elem.textRun) {
          docText += elem.textRun.content;
        }
      }
    }
  }
  const hasFirst = docText.includes('first paragraph');
  const hasSecond = docText.includes('second paragraph');
  const hasSeparator = docText.includes('---');
  if (hasFirst && hasSecond && hasSeparator) {
    ok('Both sections present with separator');
  } else {
    fail('Content check', `first=${hasFirst}, second=${hasSecond}, separator=${hasSeparator}`);
    console.log('    Full text:', JSON.stringify(docText.slice(0, 200)));
  }
} catch (err) {
  fail('Verify content', err.message);
}

// --- Step 7: Delete test document ---
console.log('\n7. Cleaning up (deleting test document)...');
try {
  const res = await fetch(`${DRIVE_API}/${docId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.ok || res.status === 204) {
    ok('Test document deleted');
  } else if (res.status === 403) {
    // drive.readonly scope can't delete — this is expected
    ok('Delete skipped (drive.readonly scope — delete test doc manually)');
    console.log(`    Doc URL: https://docs.google.com/document/d/${docId}/edit`);
  } else {
    const text = await res.text();
    fail('Delete document', `HTTP ${res.status}: ${text}`);
  }
} catch (err) {
  fail('Delete document', err.message);
}

// --- Summary ---
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Some tests failed!');
  process.exit(1);
} else {
  console.log('All tests passed!');
}
