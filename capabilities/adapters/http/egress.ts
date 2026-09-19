import { BlockList, isIP } from 'node:net';

/**
 * Egress control (architecture §11.3): denied by default; a capability's or step's declared
 * allow-list is the only permitted destination set.
 */

export interface HostPort {
  host: string;
  port: number;
}

/** Split `host` / `host:port` / `*.host` patterns. A pattern without a port allows 80 and 443 only. */
function splitPattern(pattern: string): { host: string; port: number | null } {
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(pattern.trim().toLowerCase());
  return { host: m?.[1] ?? pattern, port: m?.[2] ? Number(m[2]) : null };
}

export function matchesEgress(target: HostPort, allowList: readonly string[]): boolean {
  const host = target.host.toLowerCase().replace(/^\[|\]$/g, '');
  for (const raw of allowList) {
    const { host: patHost, port } = splitPattern(raw);
    const portOk = port === null ? target.port === 80 || target.port === 443 : target.port === port;
    if (!portOk) continue;
    if (patHost.startsWith('*.')) {
      const suffix = patHost.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (host === patHost) {
      return true;
    }
  }
  return false;
}

/** Always blocked — cloud metadata and other never-legitimate targets, even when explicitly allow-listed. */
const ALWAYS = new BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 metadata
  ['100.100.100.200', 32], // Alibaba Cloud metadata
  ['192.0.0.0', 24],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved / broadcast
] as const) {
  ALWAYS.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['fd00:ec2::254', 128], // AWS IPv6 metadata
] as const) {
  ALWAYS.addSubnet(addr, prefix, 'ipv6');
}

/** Private / loopback ranges — blocked unless the operator opts in and the host is allow-listed. */
const PRIVATE = new BlockList();
for (const [addr, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
] as const) {
  PRIVATE.addSubnet(addr, prefix, 'ipv4');
}
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

function normalise(ip: string): { ip: string; family: 'ipv4' | 'ipv6' } | null {
  const bare = ip.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return { ip: mapped[1]!, family: 'ipv4' };
  const family = isIP(bare);
  if (family === 4) return { ip: bare, family: 'ipv4' };
  if (family === 6) return { ip: bare, family: 'ipv6' };
  return null;
}

export type AddressVerdict = 'ok' | 'private' | 'forbidden';

/** Classify a resolved address. `forbidden` is never reachable; `private` only with operator opt-in. */
export function classifyAddress(ip: string): AddressVerdict {
  const n = normalise(ip);
  if (!n) return 'forbidden';
  if (ALWAYS.check(n.ip, n.family)) return 'forbidden';
  if (PRIVATE.check(n.ip, n.family)) return 'private';
  return 'ok';
}

export function isAddressAllowed(ip: string, allowPrivate: boolean): boolean {
  const verdict = classifyAddress(ip);
  return verdict === 'ok' || (verdict === 'private' && allowPrivate);
}
