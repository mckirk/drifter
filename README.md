# Drifter

Drifter is a small, static web app for playing the same downloaded audio file on
several devices at a shared wall-clock time. It can wait for a future start or
join a track already in progress. Pausing is local; rejoining seeks back to the
group's current position.

The audio file is read directly from the device and is never uploaded.

Each selected file is also fingerprinted locally with SHA-256. A shareable
preset link or QR code contains only that fingerprint and an ISO-formatted UTC
start time. Opening a preset fills in the correct local time and verifies the
chosen file before playback, which helps catch similarly named or differently
encoded tracks.

## Run locally

The app uses ES modules, so serve it over HTTP rather than opening `index.html`
as a `file://` URL:

```sh
python3 -m http.server 8080
```

Then open <http://localhost:8080>. Run the dependency-free checks with:

```sh
npm test
npm run check
```

### Local end-to-end test

The Playwright tests start their own static server and exercise sharing in both
directions between desktop and mobile-sized contexts in different time zones.
The mobile file-picker path also runs in Firefox and verifies that tapping the
visible file card opens the native picker before selecting the generated WAV.

Install the Chromium and Firefox test browsers once, then run the tests:

```sh
npx playwright install chromium firefox
npm run test:e2e
```

Use `npm run test:e2e:headed` to watch both device contexts locally. The public
clock and stylesheet CDN are intercepted so this scenario does not require
internet access while it runs.

## Deploy to GitHub Pages

1. Create a GitHub repository and push this project to its default branch
   (`main` and `master` are both configured).
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. The included `Deploy Drifter to GitHub Pages` workflow publishes the site on
   every push to the configured default branch.

No separate clock deployment is required. By default, Drifter samples
TimeAPI.io's public HTTPS clock. Requests contain no cookies, referrer, audio,
filename, start time, or session data; as with any internet request, the service
can observe ordinary connection metadata such as the device's IP address.

## Optional custom clock

GitHub Pages is a static host and its HTTP `Date` header only has one-second
precision. If relying on a public time service is undesirable, Drifter includes
a small Cloudflare Worker that only returns millisecond timestamps:

### Cloudflare token permissions

Create a **custom API token** in Cloudflare under **My Profile → API Tokens →
Create Token → Create Custom Token**. Do not use the Global API Key.

For the included `workers.dev` configuration, give the token only these account
permissions:

| Scope | Resource | Access | Why |
| --- | --- | --- | --- |
| Account | Workers Scripts | Edit | Upload and replace the `drifter-clock` Worker |
| Account | Account Settings | Read | Let Wrangler identify and validate the target account and its Workers setup |

Under **Account Resources**, choose **Include → Specific account** and select
only the account that will own this Worker. Do not select all accounts.

No zone permission is required because `clock-worker/wrangler.jsonc` deploys to
the account's `workers.dev` subdomain and defines no zone route. In particular,
Drifter does **not** need access to DNS, Workers Routes, KV, R2, D1, Pages,
Workers Tail, Secrets Store, billing, or other account resources.

The token is account-scoped, not Worker-scoped: `Workers Scripts: Edit` can
modify Worker scripts in the selected account. For stronger isolation, deploy
Drifter from a dedicated Cloudflare account. An optional token expiry is useful
if you also have a process for rotating the corresponding GitHub secret.

If you later change the Worker to use a route or custom domain, add **Zone →
Workers Routes → Edit** and restrict **Zone Resources** to that single zone.
That permission is not needed for the supplied `workers.dev` setup.

Cloudflare's **Edit Cloudflare Workers** token template is a compatible fallback
if a future Wrangler release rejects the minimal token. Restrict it to the same
single account and review it before creation: the template currently includes
broader KV, R2, Tail, user, and zone-route permissions that this project does
not use. See Cloudflare's documentation for
[GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
and the current
[API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/).

### Deployment steps

1. Copy the token when Cloudflare displays it; it is shown only once. Find the
   target account's **Account ID** in the Cloudflare dashboard.
2. In GitHub, open **Settings → Secrets and variables → Actions** and add:
   - Secret `CLOUDFLARE_API_TOKEN`: the token value. Treat this as a password.
   - Secret `CLOUDFLARE_ACCOUNT_ID`: the ID of the specifically scoped account.
     The ID is not an authentication credential, but the workflow reads it from
     GitHub Secrets for consistent configuration.
3. For production, replace `"*"` in
   `clock-worker/wrangler.jsonc`'s `ALLOWED_ORIGINS` with the site's origin, such
   as `https://example.github.io`. A repository-project path is not part of the
   origin.
4. Run **Actions → Deploy optional custom clock → Run workflow**. Copy the Workers
   URL and append `/time`, for example
   `https://drifter-clock.example.workers.dev/time`.
5. Add that complete URL as a GitHub Actions repository variable named
   `DRIFTER_CLOCK_URL`, then rerun the Pages deployment.

For local development, put the same endpoint into `runtime-config.js`. A custom
endpoint takes precedence; if it fails, Drifter automatically tries the public
clock next.

## Synchronization model

- Drifter makes seven timestamp exchanges with the clock, using the first
  successful request to warm up the connection.
- Each exchange uses the four NTP timestamps to calculate network delay and
  clock offset. Drifter selects the sample with the lowest round-trip delay and
  displays its estimated uncertainty.
- The public clock refreshes every five minutes and whenever the clock is stale
  as a session starts or a hidden page becomes visible. A configured custom
  clock refreshes every minute.
- The goal is less than 100 ms uncertainty. Whether a particular device meets
  it is visible in the UI and depends mainly on its network latency and path
  symmetry; it is a target, not a hard real-time guarantee.
- The fallback chain is: custom clock (when configured), public HTTPS clock,
  recently measured precise result, host's second-resolution `Date` header,
  then the device clock.
- Playback position is derived from `server-adjusted now − shared start time`.
- Small deviations are corrected with a temporary 0.98×/1.02× playback rate;
  deviations of 100 ms or more trigger a seek.
- Live sync can be switched off during playback when automatic speed changes or
  seeks are undesirable. In manual mode, **Sync now** seeks to the current shared
  position without re-enabling live sync.
- The start time, live-sync preference, and last-used file metadata are stored in
  `localStorage`.
- SHA-256 calculation and QR generation happen entirely in the browser. Preset
  URLs contain no filename, audio content, or clock-service data.

Browsers do not allow a site to silently reopen a local file after a reload. To
rejoin after closing the page, select the same file again; Drifter restores the
start time and immediately seeks to the group's current point.

For best results, keep Drifter open after pressing **Go**, disable battery-saving
restrictions for the browser, and use the same encoded audio file on each device.
