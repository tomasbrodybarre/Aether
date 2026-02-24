/**
 * google-docs.ts — Lightweight Google Docs API client.
 *
 * Uses raw fetch() with OAuth2 token refresh from a local token.json file
 * (shared with the Python skills in C:/agent-hub/config/).
 * No npm dependencies required.
 */

import { readFileSync, existsSync } from 'fs';
import { getSetting } from './db';

const DOCS_API = 'https://docs.googleapis.com/v1/documents';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFAULT_TOKEN_PATH = 'C:/agent-hub/config/token.json';

interface TokenData {
  token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  expiry: string;
}

// Module-level cache for access token
let cachedAccessToken: string | null = null;
let cachedTokenExpiry: number = 0; // unix ms

function getTokenPath(): string {
  return getSetting('gdocs_token_path') || DEFAULT_TOKEN_PATH;
}

function readTokenFile(): TokenData | null {
  const tokenPath = getTokenPath();
  if (!existsSync(tokenPath)) return null;
  try {
    const raw = readFileSync(tokenPath, 'utf-8');
    return JSON.parse(raw) as TokenData;
  } catch {
    return null;
  }
}

/** Check if Google Docs integration is configured (token file exists with refresh_token). */
export function isGoogleDocsConfigured(): boolean {
  if (getSetting('gdocs_enabled') === 'false') return false;
  const tokenData = readTokenFile();
  return !!(tokenData?.refresh_token);
}

/**
 * Get a valid access token, refreshing if expired.
 * Returns null if not configured.
 */
export async function getAccessToken(): Promise<string | null> {
  // Check cache (refresh 60s before expiry)
  if (cachedAccessToken && Date.now() < cachedTokenExpiry - 60_000) {
    return cachedAccessToken;
  }

  const tokenData = readTokenFile();
  if (!tokenData?.refresh_token) return null;

  // Check if stored token is still valid
  if (tokenData.token && tokenData.expiry) {
    const expiry = new Date(tokenData.expiry).getTime();
    if (Date.now() < expiry - 60_000) {
      cachedAccessToken = tokenData.token;
      cachedTokenExpiry = expiry;
      return cachedAccessToken;
    }
  }

  // Refresh the token
  const body = new URLSearchParams({
    client_id: tokenData.client_id,
    client_secret: tokenData.client_secret,
    refresh_token: tokenData.refresh_token,
    grant_type: 'refresh_token',
  });

  const res = await fetch(tokenData.token_uri || TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  cachedTokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

/** Verify a document exists and is accessible. Returns its title. */
export async function verifyDocument(docId: string): Promise<{ title: string }> {
  const token = await getAccessToken();
  if (!token) throw new Error('Google Docs not configured');

  const res = await fetch(`${DOCS_API}/${docId}?fields=title`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to access document (${res.status}): ${text}`);
  }

  const doc = await res.json() as { title: string };
  return { title: doc.title };
}

/** Create a new Google Doc with the given title. Returns doc ID and title. */
export async function createDocument(title: string): Promise<{ id: string; title: string }> {
  const token = await getAccessToken();
  if (!token) throw new Error('Google Docs not configured');

  const res = await fetch(DOCS_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create document (${res.status}): ${text}`);
  }

  const doc = await res.json() as { documentId: string; title: string };
  return { id: doc.documentId, title: doc.title };
}

/**
 * Append content to the end of a Google Doc.
 * Adds a separator line, then the new content.
 * 1. GET doc to find body endIndex
 * 2. Insert content at the end (endIndex - 1)
 */
export async function appendToDocument(docId: string, content: string): Promise<void> {
  const token = await getAccessToken();
  if (!token) throw new Error('Google Docs not configured');

  // Step 1: Get current document to find end index
  const getRes = await fetch(`${DOCS_API}/${docId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!getRes.ok) {
    const text = await getRes.text();
    throw new Error(`Failed to read document (${getRes.status}): ${text}`);
  }

  const doc = await getRes.json() as {
    body: { content: Array<{ endIndex: number }> };
  };

  const bodyContent = doc.body.content;
  const endIndex = bodyContent[bodyContent.length - 1].endIndex - 1;

  // Step 2: Insert new content at the end, preceded by a separator
  const separator = endIndex > 1 ? '\n---\n\n' : '';
  const textToInsert = separator + content + '\n';

  const updateRes = await fetch(`${DOCS_API}/${docId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
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
    throw new Error(`Failed to update document (${updateRes.status}): ${text}`);
  }
}
