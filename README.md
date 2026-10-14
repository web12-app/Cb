# Cb

YouTube metadata API with a small web UI, published live by the GitHub Actions workflow
(`.github/workflows/blank.yml`) through the **Pips Tunnel**.

## How it is published

The workflow starts the Node server on port 3000 and exposes it on the Pips Tunnel:

- `GET /tun/<name>` — the public URL for this app. The `/tun/<name>` prefix is stripped before the
  request reaches the server, so `/api/health`, `/api/download` and the UI keep working unchanged.
- The tunnel client is installed with the one-line installer and runs next to the server while the job
  is alive; when the job ends the URL goes offline.

### Stable URL (optional)

Anonymous tunnels get a fresh random name on every run. To keep a stable name:

1. Create a tunnel account and copy the `tunt_…` token it prints (shown once):

   ```sh
   curl -X POST https://precision-pledge-fled.ngrok-free.dev/api/tunnel/account
   ```

2. Add it as the repository secret **`TUN_TOKEN`** (Settings → Secrets and variables → Actions).

With `TUN_TOKEN` set, the workflow logs in, claims the stable name `cb`, and the app is published at
`https://precision-pledge-fled.ngrok-free.dev/tun/cb`. Without the secret it still works — just with a
random name each run.

Full tunnel documentation: <https://precision-pledge-fled.ngrok-free.dev/docs/tunnel>

## API

- `GET /api/health` — service status.
- `POST /api/download` — `{"url":"https://youtu.be/…","quality":"…"}` returns video metadata (format
  information; media URLs are not exposed).
- `GET /yt?=<https://youtu.be/…>` — downloads the video with yt-dlp, merging video+audio (up to 4K),
  and streams it back as an attachment. Also accepts `?url=`, `?u=`, `?q=`, `?link=`, `?watch=` or
  `?v=<videoId>`. Streaming goes through the server, so it is bounded by the Pips Tunnel's ~18 MB
  response cap (`DOWNLOAD_MAX_BYTES`, default 16 MB) — large/4K videos exceed it. Override the
  selector with `?format=<yt-dlp format>` (e.g. `?format=160`).
- `GET /yt?=<url>&direct=1` — 302-redirects the browser straight to the CDN media URL (no server
  download). Add `&json=1` to get `{downloadUrl, audioUrl, filename}` instead: 4K YouTube video is
  always split, so the JSON carries the separate video and audio URLs. Handy when the server's IP is
  blocked by YouTube but the visitor's is not.
- Set `YTDLP_COOKIES` to a Netscape cookies file when YouTube shows a bot check.

## Run locally

```sh
npm install
npm start        # http://localhost:3000
```
