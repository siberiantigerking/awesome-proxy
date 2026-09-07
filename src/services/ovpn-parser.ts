import type { ProxyNode } from '../types';

/**
 * Parser for OpenVPN `.ovpn` profiles.
 *
 * OpenVPN has no share-link format — profiles are distributed as files with the
 * certificates inlined — so importing the file is the only realistic path, the
 * same reason ShadowTLS and WireGuard are file/manual only.
 *
 * This deliberately understands a small subset: the directives that map onto
 * what sing-box's `openvpn-client` endpoint can express. Everything else is
 * reported back so the user finds out what was dropped instead of wondering why
 * the connection behaves differently from the official client.
 */

export interface OvpnParseResult {
  node: ProxyNode | null;
  /** Fatal problems: why no node could be produced. */
  errors: string[];
  /** Recognised-but-unsupported or noteworthy directives, for the user. */
  warnings: string[];
  /** True when the profile expects a username/password the file doesn't carry. */
  needsCredentials: boolean;
}

/** Inline blocks we care about, mapped to where they land on the node. */
const INLINE_BLOCKS = [
  'ca',
  'cert',
  'key',
  'tls-auth',
  'tls-crypt',
  'tls-crypt-v2',
  'auth-user-pass',
] as const;

/**
 * Directives that change behaviour we cannot reproduce. Listed explicitly so
 * the warning says something specific rather than dumping every unknown line —
 * .ovpn files are full of harmless noise (`verb`, `nobind`, `persist-key`...).
 */
const UNSUPPORTED_DIRECTIVES: Record<string, string> = {
  'http-proxy': 'connecting through an HTTP proxy is ignored; route the node through another proxy instead',
  'socks-proxy': 'connecting through a SOCKS proxy is ignored; route the node through another proxy instead',
  'pkcs12': 'PKCS#12 bundles are not supported — export the CA, certificate and key as PEM',
  'crl-verify': 'certificate revocation lists are not imported',
  'tls-crypt-v2': 'tls-crypt-v2 is not supported: the current core crashes on it',
  'static-key': 'static-key (pre-TLS) mode is not supported',
  secret: 'static-key (pre-TLS) mode is not supported',
  'auth-user-pass-verify': 'server-side directive, ignored',
  'route-nopull': 'pushed routes are handled by sing-box routing rather than the profile',
  fragment: 'OpenVPN fragmentation is not imported',
};

