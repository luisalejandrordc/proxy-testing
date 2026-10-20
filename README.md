# Render Refresh-Cookie Rewrite Lab

A deliberately small React + TypeScript + Go project to verify this deployment pattern:

- React is served as a Render Static Site.
- Go is deployed separately as a Render Web Service.
- The frontend sends requests to relative paths such as `/api/auth/refresh`.
- Render rewrites `/api/*` to the public Go service URL without changing the browser-visible URL.
- The Go API issues an `HttpOnly` refresh cookie, and the browser sends it back through the same frontend URL.

This is a **cookie-routing proof of concept**, not production-ready authentication. The login credential is fixed, refresh sessions are held in memory, and the returned access token is a random demo string rather than a JWT.

## Fastest Render deployment (Blueprint)

1. Push this folder's contents to a Git repository. `render.yaml` is at the repository root.
2. In Render, choose **New → Blueprint** and connect the repository.
3. Render should create two services:
   - `refresh-cookie-rewrite-lab-20261020-api` (Go Web Service)
   - `refresh-cookie-rewrite-lab-20261020-web` (Static Site)
4. Open the API Web Service and copy its exact `onrender.com` URL.
5. Open the Static Site's **Redirects/Rewrites** (or Routes) settings. Confirm the API rewrite points to that exact URL:

   - **Source:** `/api/*`
   - **Destination:** `https://YOUR-ACTUAL-API-HOST.onrender.com/api/*`
   - **Action / Type:** `Rewrite`

   The Blueprint has a predictable suggested hostname, but Render may assign a different hostname if that slug is unavailable. If it does, replace the destination in `render.yaml` and/or the Static Site's route with the exact URL assigned to your API. The `routes` order matters: `/api/*` must come before `/*`.
6. Make sure the API service environment variable is `COOKIE_SECURE=true`. This is already in the Blueprint. It enables the `Secure` attribute for HTTPS deployment.
7. Wait for both deploys to finish, open the **Static Site URL** (not the API URL), and follow the test sequence below.

> Render static-site rewrites can target full public URLs and leave the browser URL unchanged. If a rewrite is updated only in the dashboard, keep the matching route in `render.yaml` in sync so later Blueprint syncs don't surprise you.

## Manual setup (if you don't want to use a Blueprint)

Deploy the backend and frontend as two services from the same repository.

### Go backend

- **New → Web Service**
- Root Directory: `backend`
- Runtime: Go (or auto-detected)
- Build Command: `go build -o server .`
- Start Command: `./server`
- Health Check Path: `/api/health`
- Environment Variable: `COOKIE_SECURE` = `true`
- Free instance is enough for this test.

After it deploys, copy its complete public URL, e.g. `https://your-api-name.onrender.com`.

### React frontend

- **New → Static Site**
- Root Directory: `frontend`
- Build Command: `npm install && npm run build`
- Publish Directory: `dist`

In its Redirects/Rewrites settings, create these rules in this order:

| Source | Destination | Action |
|---|---|---|
| `/api/*` | `https://YOUR-ACTUAL-API-HOST.onrender.com/api/*` | Rewrite |
| `/*` | `/index.html` | Rewrite |

Replace the example API hostname with your actual Go service hostname. The second rule is the React SPA fallback and must come after the API rule.

## Test sequence

Open the **frontend Static Site URL** and then:

1. Click **Check API**. Expect HTTP 200 with `"ok": true`.
2. Click **Demo login**. This posts the demo credentials to `/api/auth/login`. Expect HTTP 200.
3. Click **Check cookie**. Expect `refreshCookieReceived: true` and `refreshCookieValid: true`. This is the core test: Go received and validated the cookie after the browser made a same-origin request to the frontend path.
4. Click **Refresh session**. Expect `refreshTokenRotated: true`. The old refresh token is invalidated and a new cookie is sent.
5. Click **Logout**, then **Check cookie**. Expect HTTP 401 because the cookie is cleared.

Demo credentials:

- Username: `demo`
- Password: `password123`

## Inspect the browser cookie

In Chrome/Edge DevTools:

1. Open **Application → Storage → Cookies**.
2. Select the **frontend Static Site origin**.
3. After Demo login, inspect `refresh_token`. Expect:
   - **Domain/Host:** the frontend's `*.onrender.com` hostname, not the Go API hostname
   - **HttpOnly:** enabled
   - **Secure:** enabled on the deployed HTTPS service
   - **SameSite:** `Lax`
   - **Path:** `/api/auth`
   - **Domain attribute:** omitted (host-only cookie)
4. In the Network tab, select `/api/auth/login` and `/api/auth/check`. The request URLs should start with the frontend hostname and `/api/...`; they should not be requests directly to the Go hostname.
5. The refresh cookie should not appear in `document.cookie`. That is expected because it is HttpOnly. Use DevTools to inspect its attributes instead.

## Why it works

The browser sends the request to `https://YOUR-FRONTEND.onrender.com/api/auth/login`. Render proxies that request to the Go service. The browser processes the returned `Set-Cookie` against the request URL it knows—the frontend URL—so the cookie is not a third-party cookie. The next request to the same frontend `/api/auth/...` path carries the cookie, and Render forwards the request to Go.

This is different from calling `https://YOUR-API.onrender.com/api/auth/login` directly from the React code. Do not hardcode the backend hostname in `fetch`; this test app intentionally uses a relative API base: `/api`.

## Run locally

Requires Go 1.22+ and Node.js.

Terminal 1:

```bash
cd backend
COOKIE_SECURE=false go run .
```

Terminal 2:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api/*` to `http://localhost:8080`, giving local development the same browser-side URL pattern. `COOKIE_SECURE=false` is for plain-HTTP local development only; the Render Blueprint sets it to `true`.

## Troubleshooting

- **Frontend loads, but Check API returns 404:** check that `/api/*` is a Rewrite rule and its destination includes `/api/*` at the end.
- **Request returns the React HTML instead of JSON:** move `/api/*` above the `/* → /index.html` SPA fallback.
- **API service is waking up:** a free Render Web Service may take a while to wake after inactivity. Retry after it has started.
- **Login succeeds but cookie is absent:** verify `Set-Cookie` in the login response, check that `COOKIE_SECURE=true` only on HTTPS, then inspect the frontend origin under DevTools → Application → Cookies.
- **Cookie exists but Check cookie returns 401:** make sure the cookie Path is `/api/auth`, you are testing on the same frontend hostname, and you didn't open the API hostname directly. The demo session map is in memory and resets when the service restarts or spins down.

## Important limitations

- No database: demo sessions are lost when Go restarts or spins down.
- Fixed demo credentials and demo access tokens: never use this code for real user accounts.
- The refresh cookie is intentionally host-only and scoped to `/api/auth`.
- This project deliberately does not configure CORS, because the browser calls a same-origin `/api` URL. If you bypass the rewrite and call the API URL directly, this sample is not set up for browser CORS access.
- Render free Web Services can spin down when idle; the Static Site remains independently hosted.
