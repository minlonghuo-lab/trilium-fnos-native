"use strict";

async function authenticatedTriliumSession(req, backendOrigin, request = fetch) {
  const cookie = req.headers.cookie || "";
  if (!/(?:^|;\s*)trilium\.sid=[^;\s]+/.test(cookie)) return false;
  try {
    // Upstream permits /api/options during setup and noAuthentication mode.
    // Do not expose the NAS interface inventory in setup or anonymous mode.
    const [authenticated, anonymous] = await Promise.all([
      request(`${backendOrigin}/api/options`, {
        method: "HEAD", headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(5000)
      }),
      request(`${backendOrigin}/api/options`, {
        method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000)
      })
    ]);
    return authenticated.status === 200 && anonymous.status === 401;
  } catch { return false; }
}

module.exports = { authenticatedTriliumSession };
