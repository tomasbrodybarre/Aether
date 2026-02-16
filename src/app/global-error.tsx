'use client';

/**
 * Global error boundary for unhandled errors.
 * This component renders WITHOUT the root layout, so it must include
 * its own <html> and <body> tags and cannot depend on any providers.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Something went wrong</h1>
        <p style={{ color: '#666', marginBottom: '1.5rem' }}>
          An unexpected error occurred. You can try reloading the page.
        </p>
        {error.digest && (
          <p style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#999', marginBottom: '1rem' }}>
            Error ID: {error.digest}
          </p>
        )}
        <button
          onClick={reset}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '0.375rem',
            border: '1px solid #ccc',
            background: '#fff',
            cursor: 'pointer',
            fontSize: '0.875rem',
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
