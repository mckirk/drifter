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

1. Create a GitHub repository and push this project to its `main` branch.
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. The included `Deploy Drifter to GitHub Pages` workflow publishes the site on
   every push to `main`.

## Synchronization model

- Drifter samples the `Date` header from the site host and estimates the device
  clock offset using the request midpoint. If this is unavailable, it visibly
  falls back to the device clock.
- Playback position is derived from `server-adjusted now − shared start time`.
- Small deviations are corrected with a temporary 0.98×/1.02× playback rate;
  larger deviations trigger a seek.
- The start time and last-used file metadata are stored in `localStorage`.

Browsers do not allow a site to silently reopen a local file after a reload. To
rejoin after closing the page, select the same file again; Drifter restores the
start time and immediately seeks to the group's current point.

For best results, keep Drifter open after pressing **Go**, disable battery-saving
restrictions for the browser, and use the same encoded audio file on each device.
