/**
 * Custom 404 page. Renders WITHOUT the root layout's providers during
 * prerender, so it must be self-contained with its own html/body.
 */
export default function NotFound() {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Page not found</h1>
        <p style={{ color: '#666', marginBottom: '1.5rem' }}>
          The page you requested doesn&apos;t exist.
        </p>
        <a href="/chat" style={{ color: '#2563eb', textDecoration: 'underline', fontSize: '0.875rem' }}>
          Go to chat
        </a>
      </body>
    </html>
  );
}
