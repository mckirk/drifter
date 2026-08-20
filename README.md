# Drifter

Drifter is a small, static web app for playing the same downloaded audio file on
several devices at a shared wall-clock time. It can wait for a future start or
join a track already in progress. Pausing is local; rejoining seeks back to the
group's current position.

The audio file is read directly from the device and is never uploaded.

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

1. Create a Cloudflare Workers API token and find the account ID.
2. Add them to the GitHub repository as Actions secrets named
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. For production, replace `"*"` in
   `clock-worker/wrangler.jsonc`'s `ALLOWED_ORIGINS` with the site's origin, such
   as `https://example.github.io`. A repository-project path is not part of the
   origin.
4. Run the **Deploy optional custom clock** workflow. Copy the resulting Workers
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
- The start time and last-used file metadata are stored in `localStorage`.

Browsers do not allow a site to silently reopen a local file after a reload. To
rejoin after closing the page, select the same file again; Drifter restores the
start time and immediately seeks to the group's current point.

For best results, keep Drifter open after pressing **Go**, disable battery-saving
restrictions for the browser, and use the same encoded audio file on each device.
