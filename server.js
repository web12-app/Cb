const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

function validateYouTubeUrl(value) {
  try {
    const url = new URL(value);

    const allowedHosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtu.be"
    ];

    if (
      url.protocol !== "https:" ||
      !allowedHosts.includes(url.hostname)
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "CB Download Proxy"
  });
});

app.post("/api/download", async (req, res) => {
  const { url, quality } = req.body || {};

  const allowedQualities = [
    "720p",
    "1080p",
    "1440p",
    "2160p"
  ];

  if (!validateYouTubeUrl(url)) {
    return res.status(400).json({
      error: "Valid HTTPS YouTube URL required."
    });
  }

  if (!allowedQualities.includes(quality)) {
    return res.status(400).json({
      error: "Select a supported video quality."
    });
  }

  /*
   * Connect your authorized download provider here.
   *
   * The provider must return a verified download URL
   * or a downloadable stream for content the requester
   * is authorized to download.
   *
   * Do not return arbitrary user-supplied URLs or proxy
   * unrestricted external URLs.
   */

  return res.status(501).json({
    error: "Download provider is not configured yet.",
    message:
      "The proxy server is running, but a permitted download provider must be connected."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CB Download Proxy running on port ${PORT}`);
});
