"use strict";

const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const app = express();
const PORT = process.env.PORT || 3000;

// DEBUG_ERRORS=1 exposes raw yt-dlp stderr + exit code in the API response.
// Leave unset in production: this endpoint is public.
const DEBUG_ERRORS =
  ["1", "true", "yes"].includes(String(process.env.DEBUG_ERRORS || "").toLowerCase());

const MAX_STDERR = 64 * 1024;
const MAX_STDOUT = 5 * 1024 * 1024;
const YTDLP_TIMEOUT_MS = 60000;

// GET /yt downloads the video on the server and streams it back, so the body has
// to fit through the Pips Tunnel's 25 MB respond cap (~18 MB of bytes). Keep the
// default small; override the selector with ?format=<yt-dlp selector>.
const DOWNLOAD_TIMEOUT_MS =
  Number(process.env.YTDLP_DOWNLOAD_TIMEOUT_MS) > 0
    ? Number(process.env.YTDLP_DOWNLOAD_TIMEOUT_MS)
    : 300000;
const DOWNLOAD_MAX_BYTES =
  Number(process.env.DOWNLOAD_MAX_BYTES) > 0
    ? Number(process.env.DOWNLOAD_MAX_BYTES)
    : 16 * 1024 * 1024;
const DEFAULT_DOWNLOAD_FORMAT =
  process.env.DOWNLOAD_FORMAT ||
  "bv*[height<=2160]+ba/b[height<=2160]/bv*+ba/b";
// For ?direct=1 we only need URL(s): prefer a single muxed file, otherwise
// resolve the best video+audio pair (up to 4K).
const DIRECT_DOWNLOAD_FORMAT =
  process.env.DIRECT_DOWNLOAD_FORMAT ||
  "b[height<=2160]/bv*[height<=2160]+ba/bv*+ba/b";

// ---------------------------------------------------------------------------
// Structured JSON logger -> stdout (the workflow captures this in server.log)
// ---------------------------------------------------------------------------
function log(level, event, fields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields
  });

  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

function newRequestId() {
  return crypto.randomBytes(4).toString("hex");
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------
const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "music.youtube.com"
]);

