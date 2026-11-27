import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_SETTINGS } from '../fixtures/matrix';
import { nodeFixtures } from '../fixtures/nodes';
import { clashClient, generator } from '../helpers/generator';
import { HAS_CORE, portIsFree, startCore, waitFor } from '../helpers/sing-box';

/**
 * Start the real core on a System and a Manual config and talk to its Clash
 * API. `check` passing does not prove the core starts (the generator's
 * comments record fields that pass `check` and then fail at startup); this
 * does, for the two modes that are safe to run: no TUN, no admin rights, no
 * system-proxy change, loopback listeners only. A third run starts System
 * again with a Remote DNS server given by name, whose own name the generator
 * has looked up through remote-dns-bootstrap (1.1.1.1 DoH through the proxy).
 *
 * Ports: mixed inbound 127.0.0.1:17891, controller 19191 (both System runs) /
 * 19192 (Manual); every node fixture points at 127.0.0.1:19193-19199, which the
 * `auto` urltest dials at startup. All of them must be free first.
 */

const MIXED_PORT = 17891;
const NODE_PORTS = [19193, 19194, 19195, 19196, 19197, 19198, 19199];

// Fixtures 1-12 and the dup pair. The WireGuard and OpenVPN endpoints are left
// out because an endpoint dials its server as soon as the core starts.
const RUN_NODES = nodeFixtures().filter(
  (n) => n.type !== 'wireguard' && n.type !== 'openvpn' && !n.id.startsWith('invalid-')
);

const RUNS: { id: string; proxyMode: string; controllerPort: number; remoteDns?: string }[] = [
  { id: 'run-system', proxyMode: 'system', controllerPort: 19191 },
  { id: 'run-manual', proxyMode: 'manual', controllerPort: 19192 },
  // `check` accepts the bootstrap shape; this proves the core starts with it.
  // 19191 again: the runs go one after the other, and run-system has waited
  // for its ports to be free again.
  {
    id: 'run-system-named-remote-dns',
    proxyMode: 'system',
    controllerPort: 19191,
    remoteDns: 'https://dns.google/dns-query',
  },
];

async function eventuallyFree(port: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portIsFree(port)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return portIsFree(port);
}

describe.skipIf(!HAS_CORE)(
  HAS_CORE ? 'sing-box run smoke test' : 'sing-box run — SKIPPED: resources/bin/sing-box.exe not found',
  () => {
    let dir = '';
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awesome-proxy-test-'));
    });
    afterAll(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('runs only outbound fixtures', () => {
      expect(RUN_NODES.map((n) => n.id)).toEqual([
        'vmess-ws-tls',
        'vmess-grpc-utls',
        'vmess-tcp',
        'vless-reality-vision',
        'trojan-tls',
        'ss-aes-256-gcm',
        'ss-2022-blake3-aes-128-gcm',
        'hy2-salamander-hop',
        'hy2-gecko',
        'tuic-v5',
        'anytls',
        'shadowtls-v3',
        'dup-a',
        'dup-b',
      ]);
    });

    for (const run of RUNS) {
      it(`${run.id}: starts, 401 without the secret, 200 with it, stops`, async () => {
        const secret = crypto.randomBytes(32).toString('hex');
        const settings = {
          ...BASE_SETTINGS,
          proxyMode: run.proxyMode,
          mixedPort: MIXED_PORT,
          separatePorts: false,
          allowLan: false,
          coreVersion: '1.14.4',
          cacheFilePath: path.join(dir, `${run.id}-cache.db`),
          clashApi: { port: run.controllerPort, secret },
          ...(run.remoteDns ? { remoteDns: run.remoteDns } : {}),
        };
        const config = generator.generateSingboxConfig(RUN_NODES, 0, settings);

        // Guard rails, before anything starts.
        expect(['system', 'manual']).toContain(settings.proxyMode);
        if (run.remoteDns) {
          const remoteDns = config.dns.servers.find((s: any) => s.tag === 'remote-dns');
          expect(remoteDns.domain_resolver, 'the shape this run is for').toBe('remote-dns-bootstrap');
        }
        expect(config.inbounds.map((i: any) => [i.type, i.listen, i.listen_port])).toEqual([
          ['mixed', '127.0.0.1', MIXED_PORT],
        ]);
        expect(config).not.toHaveProperty('endpoints');
        expect(config.experimental.clash_api.external_controller).toBe(`127.0.0.1:${run.controllerPort}`);
        for (const port of [MIXED_PORT, run.controllerPort, ...NODE_PORTS]) {
          expect(await portIsFree(port), `127.0.0.1:${port} must be free (TCP and UDP)`).toBe(true);
        }

        const log = (message: string) => console.log(`[${run.id}] ${message}`);
        const core = startCore(config, dir);
        try {
          await waitFor(() => core.hasExited() || core.lines.some((l) => l.includes('sing-box started')), 20000);
          const startedLine = core.lines.find((l) => l.includes('sing-box started'));
          expect(Boolean(startedLine) && !core.hasExited(), core.lines.join('\n')).toBe(true);
          log(startedLine!);

          const anonymous = await clashClient.clashRequest('GET', '/proxies/proxy', null, {
            port: run.controllerPort,
          });
          log(`GET /proxies/proxy without the secret -> ${anonymous.statusCode}`);
          expect(anonymous.statusCode).toBe(401);

          const authorised = await clashClient.clashRequest('GET', '/proxies/proxy', null, {
            port: run.controllerPort,
            secret,
          });
          expect(authorised.statusCode).toBe(200);
          const now = JSON.parse(authorised.body).now;
          log(`GET /proxies/proxy with the secret -> ${authorised.statusCode}, now=${now}`);
          expect(now).toBe(config.outbounds.find((o: any) => o.tag === 'proxy').default);
        } finally {
          if (!core.hasExited()) core.child.kill();
          log(`stopped (exit ${String(await core.exited)})`);
        }

        expect(await eventuallyFree(MIXED_PORT), `127.0.0.1:${MIXED_PORT} free again`).toBe(true);
        expect(await eventuallyFree(run.controllerPort), `127.0.0.1:${run.controllerPort} free again`).toBe(true);
      });
    }
  }
);
