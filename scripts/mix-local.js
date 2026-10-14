#!/usr/bin/env node
"use strict";

// Downloads a video's direct video+audio streams from the Cb server and merges
// them into one file on THIS machine with the local ffmpeg, then prints the
// output path. Run it somewhere YouTube is not blocking your IP.
//
//   node scripts/mix-local.js <youtube-url> [outputDir]
//
// Env: CB_SERVER (default http://localhost:3000), FFMPEG (default "ffmpeg")

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const url = process.argv[2];
const outDir = path.resolve(process.argv[3] || process.cwd());
const server = (process.env.CB_SERVER || "http://localhost:3000").replace(/\/+$/, "");
const ffmpeg = process.env.FFMPEG || "ffmpeg";

if (!url) {
  console.error("usage: node scripts/mix-local.js <youtube-url> [outputDir]");
  process.exit(1);
}

async function downloadTo(fileUrl, filePath) {
  const res = await fetch(fileUrl, { headers: { "ngrok-skip-browser-warning": "1" } });

  if (!res.ok) {
    throw new Error("HTTP " + res.status + " while downloading the media stream");
  }

  fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
  return fs.statSync(filePath).size;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  console.log("Resolving streams via " + server + " ...");
  const res = await fetch(server + "/yt?=" + encodeURIComponent(url) + "&direct=1&json=1", {
    headers: { accept: "application/json", "ngrok-skip-browser-warning": "1" }
  });
  const info = await res.json();

  if (!info || info.success !== true || typeof info.downloadUrl !== "string") {
    throw new Error("could not resolve streams: " + JSON.stringify(info).slice(0, 200));
  }

  const base = String(info.filename || "video.mp4").replace(/\.mp4$/i, "");
  const videoPath = path.join(outDir, base + ".video.mp4");
  const audioPath = path.join(outDir, base + ".audio.bin");
  const outPath = path.join(outDir, base + ".mp4");

  console.log("Downloading video stream ...");
  console.log("  " + (await downloadTo(info.downloadUrl, videoPath)) + " bytes -> " + videoPath);

  if (info.audioUrl) {
    console.log("Downloading audio stream ...");
    console.log("  " + (await downloadTo(info.audioUrl, audioPath)) + " bytes -> " + audioPath);
  }

  console.log("Merging with ffmpeg ...");
  const args = info.audioUrl
    ? ["-y", "-i", videoPath, "-i", audioPath, "-c", "copy", outPath]
    : ["-y", "-i", videoPath, "-c", "copy", outPath];

  const merged = spawnSync(ffmpeg, args, { stdio: "inherit" });

  if (merged.status !== 0) {
    throw new Error("ffmpeg failed (is it installed and on PATH?)");
  }

  fs.rmSync(videoPath, { force: true });
  fs.rmSync(audioPath, { force: true });

  const size = fs.statSync(outPath).size;
  console.log("");
  console.log("Merged file: " + outPath);
  console.log("Size: " + (size / (1024 * 1024)).toFixed(1) + " MB");
}

main().catch((error) => {
  console.error("mix-local failed: " + error.message);
  console.error("");
  console.error("If your machine can fetch the media this works; otherwise merge locally with yt-dlp:");
  console.error('  yt-dlp -f "bv*+ba/b" --merge-output-format mp4 -o "' + path.join(outDir, "%(title)s.%(ext)s") + '" "' + url + '"');
  process.exit(1);
});
