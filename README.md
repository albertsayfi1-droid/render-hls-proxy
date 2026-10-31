# Render HLS Proxy

Upload these files (not the ZIP) to a GitHub repository. On Render select New > Web Service and connect the repository. Runtime: Node; Build Command: `npm install`; Start Command: `npm start`. The Render public URL serves `/hls/1.m3u8` and `/hls/2.m3u8`. Edit CHANNELS in server.js for authorized sources.

This is a demonstration proxy. Render plans may restrict bandwidth and streaming use. The origin host allowlist intentionally restricts proxy destinations. Public URLs are not a security boundary; do not embed secrets.
