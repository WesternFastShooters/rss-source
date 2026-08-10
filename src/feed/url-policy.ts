import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "../errors.js";

export type DnsAddress = { address: string; family: number };
export type DnsResolver = (hostname: string) => Promise<DnsAddress[]>;

const defaultResolver: DnsResolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function ipv4Number(address: string): number {
  return address
    .split(".")
    .map(Number)
    .reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function ipv4InCidr(address: string, network: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}

function isBlockedIpv4(address: string): boolean {
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([network, prefix]) => ipv4InCidr(address, network as string, prefix as number));
}

function isBlockedIpv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0] ?? address.toLowerCase();
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith("ff")) return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped === undefined ? false : isBlockedIpv4(mapped);
}

export function isPrivateOrReservedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

export async function assertSafeHttpUrl(
  input: string | URL,
  allowedPrivateHosts: ReadonlySet<string>,
  resolver: DnsResolver = defaultResolver,
): Promise<URL> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw new AppError(400, "INVALID_FEED_URL", "Feed URL is not a valid absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(400, "INVALID_FEED_URL", "Only http and https feed URLs are allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError(400, "INVALID_FEED_URL", "Credentials in feed URLs are not allowed");
  }

  const hostname = url.hostname.toLowerCase();
  if (allowedPrivateHosts.has(hostname)) return url;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new AppError(400, "BLOCKED_FEED_HOST", "Local feed hosts are blocked");
  }

  const addresses = isIP(hostname) === 0 ? await resolver(hostname) : [{ address: hostname, family: isIP(hostname) }];
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrReservedAddress(address))) {
    throw new AppError(400, "BLOCKED_FEED_HOST", "Feed URL resolves to a private or reserved address");
  }
  return url;
}

export function resolveSubscriptionUrl(input: string, rsshubBaseUrl?: string): { url: string; fetchUrl: string } {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith("rsshub://")) {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new AppError(400, "INVALID_FEED_URL", "Only http and https feed URLs are allowed");
    }
    if (url.username !== "" || url.password !== "") {
      throw new AppError(400, "INVALID_FEED_URL", "Credentials in feed URLs are not allowed");
    }
    url.hash = "";
    return { url: url.toString(), fetchUrl: url.toString() };
  }
  if (rsshubBaseUrl === undefined) {
    throw new AppError(400, "RSSHUB_NOT_CONFIGURED", "RSSHUB_BASE_URL is required for rsshub:// subscriptions");
  }
  const route = trimmed.slice("rsshub://".length).replace(/^\/+/, "");
  if (route === "" || route.includes("..")) {
    throw new AppError(400, "INVALID_RSSHUB_ROUTE", "Invalid RSSHub route");
  }
  const base = rsshubBaseUrl.endsWith("/") ? rsshubBaseUrl : `${rsshubBaseUrl}/`;
  return { url: `rsshub://${route}`, fetchUrl: new URL(route, base).toString() };
}
