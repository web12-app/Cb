"use strict";

const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
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

// Extractor args: the tv player client does not trigger YouTube's bot
// challenge on datacenter IPs (GitHub Actions, Render, Fly, etc.).
// Override with YTDLP_EXTRACTOR_ARGS="" to restore yt-dlp defaults.
const YTDLP_EXTRACTOR_ARGS =
  process.env.YTDLP_EXTRACTOR_ARGS === undefined
    ? "youtube:player_client=tv,web_safari"
    : process.env.YTDLP_EXTRACTOR_ARGS;

// Optional YouTube cookies (Netscape cookies.txt format) to bypass the
// datacenter-IP bot check with a logged-in session. Set YTDLP_COOKIES_PATH
// to the file location; exported via a GitHub Actions secret.
const YTDLP_COOKIES_PATH = process.env.YTDLP_COOKIES_PATH || "";
const YTDLP_COOKIES_ARGS =
  YTDLP_COOKIES_PATH && fs.existsSync(YTDLP_COOKIES_PATH)
    ? ["--cookies", YTDLP_COOKIES_PATH]
    : [];

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
    hint: "Set the YTDLP_COOKIES secret (cookies.txt export) so the server uses a logged-in session; cookies bypass the datacenter-IP bot check.",
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
        ...(YTDLP_EXTRACTOR_ARGS ? ["--extractor-args", YTDLP_EXTRACTOR_ARGS] : []),
        ...YTDLP_COOKIES_ARGS,
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
    hint: "Available routes: GET /api/health, POST /api/download",
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
