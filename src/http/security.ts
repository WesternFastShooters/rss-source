import type { RequestHandler } from "express";

function normalizeHostname(value: string): string | null {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function requestTargetValidation(allowedHosts: readonly string[], allowedOrigins: readonly string[]): RequestHandler {
  const hosts = new Set(allowedHosts.map((value) => value.toLowerCase()));
  const origins = new Set(allowedOrigins.map((value) => value.toLowerCase()));

  return (request, response, next) => {
    const hostHeader = request.headers.host;
    const hostname = hostHeader === undefined ? null : normalizeHostname(hostHeader);
    if (hostname === null || !hosts.has(hostname)) {
      response.status(403).json({ ok: false, error: { code: "INVALID_HOST", message: "Host header is not allowed" } });
      return;
    }

    const originHeader = request.headers.origin;
    if (originHeader !== undefined) {
      let originHostname: string | null = null;
      try {
        originHostname = new URL(originHeader).hostname.toLowerCase();
      } catch {
        // Handled by the rejection below.
      }
      if (originHostname === null || !origins.has(originHostname)) {
        response.status(403).json({ ok: false, error: { code: "INVALID_ORIGIN", message: "Origin header is not allowed" } });
        return;
      }
    }

    next();
  };
}
