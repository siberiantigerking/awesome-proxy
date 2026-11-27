import type { ProxyNode } from '../../src/types';

/**
 * One node per protocol and shape the generator supports, plus two invalid
 * nodes and a duplicate-name pair.
 *
 * ALL KEY MATERIAL BELOW IS DUMMY TEST DATA THAT REACHES NOTHING. It was made
 * once with the bundled core's read-only `generate` commands (uuid,
 * reality-keypair, wg-keypair, rand, tls-keypair) and `crypto.randomBytes`, and
 * only exists so `sing-box check` sees well-formed values. No private TLS key
 * is included.
 *
 * Every server is 127.0.0.1 on a port in 19193-19199, the spare loopback range
 * the run smoke test checks is free before it starts the core, so even the
 * `auto` urltest probing every node at startup only dials those ports.
 *
 * Order matters: it fixes the outbound tags, and so the snapshot files. Ids
 * equal names, except the `dup` pair (dup-a, dup-b), whose tags are dup and
 * dup-1.
 */

const UUID = '2420e4a1-e97c-4780-a7a0-f47b2a402ba7';
const REALITY_PUBLIC_KEY = 'WtyFbF5JOHxY52iYnUbP15Zy4t_AdUGN0Nu5S5t9JEo';
const WG_PRIVATE_KEY = 'iIGbFKdo9vdiXQQRQCtAdstbfI7edqrHIn8XgE0X0EI=';
const WG_PEER_PUBLIC_KEY = 'ZKw+L8OgzvCHV9VGZCBdPNqernMi0E+aRp2m177c1lQ=';
const WG_PRE_SHARED_KEY = 'AMa/l+dkp3gwvM3rFsm8ZKzpBbfJJWGbdRA22wrSFjs=';
/** 16 bytes, base64: the exact key size 2022-blake3-aes-128-gcm requires. */
const SS2022_AES128_KEY = 'oU4dz5lCiAHOgjTzhuNBLw==';

