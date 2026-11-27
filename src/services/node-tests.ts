import type { AppSettings, NodeTestKind, ProxyNode } from '../types';
import { tagForIndex } from './outbound-tags';

/**
 * Node testing, one entry point per kind.
 *
 * The four tests are NOT interchangeable, and the differences drive the UI:
 *
 *   tcp    Direct TCP handshake to the node's host:port. Works while
 *          disconnected, and is safe to run many at a time.
 *   real   Latency of a request actually carried through that outbound, timed
 *          by sing-box via the Clash API. Needs the core running, addresses one
 *          specific outbound by tag, and does not disturb the active selection.
 *   udp    Whether UDP survives the tunnel (SOCKS5 UDP ASSOCIATE + a real DNS
 *          query through the local proxy port).
 *   speed  Download throughput through the local proxy port.
 *
 * udp and speed travel through the LOCAL PROXY PORT, which always follows the
 * `proxy` selector. So testing a specific node means pointing the selector at
 * it, running the probe, then putting the selector back. That briefly redirects
 * live traffic, which is why those two are single-node, sequential, and
 * explicitly labelled as disruptive in the UI.
 */

export interface TestContext {
  nodes: ProxyNode[];
  settings: AppSettings;
  /** Index of the node the user is actually connected through. */
  selectedIndex: number;
  connected: boolean;
  /**
   * "Reconnect to apply" is up: the running core has an older node list or
   * older settings than `nodes` and `settings`, so runNodeTest refuses the
   * tests that go through it (Round 2 follow-up N6). Absent means false.
   */
  pendingApply?: boolean;
}

export interface TestResult {
  kind: NodeTestKind;
  /** Latency in ms for 'tcp' / 'real' / 'udp'. -1 means failed. */
  latency?: number;
  /** Mbps for 'speed'. */
  mbps?: number;
  /** UDP verdict for 'udp'. */
  udpOk?: boolean;
  error?: string;
  /**
   * True when runNodeTest refused to run the test (TestContext.pendingApply).
   * Nothing was measured, so the caller records no result; `error` says why.
   */
  refused?: boolean;
}

/** Why runNodeTest refuses a test that goes through the core while changes are pending. */
export const PENDING_APPLY_REFUSAL =
  'Reconnect to apply first: the running core still has the previous node list or settings, ' +
  'so this test could measure a different node.';

/** Tests that need the core running, because they go through it. */
export function requiresConnection(kind: NodeTestKind): boolean {
  return kind !== 'tcp';
}

/** Tests that temporarily redirect live traffic to the node under test. */
export function isDisruptive(kind: NodeTestKind): boolean {
  return kind === 'udp' || kind === 'speed';
}

export function isSupported(kind: NodeTestKind): boolean {
  const api = window.api?.network;
  if (!api) return false;
  switch (kind) {
    case 'tcp':
      return typeof api.testLatency === 'function';
    case 'real':
      return typeof api.testDelay === 'function';
    case 'udp':
      return typeof api.testUdp === 'function';
    case 'speed':
      return typeof api.testSpeed === 'function';
    default:
      return false;
  }
}

export const TEST_LABELS: Record<NodeTestKind, string> = {
  tcp: 'TCP ping',
  real: 'Real delay',
  udp: 'UDP check',
  speed: 'Speed test',
};

export const TEST_DESCRIPTIONS: Record<NodeTestKind, string> = {
  tcp: 'TCP handshake straight to the server. Works while disconnected, but does not prove the proxy itself works.',
  real: 'Times a real request carried through the node. This is the number that proves a node works end to end.',
  udp: 'Checks whether UDP survives the tunnel. Reveals TCP-only nodes, which break games, QUIC and voice chat.',
  speed: 'Downloads through the tunnel to measure throughput. Takes several seconds and uses real bandwidth.',
};

async function runTcp(node: ProxyNode): Promise<TestResult> {
  const latency = await window.api.network.testLatency(node.server, node.port);
  return { kind: 'tcp', latency };
}

async function runReal(node: ProxyNode, ctx: TestContext): Promise<TestResult> {
  const index = ctx.nodes.findIndex((n) => n.id === node.id);
  const tag = tagForIndex(ctx.nodes, index);
  if (!tag) return { kind: 'real', latency: -1, error: 'Node is not in the active config' };
  const latency = await window.api.network.testDelay!(tag);
  return { kind: 'real', latency };
}

