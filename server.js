"use strict";

const express = require("express");
const { spawn } = require("node:child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10kb" }));
app.use(express.static("public"));

function validYouTubeUrl(value) {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:") return false;

    const hosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtu.be",
      "music.youtube.com"
    ];

    return hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "Cb YouTube API",
    status: "online"
  });
});

app.post("/api/download", (req, res) => {
  const videoUrl = req.body?.url;

  if (typeof videoUrl !== "string" || !validYouTubeUrl(videoUrl)) {
    return res.status(400).json({
      success: false,
      error: "Valid HTTPS YouTube URL required."
    });
  }

  // Extract metadata and available format information.
  // No authentication or access-control bypass is attempted.
  const child = spawn(
    "yt-dlp",
    [
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      "--skip-download",
      "--",
      videoUrl
    ],
    {
      shell: false,
      timeout: 60000
    }
  );

  let stdout = "";
  let stderr = "";
  let finished = false;

  const timer = setTimeout(() => {
    child.kill("SIGKILL");

    if (!res.headersSent && !finished) {
      finished = true;
      res.status(504).json({
        success: false,
        error: "Request timed out."
      });
    }
  }, 60000);

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();

    if (stdout.length > 5 * 1024 * 1024) {
      child.kill("SIGKILL");
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString().slice(0, 1000);
  });

  child.on("error", (error) => {
    clearTimeout(timer);

    if (finished || res.headersSent) return;
    finished = true;

    if (error.code === "ENOENT") {
      return res.status(503).json({
        success: false,
        error: "yt-dlp is not installed on the server."
      });
    }

    return res.status(500).json({
      success: false,
      error: "Unable to start video metadata provider."
    });
  });

  child.on("close", (code) => {
    clearTimeout(timer);

    if (finished || res.headersSent) return;
    finished = true;

    if (code !== 0) {
      console.error("yt-dlp failed:", stderr);

      return res.status(502).json({
        success: false,
        error: "Video metadata unavailable. The video may be unavailable or require authorization."
      });
    }

    try {
      const info = JSON.parse(stdout);

      const formats = (info.formats || [])
        .filter((format) => format.url && format.vcodec !== "none")
        .map((format) => ({
          format_id: format.format_id,
          ext: format.ext,
          height: format.height || null,
          filesize: format.filesize || format.filesize_approx || null,
          note: format.format_note || null
        }));

      return res.json({
        success: true,
        title: info.title,
        thumbnail: info.thumbnail || null,
        duration: info.duration || null,
        webpage_url: info.webpage_url,
        formats,
        message: "Format information retrieved. Media URLs are not exposed by this API."
      });
    } catch {
      return res.status(502).json({
        success: false,
        error: "Invalid metadata response."
      });
    }
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Cb YouTube API listening on port ${PORT}`);
});
