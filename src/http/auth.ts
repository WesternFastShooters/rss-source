import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function apiKeyAuth(expectedApiKey: string): RequestHandler {
  const expected = digest(expectedApiKey);
  return (request, response, next) => {
    const authorization = request.headers.authorization;
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (token === undefined || !timingSafeEqual(digest(token), expected)) {
      response.status(401).json({ ok: false, error: { code: "UNAUTHORIZED", message: "A valid Bearer API key is required" } });
      return;
    }
    next();
  };
}