/**
 * Point the `proxy` selector at `node`, run `probe`, then restore the previous
 * selection. The restore runs in a finally block: leaving the user's traffic on
 * a node they didn't choose would be a much worse failure than a lost result.
 */
async function withNodeSelected<T>(
  node: ProxyNode,
  ctx: TestContext,
  probe: () => Promise<T>
): Promise<{ value?: T; error?: string }> {
  const index = ctx.nodes.findIndex((n) => n.id === node.id);
  const targetTag = tagForIndex(ctx.nodes, index);
  if (!targetTag) return { error: 'Node is not in the active config' };

  const previousTag = tagForIndex(ctx.nodes, ctx.selectedIndex);
  const mustSwitch = targetTag !== previousTag;

  if (mustSwitch) {
    const res = await window.api.singbox.select('proxy', targetTag);
    if (!res || !res.success) {
      return { error: (res && res.error) || 'Could not switch to this node' };
    }
  }

  try {
    return { value: await probe() };
  } finally {
    if (mustSwitch && previousTag) {
      await window.api.singbox.select('proxy', previousTag).catch(() => {});
    }
  }
}

async function runUdp(node: ProxyNode, ctx: TestContext): Promise<TestResult> {
  const port = ctx.settings.mixedPort || 7890;
  const { value, error } = await withNodeSelected(node, ctx, () =>
    window.api.network.testUdp!(port)
  );
  if (error) return { kind: 'udp', udpOk: false, latency: -1, error };
  return {
    kind: 'udp',
    udpOk: !!value?.ok,
    latency: value?.ok ? value.ms : -1,
    error: value?.error,
  };
}

async function runSpeed(node: ProxyNode, ctx: TestContext): Promise<TestResult> {
  const port = ctx.settings.mixedPort || 7890;
  const { value, error } = await withNodeSelected(node, ctx, () =>
    window.api.network.testSpeed!(port, { durationMs: 8000 })
  );
  if (error) return { kind: 'speed', mbps: 0, error };
  return { kind: 'speed', mbps: value?.mbps ?? 0, error: value?.error };
}

/**
 * Run one test against one node. Never throws — a failed probe is a normal
 * outcome and comes back as `error` / a -1 latency. A test refused while
 * changes are pending comes back with `refused` and nothing measured.
 */
export async function runNodeTest(
  kind: NodeTestKind,
  node: ProxyNode,
  ctx: TestContext
): Promise<TestResult> {
  if (!window.api) return { kind, error: 'Not available in this build' };
  if (!isSupported(kind)) return { kind, error: `${TEST_LABELS[kind]} is not available here` };
  if (requiresConnection(kind) && !ctx.connected) {
    return { kind, error: `${TEST_LABELS[kind]} needs an active connection` };
  }
  // "Reconnect to apply" is up (Round 2 follow-up N6), typically after a
  // subscription refresh while connected. Every test that goes through the
  // core addresses the node by its tag in ctx.nodes, the current list, and
  // tag suffixes follow list order, so with same-named nodes the tag can name
  // another node in the running core: the result would be stored on the wrong
  // node, and udp and speed would briefly move live traffic onto that one
  // (they also use the current mixed port, which a pending change may have
  // moved). Refuse before any call reaches the core. TCP ping dials the
  // server directly and never touches the core, so it still runs.
  if (requiresConnection(kind) && ctx.pendingApply) {
    return { kind, refused: true, error: PENDING_APPLY_REFUSAL };
  }

  try {
    switch (kind) {
      case 'tcp':
        return await runTcp(node);
      case 'real':
        return await runReal(node, ctx);
      case 'udp':
        return await runUdp(node, ctx);
      case 'speed':
        return await runSpeed(node, ctx);
      default:
        return { kind, error: 'Unknown test' };
    }
  } catch (err: any) {
    return { kind, error: err?.message || String(err) };
  }
}

/**
 * How many probes of this kind may run at once.
 * Disruptive tests are strictly one at a time — they each own the selector.
 */
export function concurrencyFor(kind: NodeTestKind): number {
  return isDisruptive(kind) ? 1 : 8;
}
