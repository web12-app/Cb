"use strict";

const express = require("express");
const path = require("path");
const dns = require("node:dns").promises;
const net = require("node:net");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use(express.static(PUBLIC_DIR));

/*
 * Health check
 */
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "Cb Direct Download Server",
    status: "online",
    provider: "direct-url",
    timestamp: new Date().toISOString()
  });
});

/*
 * URL validation helpers
 */

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateIPv6(ip) {
  const address = ip.toLowerCase().split("%")[0];

  if (
    address === "::" ||
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    /^fe[89ab]/.test(address) ||
    address.startsWith("ff")
  ) {
    return true;
  }

  // Reject IPv4-mapped IPv6 addresses to avoid validation bypasses.
  if (address.startsWith("::ffff:")) {
    return true;
  }

  return false;
}

function isBlockedAddress(address) {
  const family = net.isIP(address);

  if (family === 4) {
    return isPrivateIPv4(address);
  }

  if (family === 6) {
    return isPrivateIPv6(address);
  }

  return true;
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".test") ||
    host.endsWith(".invalid") ||
    host.endsWith(".example")
  ) {
    return true;
  }

  const family = net.isIP(host);

  if (family) {
    return isBlockedAddress(host);
  }

  return false;
}

function parseHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 4096) {
    return null;
  }

  try {
    const parsed = new URL(value);

    if (parsed.protocol !== "https:") {
      return null;
    }

    if (parsed.username || parsed.password) {
      return null;
    }

    if (parsed.port && parsed.port !== "443") {
      return null;
    }

    if (isBlockedHostname(parsed.hostname)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/*
 * Direct download link endpoint
 *
 * POST /api/download
 * JSON: { "url": "https://example.com/video.mp4" }
 *
 * This returns the supplied direct URL. It does not download the
 * file through this server or convert video-page URLs into file URLs.
 */
app.post("/api/download", async (req, res) => {
  const parsed = parseHttpsUrl(req.body?.url);

  if (!parsed) {
    return res.status(400).json({
      success: false,
      error: "Enter a valid public HTTPS URL on port 443."
    });
  }

  try {
    // Resolve hostnames and reject private/local destinations.
    // The URL is not fetched by this endpoint.
    const hostname = parsed.hostname;

    if (!net.isIP(hostname)) {
      const addresses = await dns.lookup(hostname, {
        all: true,
        verbatim: true
      });

      if (
        addresses.length === 0 ||
        addresses.some((entry) => isBlockedAddress(entry.address))
      ) {
        return res.status(400).json({
          success: false,
          error: "This hostname resolves to a restricted network address."
        });
      }
    }

    return res.json({
      success: true,
      provider: "direct-url",
      downloadUrl: parsed.href,
      message: "Direct URL validated. Open the link to access the file."
    });
  } catch (error) {
    console.error("URL validation failed:", error.message);

    return res.status(400).json({
      success: false,
      error: "Unable to validate this hostname. Check the URL and try again."
    });
  }
});

/*
 * API fallback
 */
app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    error: "API endpoint not found."
  });
});

/*
 * Page fallback
 */
app.get("*path", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"), (error) => {
    if (error && !res.headersSent) {
      res.status(404).send("Cb page not found. Add public/index.html.");
    }
  });
});

/*
 * Error handler
 */
app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(error.status || 500).json({
    success: false,
    error:
      error.type === "entity.parse.failed"
        ? "Invalid JSON request."
        : "Internal server error."
  });
});

/*
 * Start server
 */
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("====================================");
  console.log("Cb Direct Download Server");
  console.log(`Port: ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
  console.log("Provider: direct-url");
  console.log("====================================");
});

server.on("error", (error) => {
  console.error("Failed to start server:", error.message);
  process.exitCode = 1;
});