function generateId(): string {
  return `ovpn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Strip inline `<tag>...</tag>` blocks out of the text, returning them
 * separately. Done first so directive parsing never walks into PEM bodies —
 * base64 lines can otherwise look like directives.
 */
function extractInlineBlocks(text: string): { body: string; blocks: Record<string, string> } {
  const blocks: Record<string, string> = {};
  let body = text;
  for (const tag of INLINE_BLOCKS) {
    // [\s\S] because the content spans lines; non-greedy so adjacent blocks of
    // the same tag can't be swallowed into one.
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
    const match = body.match(re);
    if (match) {
      blocks[tag] = match[1].trim();
      body = body.replace(match[0], '');
    }
  }
  return { body, blocks };
}

/** Normalise a `proto` / `remote` transport token to what sing-box wants. */
function normaliseProto(value: string): 'udp' | 'tcp' | null {
  const v = value.toLowerCase();
  // OpenVPN spells the client side tcp-client, and tcp4/tcp6/udp4/udp6 pin the
  // address family — which sing-box handles via its own resolver, so the family
  // suffix is dropped rather than treated as unsupported.
  if (v.startsWith('tcp')) return 'tcp';
  if (v.startsWith('udp')) return 'udp';
  return null;
}

export function parseOvpnConfig(text: string, fileName?: string): OvpnParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let needsCredentials = false;

  if (!text || !text.trim()) {
    return { node: null, errors: ['The file is empty.'], warnings, needsCredentials };
  }

  const { body, blocks } = extractInlineBlocks(text);

  let server = '';
  let port = 0;
  let proto: 'udp' | 'tcp' | null = null;
  let remoteCount = 0;
  const dataCiphers: string[] = [];
  let cipher = '';
  let auth = '';
  let compLzo = '';
  let mtu = 0;
  let keyDirection: 'server' | 'client' | undefined;
  let verifyName = '';
  let username = '';
  let password = '';

  for (const rawLine of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const parts = line.split(/\s+/);
    const directive = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (directive) {
      case 'remote': {
        remoteCount++;
        // Only the first `remote` is used. sing-box does support a `servers`
        // list with failover, but our node model is one server per node, and
        // silently picking one of several without saying so would be worse.
        if (remoteCount === 1) {
          server = args[0] || '';
          if (args[1]) port = parseInt(args[1], 10) || 0;
          if (args[2]) proto = normaliseProto(args[2]) || proto;
        }
        break;
      }
      case 'port':
        if (!port) port = parseInt(args[0], 10) || 0;
        break;
      case 'proto':
      case 'transport-proto': {
        const p = normaliseProto(args[0] || '');
        if (p) proto = p;
        break;
      }
      case 'data-ciphers':
      case 'data-ciphers-fallback':
        // Colon-separated in OpenVPN; sing-box takes a list.
        for (const c of (args[0] || '').split(':')) {
          const t = c.trim();
          if (t && !dataCiphers.includes(t)) dataCiphers.push(t);
        }
        break;
      case 'cipher':
        cipher = args[0] || '';
        break;
      case 'auth':
        auth = args[0] || '';
        break;
      case 'comp-lzo':
        // Bare `comp-lzo` means adaptive in OpenVPN 2.x.
        compLzo = (args[0] || 'adaptive').toLowerCase();
        break;
      case 'compress':
        warnings.push(
          `\`compress${args[0] ? ' ' + args[0] : ''}\` is not imported; compression can weaken confidentiality and sing-box only permits stub framing by default.`
        );
        break;
      case 'tun-mtu':
      case 'link-mtu':
        mtu = parseInt(args[0], 10) || 0;
        break;
      case 'key-direction':
        keyDirection = args[0] === '0' ? 'server' : 'client';
        break;
      case 'verify-x509-name':
        verifyName = args[0] || '';
        break;
      case 'remote-cert-tls':
        // sing-box defaults to `server`, which is what practically every
        // profile asks for, so this only matters if it says something else.
        if ((args[0] || '').toLowerCase() !== 'server') {
          warnings.push(`\`remote-cert-tls ${args[0]}\` is not imported.`);
        }
        break;
      case 'auth-user-pass':
        // Three shapes exist: an inline block (handled below, credentials
        // present), a path argument pointing at a file we don't have, or bare
        // (the official client prompts). The last two need the user to fill in
        // the node afterwards.
        needsCredentials = true;
        break;
      case 'tls-auth':
        // `tls-auth ta.key 1` — the direction can ride on the directive even
        // when the key itself is inline.
        if (args[1]) keyDirection = args[1] === '0' ? 'server' : 'client';
        break;
      default:
        if (UNSUPPORTED_DIRECTIVES[directive]) {
          warnings.push(`\`${directive}\`: ${UNSUPPORTED_DIRECTIVES[directive]}`);
        }
        break;
    }
  }

  if (remoteCount > 1) {
    warnings.push(
      `The profile lists ${remoteCount} servers; only the first (${server}) was imported. Add the others as separate nodes if you want to switch between them.`
    );
  }
  if (!server) errors.push('No `remote` server found in the profile.');
  if (!port) port = 1194; // OpenVPN's own default
  if (!blocks.ca) {
    errors.push('No `<ca>` certificate block found. A CA is required to verify the server.');
  }
  if (blocks.cert && !blocks.key) errors.push('Found `<cert>` but no `<key>`.');
  if (blocks.key && !blocks.cert) errors.push('Found `<key>` but no `<cert>`.');
  if (blocks['tls-crypt-v2']) {
    errors.push(
      'This profile uses tls-crypt-v2, which the current sing-box core crashes on, so it cannot be imported safely.'
    );
  }

  // An inline <auth-user-pass> block carries the credentials directly: first
  // line username, second password. When present there is nothing to prompt for.
  if (blocks['auth-user-pass']) {
    const creds = blocks['auth-user-pass'].split('\n').map((l) => l.trim()).filter(Boolean);
    if (creds.length >= 2) {
      username = creds[0];
      password = creds[1];
      needsCredentials = false;
    }
  }

  if (errors.length) return { node: null, errors, warnings, needsCredentials };

  // tls-crypt and tls-auth are mutually exclusive in practice; prefer
  // tls-crypt when a profile somehow carries both, since it is the stronger and
  // the newer of the two.
  let wrapType: 'tls_auth' | 'tls_crypt' | undefined;
  let wrapKey: string | undefined;
  if (blocks['tls-crypt']) {
    wrapType = 'tls_crypt';
    wrapKey = blocks['tls-crypt'];
    if (blocks['tls-auth']) {
      warnings.push('Profile contained both tls-crypt and tls-auth; used tls-crypt.');
    }
  } else if (blocks['tls-auth']) {
    wrapType = 'tls_auth';
    wrapKey = blocks['tls-auth'];
  }

  const baseName = (fileName || '').replace(/\.ovpn$/i, '').trim();
  const node: ProxyNode = {
    id: generateId(),
    name: baseName || `${server}:${port}`,
    type: 'openvpn',
    server,
    port,
    ovpnNetwork: proto === 'tcp' ? 'tcp' : 'udp',
    ovpnCa: blocks.ca,
    tls: true,
  };
  if (blocks.cert && blocks.key) {
    node.ovpnClientCert = blocks.cert;
    node.ovpnClientKey = blocks.key;
  }
  if (wrapType && wrapKey) {
    node.ovpnControlWrapType = wrapType;
    node.ovpnControlWrapKey = wrapKey;
    if (wrapType === 'tls_auth' && keyDirection) node.ovpnControlWrapDirection = keyDirection;
  }
  if (verifyName) node.sni = verifyName;
  if (dataCiphers.length) node.ovpnDataCiphers = dataCiphers;
  if (cipher) node.ovpnDataCiphersFallback = cipher;
  if (auth) node.ovpnAuth = auth;
  if (compLzo && compLzo !== 'no' && compLzo !== 'none') node.ovpnCompressionLzo = compLzo;
  if (mtu) node.mtu = mtu;
  if (username) node.username = username;
  if (password) node.password = password;

  if (needsCredentials) {
    warnings.push(
      'This profile uses username/password authentication. Edit the node to fill them in before connecting.'
    );
  }

  return { node, errors, warnings, needsCredentials };
}
