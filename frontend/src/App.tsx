import { useMemo, useState } from 'react';

type RequestResult = {
  request: string;
  method: string;
  status: number | 'NETWORK ERROR';
  success: boolean;
  response: unknown;
  at: string;
};

type ApiResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
  refreshCookieReceived?: boolean;
  refreshCookieValid?: boolean;
  refreshTokenRotated?: boolean;
  cookieSecure?: boolean;
};

const API_BASE = '/api';

async function callApi(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 800) || '(empty response)', note: 'Response was not JSON.' };
  }

  return { response, data };
}

export default function App() {
  const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState<RequestResult | null>(null);
  const [history, setHistory] = useState<RequestResult[]>([]);
  const [notice, setNotice] = useState('Ready to test the rewrite. Start with “Check API”.');
  const [severity, setSeverity] = useState<'neutral' | 'success' | 'error'>('neutral');

  const currentOrigin = window.location.origin;
  const visibleCookies = useMemo(() => {
    const value = document.cookie;
    return value ? value.split(';').map((part) => part.trim()).join('\n') : '(none visible to JavaScript)';
  }, [latest]);

  async function runRequest(path: string, method = 'GET', body?: unknown) {
    setBusy(true);
    setSeverity('neutral');
    setNotice(`${method} ${API_BASE}${path}…`);
    const startedAt = new Date();
    let item: RequestResult;

    try {
      const { response, data } = await callApi(path, method, body);
      item = {
        request: `${currentOrigin}${API_BASE}${path}`,
        method,
        status: response.status,
        success: response.ok,
        response: data,
        at: startedAt.toLocaleTimeString(),
      };
      const apiData = data as ApiResponse | null;
      setSeverity(response.ok ? 'success' : 'error');
      setNotice(response.ok
        ? (apiData?.message ?? `Request completed with HTTP ${response.status}.`)
        : (apiData?.message ?? `Request failed with HTTP ${response.status}.`));
    } catch (error) {
      item = {
        request: `${currentOrigin}${API_BASE}${path}`,
        method,
        status: 'NETWORK ERROR',
        success: false,
        response: { message: error instanceof Error ? error.message : String(error) },
        at: startedAt.toLocaleTimeString(),
      };
      setSeverity('error');
      setNotice('The request could not reach the API. Check the rewrite rule, service URL, and backend logs.');
    } finally {
      setBusy(false);
    }

    setLatest(item);
    setHistory((items) => [item, ...items].slice(0, 8));
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Cookie test bench home">
          <span className="mark">↗</span>
          <span>ROUTE / COOKIE LAB</span>
        </a>
        <span className="tag"><span className="tag-dot" /> TEST ENVIRONMENT</span>
      </header>

      <section className="hero">
        <p className="eyebrow">RENDER STATIC SITE + GO WEB SERVICE</p>
        <h1>Is your refresh cookie<br /><em>really making the trip?</em></h1>
        <p className="intro">
          A focused test bench for one thing: calling a separate Go API through a Render rewrite,
          while keeping the browser on the frontend origin and using an HttpOnly refresh cookie.
        </p>
        <div className="origin-line">
          <span className="origin-label">BROWSER ORIGIN</span>
          <code>{currentOrigin}</code>
        </div>
      </section>

      <section className="status-strip" aria-live="polite">
        <span className={`status-indicator ${severity}`} />
        <div>
          <strong>{severity === 'success' ? 'Test response received' : severity === 'error' ? 'Test needs attention' : 'Standing by'}</strong>
          <p>{notice}</p>
        </div>
        <span className="status-path">API BASE <code>/api</code></span>
      </section>

      <div className="layout-grid">
        <section className="panel flow-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">01 / RUN THE FLOW</p>
              <h2>Cookie round-trip</h2>
            </div>
            <span className="step-count">4 ACTIONS</span>
          </div>

          <div className="action-list">
            <article className="action-row">
              <span className="action-number">01</span>
              <div className="action-copy">
                <h3>Check the API route</h3>
                <p>Confirms <code>/api/health</code> reaches the Go service through the rewrite.</p>
              </div>
              <button disabled={busy} onClick={() => void runRequest('/health')}>Check API <span>↗</span></button>
            </article>
            <article className="action-row">
              <span className="action-number">02</span>
              <div className="action-copy">
                <h3>Issue the refresh cookie</h3>
                <p>Signs in with a fixed demo account. The API responds with <code>Set-Cookie</code>.</p>
                <p className="credentials">Username <b>demo</b><i>·</i> Password <b>password123</b></p>
              </div>
              <button disabled={busy} onClick={() => void runRequest('/auth/login', 'POST', { username: 'demo', password: 'password123' })}>Demo login <span>↗</span></button>
            </article>
            <article className="action-row">
              <span className="action-number">03</span>
              <div className="action-copy">
                <h3>Check or rotate the cookie</h3>
                <p>Check confirms the browser sent it; refresh also rotates it and issues a demo access token.</p>
              </div>
              <div className="button-stack">
                <button className="secondary-button" disabled={busy} onClick={() => void runRequest('/auth/check')}>Check cookie</button>
                <button disabled={busy} onClick={() => void runRequest('/auth/refresh', 'POST')}>Refresh session <span>↻</span></button>
              </div>
            </article>
            <article className="action-row last-row">
              <span className="action-number">04</span>
              <div className="action-copy">
                <h3>Clear the session</h3>
                <p>Revokes this in-memory demo session and expires the cookie.</p>
              </div>
              <button className="danger-button" disabled={busy} onClick={() => void runRequest('/auth/logout', 'POST')}>Logout <span>×</span></button>
            </article>
          </div>
          <p className="test-warning"><strong>Test credentials only.</strong> This project uses an in-memory session store and is not production authentication.</p>
        </section>

        <aside className="side-column">
          <section className="panel route-panel">
            <p className="eyebrow">02 / EXPECTED ROUTE</p>
            <h2>One browser origin</h2>
            <div className="route-node browser-node">
              <span className="node-icon">◈</span>
              <div><strong>Browser</strong><code>{currentOrigin}</code></div>
            </div>
            <div className="route-arrow"><span /> <small>POST /api/auth/refresh</small></div>
            <div className="route-node proxy-node">
              <span className="node-icon">⇢</span>
              <div><strong>Render rewrite</strong><code>/api/* → Go API /api/*</code></div>
            </div>
            <div className="route-arrow"><span /> <small>Upstream request</small></div>
            <div className="route-node api-node">
              <span className="node-icon">⌘</span>
              <div><strong>Go API</strong><code>Separate Web Service</code></div>
            </div>
            <div className="route-footnote">The address bar should stay on the frontend host. The API hostname should not appear in the browser request URL.</div>
          </section>

          <section className="panel cookie-panel">
            <p className="eyebrow">03 / COOKIE CHECKLIST</p>
            <h2>What to verify</h2>
            <ul className="checklist">
              <li><span>✓</span><div><strong>Host</strong><p>Frontend's <code>onrender.com</code> domain</p></div></li>
              <li><span>✓</span><div><strong>HttpOnly</strong><p>Enabled; JavaScript cannot read the token</p></div></li>
              <li><span>✓</span><div><strong>Secure</strong><p>Enabled on the deployed HTTPS site</p></div></li>
              <li><span>✓</span><div><strong>SameSite</strong><p><code>Lax</code>; no third-party cookie needed</p></div></li>
              <li><span>✓</span><div><strong>Path</strong><p><code>/api/auth</code></p></div></li>
            </ul>
            <p className="devtools-note">Open DevTools → Application (Chrome) → Cookies and inspect the frontend origin after clicking Demo login.</p>
          </section>
        </aside>
      </div>

      <section className="panel response-panel">
        <div className="panel-heading response-heading">
          <div><p className="eyebrow">04 / INSPECT THE RESULT</p><h2>Latest response</h2></div>
          {latest && <span className={`http-badge ${latest.success ? 'ok' : 'bad'}`}>HTTP {latest.status}</span>}
        </div>
        {latest ? (
          <>
            <div className="request-meta"><span>{latest.method}</span><code>{latest.request}</code><time>{latest.at}</time></div>
            <pre className="json-view">{JSON.stringify(latest.response, null, 2)}</pre>
          </>
        ) : (
          <div className="empty-state"><span className="empty-icon">◌</span><p>No response yet. Click <strong>Check API</strong> to start the test.</p></div>
        )}
      </section>

      <section className="bottom-grid">
        <div className="panel small-panel">
          <p className="eyebrow">BROWSER VISIBILITY</p>
          <h3><span className="lock-icon">▣</span> JavaScript-readable cookies</h3>
          <pre className="cookie-readable">{visibleCookies}</pre>
          <p className="small-note">The refresh cookie should not appear here. Its HttpOnly flag prevents JavaScript access; verify the flag in DevTools as well.</p>
        </div>
        <div className="panel small-panel history-panel">
          <p className="eyebrow">RECENT REQUESTS</p>
          <h3>Run history <span className="history-count">{history.length}/8</span></h3>
          {history.length ? <ol className="history-list">{history.map((item, index) => (
            <li key={`${item.at}-${index}`}><span className={item.success ? 'history-dot success' : 'history-dot error'} /><span className="history-method">{item.method}</span><code>{item.request.replace(currentOrigin, '')}</code><span className="history-status">{item.status}</span></li>
          ))}</ol> : <p className="small-note">Your requests will appear here as you test.</p>}
          {history.length > 0 && <button className="text-button" onClick={() => { setHistory([]); setLatest(null); setSeverity('neutral'); setNotice('History cleared. Ready to test.'); }}>Clear history</button>}
        </div>
      </section>

      <footer><span>ROUTE / COOKIE LAB</span><span>Small test app · No database · No real user data</span></footer>
    </main>
  );
}