function validYouTubeUrl(value) {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:") return false;

    return ALLOWED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// yt-dlp error classification.
// Order matters: first match wins, so specific reasons precede generic ones.
// ---------------------------------------------------------------------------
const ERROR_PATTERNS = [
  {
    reason: "private_video",
    re: /Private video/i,
    error: "This video is private.",
    hint: "Only the owner's authorized accounts can access it.",
    retryable: false
  },
  {
    reason: "members_only",
    re: /members-only|Join this channel to get access/i,
    error: "This video is channel-members only.",
    hint: "Requires an active paid membership on the channel.",
    retryable: false
  },
  {
    reason: "age_restricted",
    re: /confirm your age|age-restricted|age restricted/i,
    error: "This video is age-restricted.",
    hint: "YouTube requires an age-verified sign-in this server does not have.",
    retryable: false
  },
  {
    reason: "geo_blocked",
    re: /not available in your country|uploader has not made this video available|not available in this country/i,
    error: "This video is not available in the server's region.",
    hint: "The uploader restricted it geographically; the runner's IP is blocked.",
    retryable: false
  },
  {
    reason: "copyright_removed",
    re: /copyright claim|copyright strike|account has been terminated/i,
    error: "This video was removed for copyright.",
    hint: "It no longer exists on YouTube.",
    retryable: false
  },
  {
    reason: "bot_check",
    re: /confirm you'?re not a bot|not a bot|bot detection|please sign in to continue/i,
    error: "YouTube is blocking this server as automated traffic.",
    hint: "Datacenter IPs get challenged. Retry later, or run yt-dlp locally.",
    retryable: true
  },
  {
    reason: "rate_limited",
    re: /HTTP Error 429|Too Many Requests|rate limit/i,
    error: "YouTube rate-limited this server.",
    hint: "Too many requests from this IP. Wait a few minutes and retry.",
    retryable: true
  },
  {
    reason: "live_premiere",
    re: /Premieres in|scheduled|is currently live|live stream recording is not available/i,
    error: "This video is a live stream, premiere, or unreleased broadcast.",
    hint: "There is no finished VOD to read metadata from yet.",
    retryable: true
  },
  {
    reason: "not_found",
    re: /Video unavailable|Video not found|no longer available|This video is not available|404/i,
    error: "This video does not exist or has been deleted.",
    hint: "Check the URL and the video ID.",
    retryable: false
  },
  {
    reason: "network",
    re: /getaddrinfo|Temporary failure in name resolution|Network is unreachable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Unable to download webpage|Remote end closed connection/i,
    error: "The server could not reach YouTube.",
    hint: "Transient DNS or network failure. Usually resolves on retry.",
    retryable: true
  },
  {
    reason: "yt_dlp_outdated",
    re: /nsig|Unable to extract.*(signature|initial data|player)|Incomplete data received|Extractors? .* failed|Unsupported URL scheme/i,
    error: "yt-dlp could not parse YouTube's response.",
    hint: "YouTube changed something server-side; yt-dlp needs updating.",
    retryable: false
  },
  {
    reason: "download_blocked",
    re: /unable to download video data|HTTP Error 403|403: Forbidden|Sign in to confirm/i,
    error: "YouTube refused to serve the media (403).",
    hint: "The server's IP is flagged for media downloads. Retry later, use cookies, or run yt-dlp locally.",
    retryable: true
  },
  {
    reason: "format_unavailable",
    re: /Requested format is not available|No video formats found/i,
    error: "No downloadable format matched the selector.",
    hint: "Try a different ?format= selector, or omit it.",
    retryable: false
  },
  {
    reason: "unsupported_url",
    re: /is not a valid URL|Unsupported URL|No video ID found/i,
    error: "That is not a valid single-video YouTube URL.",
    hint: "Pass a watch?v=, youtu.be/, or /shorts/ link.",
    retryable: false
  }
];

function classifyYtDlpError(stderr, exitCode) {
  const text = stderr || "";

  for (const pattern of ERROR_PATTERNS) {
    if (pattern.re.test(text)) {
      return { ...pattern, exitCode };
    }
  }

  if (exitCode === 0) {
    return {
      reason: "unknown",
      error: "yt-dlp exited successfully but produced no usable metadata.",
      hint: "Unexpected empty result.",
      retryable: true,
      exitCode
    };
  }

  return {
    reason: "unclassified",
    error: `yt-dlp failed (exit code ${exitCode}).`,
    hint: "No known error pattern matched. Check the server log for raw stderr.",
    retryable: true,
    exitCode
  };
}

/** Pull the most informative ERROR line out of yt-dlp's stderr. */
function extractDetail(stderr) {
  if (!stderr) return null;

  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const errorLine = lines.reverse().find((l) => /^ERROR:/i.test(l));

  return (errorLine || lines[lines.length - 1] || "").slice(0, 500) || null;
}

/** Best-effort video id, used for the download filename. */
function youtubeIdFromUrl(value) {
  try {
    const url = new URL(value);

    if (url.hostname.toLowerCase() === "youtu.be") {
      return url.pathname.replace(/^\/+/, "").split("/")[0] || "";
    }

    return url.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

// The /yt download endpoint takes the video URL from the query string in
// several shapes, including the bare "?=<url>" form used in shared links:
//   /yt?=<https://youtu.be/ID?si=...>
//   /yt?url=<https://www.youtube.com/watch?v=ID>
//   /yt?v=ID
function youtubeUrlFromQuery(req) {
  let params;

  try {
    params = new URL(req.originalUrl, "http://localhost").searchParams;
  } catch {
    return null;
  }

  for (const key of ["", "url", "u", "q", "link", "watch", "video"]) {
    const value = params.get(key);

    if (value && value.trim()) return value.trim();
  }

  const id = params.get("v");

  if (id && /^[A-Za-z0-9_-]{6,20}$/.test(id)) {
    return `https://www.youtube.com/watch?v=${id}`;
  }

  return null;
}

// Resolve the direct media URL(s) with `yt-dlp -g` (no download). Used by
// ?direct=1 so the visitor's own browser can fetch the file from the CDN.
function resolveDirectUrls(videoUrl, format) {
  return new Promise((resolve, reject) => {
    const args = ["--no-warnings", "--no-playlist", "-g", "-f", format];

    if (process.env.YTDLP_COOKIES) {
      args.push("--cookies", process.env.YTDLP_COOKIES);
    }

    args.push("--", videoUrl);

    let child;

    try {
      child = spawn("yt-dlp", args, {
        shell: false,
        timeout: YTDLP_TIMEOUT_MS,
        killSignal: "SIGKILL"
      });
    } catch (error) {
      return reject(error);
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        const error = new Error("yt-dlp could not resolve a download URL.");
        error.stderr = stderr;
        error.exitCode = code;
        return reject(error);
      }

      return resolve(
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendError(res, requestId, status, payload) {
  const body = {
    success: false,
    requestId,
    error: payload.error,
    reason: payload.reason,
    hint: payload.hint || null,
    retryable: payload.retryable === true
  };

  if (DEBUG_ERRORS && payload.debug) {
    body.debug = payload.debug;
  }

  return res.status(status).json(body);
}

// ---------------------------------------------------------------------------
// Rate limiting.
// This endpoint forks a subprocess per request. Without a limit, a few
// parallel curls will exhaust the container's CPU/memory.
// In-memory fixed window; single-process only. If you scale to >1 replica,
// swap this for a shared store (Redis / Upstash).
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_MAX || 10);
const buckets = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || "unknown";
  let bucket = buckets.get(key);

  if (!bucket || now - bucket.start >= RATE_LIMIT_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    buckets.set(key, bucket);
  }

  bucket.count += 1;

  const remaining = Math.max(0, RATE_LIMIT_MAX - bucket.count);
  const resetSeconds = Math.ceil((bucket.start + RATE_LIMIT_WINDOW_MS - now) / 1000);

  res.setHeader("RateLimit-Limit", RATE_LIMIT_MAX);
  res.setHeader("RateLimit-Remaining", remaining);
  res.setHeader("RateLimit-Reset", resetSeconds);

  if (bucket.count > RATE_LIMIT_MAX) {
    res.setHeader("Retry-After", resetSeconds);

    log("warn", "rate_limit.exceeded", {
      requestId: req.id,
      ip: key,
      count: bucket.count,
      windowMs: RATE_LIMIT_WINDOW_MS
    });

    return sendError(res, req.id, 429, {
      reason: "client_rate_limited",
      error: `Rate limit exceeded: ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s.`,
      hint: `Wait ${resetSeconds}s and retry.`,
      retryable: true
    });
  }

  next();
}

// Opportunistic cleanup so the bucket map cannot grow without bound.
setInterval(() => {
  const now = Date.now();

  for (const [key, bucket] of buckets) {
    if (now - bucket.start >= RATE_LIMIT_WINDOW_MS * 2) buckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
// Trust the first proxy hop so req.ip is the real client behind Render/Fly/
// Cloudflare rather than the load balancer address. Safe because the app is
// always deployed behind exactly one proxy.
app.set("trust proxy", 1);

app.use((req, res, next) => {
  req.id = newRequestId();
  next();
});

app.use(express.json({ limit: "10kb" }));
app.use(express.static("public"));

// NOTE: deliberately NOT applied to /api/health. Platform liveness probes
// (Docker HEALTHCHECK, Render, Fly) poll every ~30s; rate limiting them would
// consume a user's budget and can get the app marked unhealthy. Health does no
// work, so it is safe to leave unlimited.

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "Cb YouTube API",
    status: "online",
    debugErrors: DEBUG_ERRORS,
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.post("/api/download", rateLimit, (req, res) => {
  const requestId = req.id;
  const started = Date.now();
  const videoUrl = req.body?.url;

  log("info", "request.start", {
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip
  });

  if (typeof videoUrl !== "string" || !validYouTubeUrl(videoUrl)) {
    log("warn", "request.rejected.invalid_url", {
      requestId,
      received: typeof videoUrl,
      sample: String(videoUrl).slice(0, 120)
    });

    return sendError(res, requestId, 400, {
      reason: "invalid_url",
      error: "A valid HTTPS YouTube URL is required.",
      hint: "Expected https://www.youtube.com/watch?v=..., https://youtu.be/..., or https://music.youtube.com/...",
      retryable: false
    });
  }

  let child;

  try {
    // No shell, "--" separator: the URL can never be interpreted as a command
    // or as a yt-dlp flag.
    child = spawn(
      "yt-dlp",
      [
        "--dump-single-json",
        "--no-warnings",
        "--no-playlist",
        "--skip-download",
        "--",
        videoUrl
      ],
      { shell: false, timeout: YTDLP_TIMEOUT_MS, killSignal: "SIGKILL" }
    );
  } catch (error) {
    log("error", "yt_dlp.spawn_failed", { requestId, message: error.message });

    return sendError(res, requestId, 500, {
      reason: "spawn_failed",
      error: "The server could not start yt-dlp.",
      hint: "See server log.",
      retryable: false,
      debug: { message: error.message }
    });
  }

  let stdout = "";
  let stderr = "";
  let stderrTruncated = false;
  let stdoutOverflow = false;
  let finished = false;

  const respond = (status, payload) => {
    if (finished || res.headersSent) return;
    finished = true;
    clearTimeout(timer);

    log(status >= 500 ? "error" : "warn", "request.end", {
      requestId,
      status,
      reason: payload.reason,
      ms: Date.now() - started
    });

    sendError(res, requestId, status, payload);
  };

  const timer = setTimeout(() => {
    log("error", "yt_dlp.timeout", { requestId, ms: YTDLP_TIMEOUT_MS });
    child.kill("SIGKILL");

    respond(504, {
      reason: "timeout",
      error: `yt-dlp did not respond within ${YTDLP_TIMEOUT_MS / 1000}s.`,
      hint: "YouTube is slow or unreachable from this host. Retry once.",
      retryable: true,
      debug: { stderr: stderr.slice(0, MAX_STDERR), stderrTruncated }
    });
  }, YTDLP_TIMEOUT_MS + 1000);

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();

    if (stdout.length > MAX_STDOUT) {
      stdoutOverflow = true;
      stdout = stdout.slice(0, MAX_STDOUT);
      child.kill("SIGKILL");
    }
  });

  child.stderr.on("data", (chunk) => {
    if (stderr.length >= MAX_STDERR) {
      stderrTruncated = true;
      return;
    }

    stderr += chunk.toString();

    if (stderr.length > MAX_STDERR) {
      stderr = stderr.slice(0, MAX_STDERR);
      stderrTruncated = true;
    }
  });

  child.on("error", (error) => {
    if (error.code === "ENOENT") {
      log("error", "yt_dlp.missing", { requestId });

      return respond(503, {
        reason: "yt_dlp_missing",
        error: "yt-dlp is not installed on the server.",
        hint: "The deploy step that installs yt-dlp did not run or failed.",
        retryable: false,
        debug: { message: error.message, code: error.code }
      });
    }

    log("error", "yt_dlp.process_error", {
      requestId,
      message: error.message,
      code: error.code
    });

    respond(500, {
      reason: "process_error",
      error: "Unable to run the video metadata provider.",
      hint: "See server log.",
      retryable: false,
      debug: { message: error.message, code: error.code }
    });
  });

  child.on("close", (code, signal) => {
    const detail = extractDetail(stderr);

    if (stdoutOverflow) {
      log("error", "yt_dlp.stdout_overflow", { requestId, bytes: MAX_STDOUT });

      return respond(502, {
        reason: "response_too_large",
        error: "The metadata response was too large to process.",
        hint: "Try a shorter or less complex video.",
        retryable: false,
        debug: { bytes: MAX_STDOUT }
      });
    }

    if (code !== 0) {
      const classified = classifyYtDlpError(stderr, code);

      // Always log the full raw stderr server-side, regardless of DEBUG_ERRORS.
      log("error", "yt_dlp.failed", {
        requestId,
        exitCode: code,
        signal,
        reason: classified.reason,
        url: videoUrl,
        stderrTruncated,
        stderr: stderr.slice(0, MAX_STDERR)
      });

      return respond(classified.reason === "rate_limited" ? 429 : 502, {
        ...classified,
        error: detail ? `${classified.error}` : classified.error,
        debug: {
          exitCode: code,
          signal,
          detail,
          stderr: stderr.slice(0, MAX_STDERR),
          stderrTruncated
        }
      });
    }

    let info;

    try {
      info = JSON.parse(stdout);
    } catch (error) {
      log("error", "yt_dlp.bad_json", {
        requestId,
        message: error.message,
        stdoutHead: stdout.slice(0, 300)
      });

      return respond(502, {
        reason: "invalid_metadata",
        error: "yt-dlp returned unparseable output.",
        hint: "Likely an yt-dlp version mismatch.",
        retryable: false,
        debug: { message: error.message, stdoutHead: stdout.slice(0, 500) }
      });
    }

    const formats = (info.formats || [])
      .filter((format) => format.url && format.vcodec !== "none")
      .map((format) => ({
        format_id: format.format_id,
        ext: format.ext,
        height: format.height || null,
        filesize: format.filesize || format.filesize_approx || null,
        note: format.note || format.format_note || null
      }));

    log("info", "request.ok", {
      requestId,
      ms: Date.now() - started,
      formats: formats.length,
      videoId: info.id || null
    });

    if (finished || res.headersSent) return;
    finished = true;
    clearTimeout(timer);

    return res.json({
      success: true,
      requestId,
      title: info.title,
      thumbnail: info.thumbnail || null,
      duration: info.duration || null,
      webpage_url: info.webpage_url,
      uploader: info.uploader || info.channel || null,
      formats,
      message: "Format information retrieved. Media URLs are not exposed by this API."
    });
  });
});

// ---------------------------------------------------------------------------
// GET /yt — direct video download.
// Takes the video URL from the query string (see youtubeUrlFromQuery) and
// streams the best compact progressive format back as an attachment. The default
// format stays small so the body fits through the Pips Tunnel; override the
// selector with ?format=<yt-dlp format>.
// ---------------------------------------------------------------------------
app.get("/yt", rateLimit, async (req, res) => {
  const requestId = req.id || newRequestId();
  const started = Date.now();
  const videoUrl = youtubeUrlFromQuery(req);

  log("info", "yt.start", { requestId, ip: req.ip, url: videoUrl || null });

  if (!videoUrl || !validYouTubeUrl(videoUrl)) {
    log("warn", "yt.invalid_url", { requestId, sample: String(videoUrl).slice(0, 120) });

    return sendError(res, requestId, 400, {
      reason: "invalid_url",
      error: "A valid HTTPS YouTube URL is required.",
      hint: "Use /yt?=<https://youtu.be/...> or /yt?url=<https://youtube.com/watch?v=...>.",
      retryable: false
    });
  }

  const requestedFormat = String(req.query.format || "").trim();
  const wantDirect = ["1", "true", "yes"].includes(
    String(req.query.direct || "").toLowerCase()
  );

  // ?direct=1: don't download on the server — resolve the CDN URL and redirect
  // the visitor's browser to it. Useful when the server's IP is blocked by
  // YouTube but the visitor's is not.
  if (wantDirect) {
    try {
      const urls = await resolveDirectUrls(
        videoUrl,
        requestedFormat || DIRECT_DOWNLOAD_FORMAT
      );

      if (!urls.length) {
        return sendError(res, requestId, 502, {
          reason: "no_output",
          error: "The downloader returned no media URL.",
          hint: "Try a different ?format= selector.",
          retryable: true
        });
      }

      const directFilename = `youtube-${youtubeIdFromUrl(videoUrl) || "video"}.mp4`;
      const wantJson = ["1", "true", "yes"].includes(
        String(req.query.json || "").toLowerCase()
      );

      log("info", "yt.direct", {
        requestId,
        ms: Date.now() - started,
        urls: urls.length,
        json: wantJson
      });

      if (wantJson) {
        return res.json({
          success: true,
          requestId,
          downloadUrl: urls[0],
          audioUrl: urls[1] || null,
          filename: directFilename,
          urls
        });
      }

      res.setHeader("Cache-Control", "no-store");
      return res.redirect(302, urls[0]);
    } catch (error) {
      const stderr = error.stderr || "";
      const classified = classifyYtDlpError(stderr, error.exitCode ?? 1);

      log("error", "yt.direct_failed", {
        requestId,
        exitCode: error.exitCode,
        reason: classified.reason,
        url: videoUrl,
        stderr: stderr.slice(0, MAX_STDERR)
      });

      return sendError(res, requestId, 502, {
        ...classified,
        debug: { detail: extractDetail(stderr) }
      });
    }
  }

  const format = requestedFormat || DEFAULT_DOWNLOAD_FORMAT;
  const filename = `youtube-${youtubeIdFromUrl(videoUrl) || "video"}.mp4`;
  const capMb = Math.max(1, Math.round(DOWNLOAD_MAX_BYTES / (1024 * 1024)));

  let tmpDir;

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-yt-"));
  } catch (error) {
    log("error", "yt.tmpdir_failed", { requestId, message: error.message });

    return sendError(res, requestId, 500, {
      reason: "internal_error",
      error: "The server could not prepare a download.",
      hint: "See server log.",
      retryable: true
    });
  }

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  const args = [
    "--no-warnings",
    "--no-playlist",
    "--no-progress",
    "--max-filesize",
    String(DOWNLOAD_MAX_BYTES),
    "--merge-output-format",
    "mp4",
    "-f",
    format,
    "-o",
    path.join(tmpDir, "media.%(ext)s")
  ];

  // Optional: a Netscape cookies file helps when YouTube shows a bot check.
  if (process.env.YTDLP_COOKIES) {
    args.push("--cookies", process.env.YTDLP_COOKIES);
  }

  args.push("--", videoUrl);

  let child;

  try {
    child = spawn("yt-dlp", args, {
      shell: false,
      timeout: DOWNLOAD_TIMEOUT_MS,
      killSignal: "SIGKILL"
    });
  } catch (error) {
    cleanup();
    log("error", "yt.spawn_failed", { requestId, message: error.message });

    return sendError(res, requestId, 500, {
      reason: "spawn_failed",
      error: "The server could not start yt-dlp.",
      hint: "See server log.",
      retryable: false
    });
  }

  let stderr = "";
  let finished = false;
  let timer;

  const stop = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };

  const fail = (status, payload) => {
    cleanup();

    if (!res.headersSent) return sendError(res, requestId, status, payload);
    if (!res.writableEnded) res.end();
    return undefined;
  };

  timer = setTimeout(() => {
    log("error", "yt.timeout", { requestId, ms: DOWNLOAD_TIMEOUT_MS });
    stop();
    fail(504, {
      reason: "timeout",
      error: `The download did not finish within ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s.`,
      hint: "Try a smaller format with ?format=, or retry.",
      retryable: true
    });
  }, DOWNLOAD_TIMEOUT_MS + 1000);

  res.on("close", () => {
    if (!res.writableEnded) stop();
  });

  child.stderr.on("data", (chunk) => {
    if (stderr.length < MAX_STDERR) stderr += chunk.toString();
  });

  child.on("error", (error) => {
    log("error", "yt.process_error", { requestId, message: error.message, code: error.code });
    stop();

    const missing = error.code === "ENOENT";

    fail(missing ? 503 : 500, {
      reason: missing ? "yt_dlp_missing" : "process_error",
      error: missing ? "yt-dlp is not installed on the server." : "Unable to run the downloader.",
      hint: missing
        ? "The deploy step that installs yt-dlp did not run or failed."
        : "See server log.",
      retryable: false
    });
  });

  child.on("close", (code, signal) => {
    clearTimeout(timer);
    finished = true;

    if (code !== 0) {
      const classified = classifyYtDlpError(stderr, code);

      log("error", "yt.failed", {
        requestId,
        exitCode: code,
        signal,
        reason: classified.reason,
        url: videoUrl,
        stderr: stderr.slice(0, MAX_STDERR)
      });

      const hint =
        classified.reason === "format_unavailable"
          ? `No format fit the ${capMb} MB cap. Try a smaller ?format= (for example ?format=160).`
          : classified.hint;

      return fail(502, {
        ...classified,
        hint,
        debug: { exitCode: code, signal, detail: extractDetail(stderr) }
      });
    }

    let file = null;

    try {
      file = fs
        .readdirSync(tmpDir)
        .map((name) => path.join(tmpDir, name))
        .find((candidate) => fs.statSync(candidate).isFile());
    } catch {
      file = null;
    }

    if (!file) {
      log("error", "yt.no_output", { requestId });

      return fail(502, {
        reason: "no_output",
        error: "The downloader produced no file.",
        hint: "Try a different ?format= selector.",
        retryable: true
      });
    }

    let size = 0;

    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }

    if (size > DOWNLOAD_MAX_BYTES) {
      log("warn", "yt.too_large", { requestId, size });

      return fail(502, {
        reason: "response_too_large",
        error: "The video is larger than the download cap.",
        hint: `The cap is ${capMb} MB (the tunnel's respond limit); pick a smaller ?format=.`,
        retryable: false
      });
    }

    log("info", "yt.end", { requestId, status: 200, bytes: size, ms: Date.now() - started });

    res.status(200);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(size));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Request-Id", requestId);

    const stream = fs.createReadStream(file);

    stream.on("error", () => {
      cleanup();
      if (!res.writableEnded) res.end();
    });

    res.on("finish", cleanup);
    res.on("close", cleanup);

    return stream.pipe(res);
  });
});

// JSON 404 for anything under /api/*
// Without this, unknown API paths fall through to Express's HTML 404, which is
// what produced the frontend's "server returned HTML instead of JSON" error.
// ---------------------------------------------------------------------------
app.use("/api", (req, res) => {
  const requestId = req.id || newRequestId();

  log("warn", "api.not_found", { requestId, method: req.method, path: req.originalUrl });

  res.status(404).json({
    success: false,
    requestId,
    reason: "route_not_found",
    error: `No API route matches ${req.method} ${req.originalUrl}`,
    hint: "Available routes: GET /api/health, POST /api/download, GET /yt",
    retryable: false
  });
});

// Fallthrough 404 for everything else.
app.use((req, res) => {
  res.status(404).type("txt").send("Not found");
});

// ---------------------------------------------------------------------------
// Error handler: malformed JSON bodies, thrown errors, body-parser failures.
// Must be registered last and must take 4 args or Express ignores it.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  const requestId = req.id || newRequestId();

  if (err?.type === "entity.parse.failed") {
    log("warn", "request.bad_json", { requestId, message: err.message });

    return sendError(res, requestId, 400, {
      reason: "malformed_json",
      error: "Request body was not valid JSON.",
      hint: 'Send {"url":"https://..."} with Content-Type: application/json.',
      retryable: false
    });
  }

  if (err?.type === "entity.too.large") {
    log("warn", "request.body_too_large", { requestId });

    return sendError(res, requestId, 413, {
      reason: "body_too_large",
      error: "Request body exceeds the 10kb limit.",
      hint: null,
      retryable: false
    });
  }

  log("error", "request.unhandled", {
    requestId,
    message: err?.message,
    stack: err?.stack
  });

  return sendError(res, requestId, 500, {
    reason: "internal_error",
    error: "Internal server error.",
    hint: "Check the server log with this requestId.",
    retryable: false,
    debug: { message: err?.message, stack: err?.stack }
  });
});

app.listen(PORT, "0.0.0.0", () => {
  // Single JSON line: keeps the log stream parseable by jq / log shippers.
  log("info", "server.listen", {
    port: Number(PORT),
    debugErrors: DEBUG_ERRORS,
    node: process.version
  });
});
