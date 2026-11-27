import type { ProxyNode } from '../../src/types';
import { nodeFixtures } from './nodes';

/**
 * Transport, Shadowsocks plugin and uTLS shapes (audit P1-8) for the
 * `transport-shapes` generator case. The first twelve are emitted: the snapshot
 * records their transport, plugin and utls blocks, and `sing-box check` proves
 * the core accepts them. Each of the last five would be FATAL to the core, so
 * nodeRejectionReason must leave it out of outbounds and groups.
 *
 * Dummy key material that reaches nothing (the uuid is the one nodes.ts uses),
 * and every server is 127.0.0.1 on a port in 19193-19199, as in nodes.ts. Ids
 * equal names, so the tags are the names. Kept apart from NODE_FIXTURES, which
 * fixes every other snapshot and the run smoke test's node list.
 */

const UUID = nodeFixtures(['vmess-tcp'])[0].uuid as string;

export const TRANSPORT_FIXTURES: readonly ProxyNode[] = [
  // Emitted.
  {
    id: 'vless-httpupgrade',
    name: 'vless-httpupgrade',
    type: 'vless',
    server: '127.0.0.1',
    port: 19193,
    uuid: UUID,
    tls: true,
    sni: 'example.com',
    transportType: 'httpupgrade',
    transportPath: '/upgrade',
    transportHost: 'cdn.example.com',
  },
  {
    id: 'vmess-httpupgrade',
    name: 'vmess-httpupgrade',
    type: 'vmess',
    server: '127.0.0.1',
    port: 19194,
    uuid: UUID,
    alterId: 0,
    security: 'auto',
    transportType: 'httpupgrade',
    transportPath: '/upgrade',
  },
  {
    id: 'trojan-ws-host',
    name: 'trojan-ws-host',
    type: 'trojan',
    server: '127.0.0.1',
    port: 19195,
    password: 'trojan-password',
    tls: true,
    sni: 'example.com',
    transportType: 'ws',
    transportPath: '/ws',
    transportHost: 'cdn.example.com',
  },
  {
    id: 'trojan-grpc',
    name: 'trojan-grpc',
    type: 'trojan',
    server: '127.0.0.1',
    port: 19196,
    password: 'trojan-password',
    tls: true,
    sni: 'example.com',
    transportType: 'grpc',
    transportPath: 'grpc-svc',
  },
  // Stored as an import before 1.5.0 wrote it: `h2` is the http (HTTP/2) transport.
  {
    id: 'vless-stored-h2',
    name: 'vless-stored-h2',
    type: 'vless',
    server: '127.0.0.1',
    port: 19197,
    uuid: UUID,
    tls: true,
    sni: 'example.com',
    transportType: 'h2',
    transportPath: '/h2',
    transportHost: 'h2.example.com',
  },
  // Xray's newer name for TCP: plain TCP, so no transport block.
  {
    id: 'vless-stored-raw',
    name: 'vless-stored-raw',
    type: 'vless',
    server: '127.0.0.1',
    port: 19198,
    uuid: UUID,
    transportType: 'raw',
  },
  {
    id: 'vless-tls-insecure-firefox',
    name: 'vless-tls-insecure-firefox',
    type: 'vless',
    server: '127.0.0.1',
    port: 19199,
    uuid: UUID,
    tls: true,
    sni: 'example.com',
    allowInsecure: true,
    fingerprint: 'firefox',
  },
  // `fp=none` from a vmess link: emitted without utls, which the core refuses for `none`.
  {
    id: 'vmess-fingerprint-none',
    name: 'vmess-fingerprint-none',
    type: 'vmess',
    server: '127.0.0.1',
    port: 19193,
    uuid: UUID,
    alterId: 0,
    security: 'auto',
    tls: true,
    sni: 'example.com',
    fingerprint: 'none',
  },
  {
    id: 'ss-obfs-local-http',
    name: 'ss-obfs-local-http',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19194,
    method: 'aes-128-gcm',
    password: 'ss-password',
    plugin: 'obfs-local',
    pluginOpts: 'obfs=http;obfs-host=www.bing.com',
  },
  {
    id: 'ss-obfs-local-tls',
    name: 'ss-obfs-local-tls',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19195,
    method: 'aes-128-gcm',
    password: 'ss-password',
    plugin: 'obfs-local',
    pluginOpts: 'obfs=tls;obfs-host=www.bing.com',
  },
  {
    id: 'ss-v2ray-plugin-websocket-tls',
    name: 'ss-v2ray-plugin-websocket-tls',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19196,
    method: 'aes-128-gcm',
    password: 'ss-password',
    plugin: 'v2ray-plugin',
    pluginOpts: 'mode=websocket;host=cdn.example.com;path=/ws;tls',
  },
  {
    id: 'ss-v2ray-plugin-quic-tls',
    name: 'ss-v2ray-plugin-quic-tls',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19197,
    method: 'aes-128-gcm',
    password: 'ss-password',
    plugin: 'v2ray-plugin',
    pluginOpts: 'mode=quic;tls;host=cdn.example.com',
  },
  // Rejected: a transport the core lacks ("unknown transport type").
  {
    id: 'vless-xhttp',
    name: 'vless-xhttp',
    type: 'vless',
    server: '127.0.0.1',
    port: 19198,
    uuid: UUID,
    tls: true,
    sni: 'example.com',
    transportType: 'xhttp',
    transportPath: '/xhttp',
  },
  {
    id: 'vmess-kcp',
    name: 'vmess-kcp',
    type: 'vmess',
    server: '127.0.0.1',
    port: 19199,
    uuid: UUID,
    alterId: 0,
    security: 'auto',
    transportType: 'kcp',
  },
  // Rejected: plugin options the core refuses ("unknown obfs mode foo").
  {
    id: 'ss-obfs-foo',
    name: 'ss-obfs-foo',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19193,
    method: 'aes-128-gcm',
    password: 'ss-password',
    plugin: 'obfs-local',
    pluginOpts: 'obfs=foo',
  },
  // Rejected: the core would read this certificate file at startup.
  {
    id: 'ss-v2ray-plugin-cert',
    name: 'ss-v2ray-plugin-cert',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19194,
    method: 'aes-128-gcm',
    password: 'ss-password',
    plugin: 'v2ray-plugin',
    pluginOpts: 'mode=websocket;tls;cert=C:\\awesome-proxy-test\\cert.pem',
  },
  // Rejected: a plugin the core doesn't have ("plugin not found"). The renderer
  // types allow only the two it has, but a stored node is not checked by them.
  {
    id: 'ss-plugin-simple-obfs',
    name: 'ss-plugin-simple-obfs',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19195,
    method: 'aes-128-gcm',
    password: 'ss-password',
    plugin: 'simple-obfs' as unknown as ProxyNode['plugin'],
    pluginOpts: 'obfs=http',
  },
];
