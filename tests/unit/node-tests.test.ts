import { afterEach, describe, expect, it, vi } from 'vitest';
import { runNodeTest, type TestContext } from '../../src/services/node-tests';
import type { AppSettings, NodeTestKind, ProxyNode } from '../../src/types';
import { installMockApi } from '../helpers/mock-api';

/**
 * src/services/node-tests.ts over a mocked window.api. While "Reconnect to
 * apply" is up (Round 2 follow-up N6) the tests that go through the core are
 * refused before any call reaches it, because they address the node by its
 * tag in the current list, which the running core may not have. TCP ping
 * dials the server directly and still runs. Nothing is dialled: every probe
 * goes to the mock.
 */

/** Two same-named nodes on loopback, so the second one's tag carries a suffix (HK-1). */
const NODES: ProxyNode[] = [
  { id: 'node-a', name: 'HK', type: 'shadowsocks', server: '127.0.0.1', port: 19191, method: 'aes-256-gcm', password: 'pw-a' },
  { id: 'node-b', name: 'HK', type: 'shadowsocks', server: '127.0.0.1', port: 19192, method: 'aes-256-gcm', password: 'pw-b' },
];

/** Connected through the first node, nothing pending, unless `patch` says otherwise. */
function context(patch: Partial<TestContext> = {}): TestContext {
  return {
    nodes: NODES,
    settings: { mixedPort: 7890 } as AppSettings,
    selectedIndex: 0,
    connected: true,
    ...patch,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runNodeTest while "Reconnect to apply" is up (N6)', () => {
  it.each<NodeTestKind>(['real', 'udp', 'speed'])('refuses %s before any call reaches the core', async (kind) => {
    const { api } = installMockApi();

    const result = await runNodeTest(kind, NODES[1], context({ pendingApply: true }));

    expect(result).toEqual({ kind, refused: true, error: expect.stringMatching(/^Reconnect to apply first/) });
    expect(api.network.testDelay).not.toHaveBeenCalled();
    expect(api.network.testUdp).not.toHaveBeenCalled();
    expect(api.network.testSpeed).not.toHaveBeenCalled();
    expect(api.network.testLatency).not.toHaveBeenCalled();
    // udp and speed would have moved the `proxy` selector onto the node first.
    expect(api.singbox.select).not.toHaveBeenCalled();
    expect(api.singbox.getSelection).not.toHaveBeenCalled();
  });

  it('still runs TCP ping, which dials the server directly', async () => {
    const { api } = installMockApi();
    api.network.testLatency.mockResolvedValueOnce(42);

    const result = await runNodeTest('tcp', NODES[1], context({ pendingApply: true }));

    expect(result).toEqual({ kind: 'tcp', latency: 42 });
    expect(result.refused).toBeUndefined();
    expect(api.network.testLatency).toHaveBeenCalledWith('127.0.0.1', 19192);
  });

  it('without a connection, gives the missing connection as the reason, as before', async () => {
    const { api } = installMockApi();

    const result = await runNodeTest('real', NODES[1], context({ connected: false, pendingApply: true }));

    expect(result).toEqual({ kind: 'real', error: 'Real delay needs an active connection' });
    expect(result.refused).toBeUndefined();
    expect(api.network.testDelay).not.toHaveBeenCalled();
  });
});

describe('runNodeTest with nothing pending', () => {
  it('runs Real delay through the node’s own tag', async () => {
    const { api } = installMockApi();
    api.network.testDelay.mockResolvedValueOnce(87);

    const result = await runNodeTest('real', NODES[1], context());

    expect(result).toEqual({ kind: 'real', latency: 87 });
    expect(result.refused).toBeUndefined();
    expect(api.network.testDelay).toHaveBeenCalledTimes(1);
    expect(api.network.testDelay).toHaveBeenCalledWith('HK-1');
  });
});