/** Self-signed for fixture.invalid. `check` does not parse an OpenVPN CA; any PEM would pass. */
const OVPN_CA = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIQCpYE96NyziZSXbsv7WDcSzANBgkqhkiG9w0BAQsFADAa
MRgwFgYDVQQDEw9maXh0dXJlLmludmFsaWQwHhcNMjYxMTA4MDUzMjIyWhcNMjYx
MjA4MDYzMjIxWjAaMRgwFgYDVQQDEw9maXh0dXJlLmludmFsaWQwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDZBac7S0m7odgly97FAXcNYHdYwMe8wYnC
yFZGOCqtFdZQAvkeC7NLByUWxgPiEnVOi6huMdH7gdvyWYu/mFE2CxoJ9yNgJDcO
T/Pl3KWvjkwvrss3oO+54nem3EhGpSr4a7JXjhSigyaJNYrVWSC+7pHCIW4q5BNK
0wwzsxY8VgHzGW4OLI5fa/nlJ3WFo4K7IGYx/8lSnK95xnlDXTergXB4qCpfwaXk
lAoPiTcuPThzst5yGzDNExNUQTM+6XXDANbBW7el/Ze4ViS6xXhWLSJAgS4GcEQP
ClofOgzcHQICXTOFSHVoHwjBMn7a4gZlWfzQTKPH/MEAAc1HXGMPAgMBAAGjUTBP
MA4GA1UdDwEB/wQEAwIFoDATBgNVHSUEDDAKBggrBgEFBQcDATAMBgNVHRMBAf8E
AjAAMBoGA1UdEQQTMBGCD2ZpeHR1cmUuaW52YWxpZDANBgkqhkiG9w0BAQsFAAOC
AQEAI3nYB5V5zcVkyTaJUE24DOVtX7Y44yk7mEonvumKkkdP8dGpvF1rTW4od5/S
ZsTQ+9/CF9CL7AcOuKo8/TBodb5cTpm0gDUQlg3Ux3c0e09BvHmHbYBf2J4RDGrd
a1EL2oJp6ufRK7qE/pgxIIL6zMQb1l8Ec3/tR8PG1+voIj7SuVejGrpz2dz1fwFR
K6NCXBFl5w/7LtNXysGUGxqDZLhwJCvdLbzEGMcKoJXL1kWLaJbbPQjepHkGiWKb
w3ndhMJ3s76zPyDcSGJ4E0+ZsW5rtO6Ag63aBGBPyWHimCOyovdModIzd+psInEg
AwPc9ut/tR3LCK8W623RZ7WNEA==
-----END CERTIFICATE-----
`;

/** 256 bytes: the only static-key size that does not crash the core (see openvpnRejectionReason). */
const OVPN_STATIC_KEY = `-----BEGIN OpenVPN Static key V1-----
94483451c0e00834294aebfe9acbcd0e
5ccd39ff4477557387dcd05e45dc4ff3
7252f89f9f2bf6e189dbfbc944575484
62e4c85f0f0a246bd9ad5a49da51d409
4126df488443f749cbfa2ee4577d9ab1
d4b87ac651c5e5d7a865cbd768ea72be
25ebe87bd5ba37416a30abc53ecd2f7a
73a7b209b5f85f36c7ad657a6228995f
70c8c62b6c1f0150f183769bdee940ff
9ca00a14e0f79c5913ff88f32d143312
a250fe0bee675138f977cfee42629a90
699d1d73e20bf8392711d90bdf03874c
7a3452235966ae558e9eb87df0f8f4c1
e1765e0e57904ba8099fcd0de90d9678
86a442583ebffb17f2897c061b153773
cfc812fac1a58ab1f968b31a6e2c009a
-----END OpenVPN Static key V1-----
`;

export const NODE_FIXTURES: readonly ProxyNode[] = [
  // 1
  {
    id: 'vmess-ws-tls',
    name: 'vmess-ws-tls',
    type: 'vmess',
    server: '127.0.0.1',
    port: 19193,
    uuid: UUID,
    alterId: 0,
    security: 'auto',
    tls: true,
    sni: 'example.com',
    transportType: 'ws',
    transportPath: '/ws',
    transportHost: 'example.com',
  },
  // 2
  {
    id: 'vmess-grpc-utls',
    name: 'vmess-grpc-utls',
    type: 'vmess',
    server: '127.0.0.1',
    port: 19194,
    uuid: UUID,
    alterId: 0,
    security: 'auto',
    tls: true,
    sni: 'example.com',
    fingerprint: 'chrome',
    transportType: 'grpc',
    transportPath: 'grpc-svc',
  },
  // 3
  {
    id: 'vmess-tcp',
    name: 'vmess-tcp',
    type: 'vmess',
    server: '127.0.0.1',
    port: 19195,
    uuid: UUID,
    alterId: 0,
    security: 'auto',
    transportType: 'tcp',
  },
  // 4: no fingerprint on purpose, which exercises the generator's chrome default for Reality.
  {
    id: 'vless-reality-vision',
    name: 'vless-reality-vision',
    type: 'vless',
    server: '127.0.0.1',
    port: 19196,
    uuid: UUID,
    flow: 'xtls-rprx-vision',
    tls: true,
    sni: 'www.example.com',
    realityPublicKey: REALITY_PUBLIC_KEY,
    realityShortId: '0123abcd',
  },
  // 5
  {
    id: 'trojan-tls',
    name: 'trojan-tls',
    type: 'trojan',
    server: '127.0.0.1',
    port: 19197,
    password: 'trojan-password',
    tls: true,
    sni: 'example.com',
  },
  // 6
  {
    id: 'ss-aes-256-gcm',
    name: 'ss-aes-256-gcm',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19198,
    method: 'aes-256-gcm',
    password: 'ss-password',
  },
  // 7
  {
    id: 'ss-2022-blake3-aes-128-gcm',
    name: 'ss-2022-blake3-aes-128-gcm',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19199,
    method: '2022-blake3-aes-128-gcm',
    password: SS2022_AES128_KEY,
  },
  // 8
  {
    id: 'hy2-salamander-hop',
    name: 'hy2-salamander-hop',
    type: 'hysteria2',
    server: '127.0.0.1',
    port: 19196,
    password: 'hy2-password',
    tls: true,
    sni: 'example.com',
    obfsType: 'salamander',
    obfsPassword: 'salamander-password',
    serverPorts: ['19196:19198'],
    hopInterval: '30s',
    upMbps: 50,
    downMbps: 200,
    disableChromeParrot: true,
  },
  // 9: gecko obfs needs core 1.14+, so the oldest-core case must skip it.
  {
    id: 'hy2-gecko',
    name: 'hy2-gecko',
    type: 'hysteria2',
    server: '127.0.0.1',
    port: 19197,
    password: 'hy2-password',
    tls: true,
    sni: 'example.com',
    obfsType: 'gecko',
    obfsPassword: 'gecko-password',
  },
  // 10
  {
    id: 'tuic-v5',
    name: 'tuic-v5',
    type: 'tuic',
    server: '127.0.0.1',
    port: 19198,
    uuid: UUID,
    password: 'tuic-password',
    tls: true,
    sni: 'example.com',
    congestionControl: 'bbr',
    udpRelayMode: 'native',
  },
  // 11
  {
    id: 'anytls',
    name: 'anytls',
    type: 'anytls',
    server: '127.0.0.1',
    port: 19199,
    password: 'anytls-password',
    tls: true,
    sni: 'example.com',
  },
  // 12: emitted as a shadowsocks outbound plus a shadowtls helper it detours through.
  {
    id: 'shadowtls-v3',
    name: 'shadowtls-v3',
    type: 'shadowtls',
    server: '127.0.0.1',
    port: 19193,
    method: 'aes-128-gcm',
    password: 'inner-ss-password',
    tls: true,
    sni: 'www.example.com',
    shadowTlsVersion: 3,
    shadowTlsPassword: 'shadowtls-password',
  },
  // 13: an endpoint, not an outbound.
  {
    id: 'wireguard',
    name: 'wireguard',
    type: 'wireguard',
    server: '127.0.0.1',
    port: 19194,
    privateKey: WG_PRIVATE_KEY,
    peerPublicKey: WG_PEER_PUBLIC_KEY,
    preSharedKey: WG_PRE_SHARED_KEY,
    localAddress: ['10.0.0.2/32', 'fd00::2/128'],
    reserved: [1, 2, 3],
    mtu: 1408,
    persistentKeepalive: 25,
  },
  // 14: an endpoint, emitted only while it is the selected node.
  {
    id: 'ovpn-tls-auth',
    name: 'ovpn-tls-auth',
    type: 'openvpn',
    server: '127.0.0.1',
    port: 19195,
    ovpnNetwork: 'udp',
    ovpnCa: OVPN_CA,
    ovpnControlWrapType: 'tls_auth',
    ovpnControlWrapKey: OVPN_STATIC_KEY,
    ovpnControlWrapDirection: 'client',
    username: 'ovpn-user',
    password: 'ovpn-password',
    ovpnDataCiphers: ['AES-256-GCM', 'AES-128-GCM'],
    ovpnAuth: 'SHA256',
  },
  // 15: rejected (not a 32-byte base64 key), but it still takes its tag position.
  {
    id: 'invalid-ss2022-key',
    name: 'invalid-ss2022-key',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19199,
    method: '2022-blake3-aes-256-gcm',
    password: 'not-base64',
  },
  // 16: rejected (missing uuid).
  {
    id: 'invalid-vmess-no-uuid',
    name: 'invalid-vmess-no-uuid',
    type: 'vmess',
    server: '127.0.0.1',
    port: 19193,
  },
  // 17, 18: the same name twice, so the tags become dup and dup-1.
  {
    id: 'dup-a',
    name: 'dup',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19198,
    method: 'aes-128-gcm',
    password: 'dup-password-a',
  },
  {
    id: 'dup-b',
    name: 'dup',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19199,
    method: 'aes-128-gcm',
    password: 'dup-password-b',
  },
];

/** Index of the first fixture with this name. Throws on a typo rather than returning -1. */
export function indexOfNode(name: string): number {
  const index = NODE_FIXTURES.findIndex((n) => n.name === name);
  if (index < 0) throw new Error(`no node fixture named ${name}`);
  return index;
}

/** A deep copy of the fixtures (or of a subset), so no case can alter another's input. */
export function nodeFixtures(names?: string[]): ProxyNode[] {
  const list = names ? names.map((name) => NODE_FIXTURES[indexOfNode(name)]) : NODE_FIXTURES;
  return structuredClone([...list]);
}
