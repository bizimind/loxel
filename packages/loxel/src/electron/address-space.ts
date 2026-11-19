/**
 * Address spaces, as Chromium's Local Network Access names them: whether a host is this machine
 * (`loopback`), a device on the local network (`local`), or anywhere else (`public`). A page may
 * only reach a more private space than its own with its site's permission
 * (`browser-local-network.ts`).
 */
import { isIP } from "node:net";

export type AddressSpace = "loopback" | "local" | "public";

/** Lower is more private. */
const PRIVACY: Record<AddressSpace, number> = { loopback: 0, local: 1, public: 2 };

/**
 * Whether a request from `initiator` to `target` needs the site's permission: public pages
 * reaching the local network or this machine, and local network pages reaching this machine.
 * Pages on this machine (dev servers) reach anything.
 */
export function isMorePrivate(target: AddressSpace, initiator: AddressSpace): boolean {
  return PRIVACY[target] < PRIVACY[initiator];
}

/** The more private of two spaces. */
export function mostPrivate(a: AddressSpace, b: AddressSpace): AddressSpace {
  return PRIVACY[a] <= PRIVACY[b] ? a : b;
}

/** IPv4 ranges by space: address, prefix length. Chromium's table (`ip_address_space_util.cc`). */
const IPV4_RANGES: [string, number, AddressSpace][] = [
  ["127.0.0.0", 8, "loopback"],
  // "This host": connecting to 0.0.0.0 reaches this machine.
  ["0.0.0.0", 32, "loopback"],
  ["0.0.0.0", 8, "local"],
  ["10.0.0.0", 8, "local"],
  // Carrier-grade NAT, as VPNs such as Tailscale use it.
  ["100.64.0.0", 10, "local"],
  ["172.16.0.0", 12, "local"],
  ["192.168.0.0", 16, "local"],
  ["169.254.0.0", 16, "local"],
];

/** IPv6 ranges by space, as their leading 16-bit groups and prefix length. */
const IPV6_RANGES: [number[], number, AddressSpace][] = [
  // Unique local (fc00::/7), link-local (fe80::/10) and deprecated site-local (fec0::/10).
  [[0xfc00], 7, "local"],
  [[0xfe80], 10, "local"],
  [[0xfec0], 10, "local"],
  // Documentation (2001:db8::/32, 3fff::/20), which Chromium counts as local.
  [[0x2001, 0x0db8], 32, "local"],
  [[0x3fff, 0], 20, "local"],
];

function ipv4Bits(address: string): number {
  return address.split(".").reduce((bits, part) => (bits << 8) + Number(part), 0) >>> 0;
}

function ipv4Space(address: string): AddressSpace {
  const bits = ipv4Bits(address);
  for (const [base, length, space] of IPV4_RANGES) {
    const mask = length === 0 ? 0 : (0xff_ff_ff_ff << (32 - length)) >>> 0;
    if ((bits & mask) >>> 0 === (ipv4Bits(base) & mask) >>> 0) return space;
  }
  return "public";
}

/** The eight 16-bit groups of an IPv6 address, or null if it isn't one. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  // An IPv4 tail (`::ffff:192.168.0.1`) is two groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail?.[1] && tail[2]) {
    const bits = ipv4Bits(tail[2]);
    text = `${tail[1]}${(bits >>> 16).toString(16)}:${(bits & 0xff_ff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (half: string | undefined) => (half ? half.split(":") : []);
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...rest].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xff_ff) ? groups : null;
}

function ipv6Space(groups: number[]): AddressSpace {
  const isZero = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  // ::1 is this machine, and :: ("this host") reaches it too.
  if (isZero(0, 7) && (groups[7] === 1 || groups[7] === 0)) return "loopback";
  // An IPv4-mapped address (::ffff:a.b.c.d) is that IPv4 address.
  if (isZero(0, 5) && groups[5] === 0xff_ff) {
    const [high = 0, low = 0] = groups.slice(6);
    return ipv4Space(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
  }
  for (const [prefix, length, space] of IPV6_RANGES) {
    let bitsLeft = length;
    const matches = prefix.every((group, i) => {
      const take = Math.min(16, bitsLeft);
      bitsLeft -= take;
      const mask = (0xff_ff << (16 - take)) & 0xff_ff;
      return ((groups[i] ?? 0) & mask) === (group & mask);
    });
    if (matches) return space;
  }
  return "public";
}

/** The space of an IP address (`192.168.1.1`, `::1`), or null if `address` isn't one. */
export function ipAddressSpace(address: string): AddressSpace | null {
  const version = isIP(address);
  if (version === 4) return ipv4Space(address);
  if (version !== 6) return null;
  const groups = ipv6Groups(address);
  return groups ? ipv6Space(groups) : null;
}

/**
 * The space a URL's hostname names by itself: an IP address, `localhost` and its subdomains (this
 * machine), or a `.local` name (multicast DNS on the local network). Null for any other name, whose
 * space is that of the address it resolves to.
 */
export function literalHostSpace(hostname: string): AddressSpace | null {
  // URLs bracket IPv6 hosts; a trailing dot names the same host.
  const host = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
  const address = ipAddressSpace(host);
  if (address) return address;
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (host === "local" || host.endsWith(".local")) return "local";
  return null;
}
