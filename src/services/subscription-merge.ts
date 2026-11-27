import type { ProxyNode } from '../types';

/**
 * Merging a subscription refresh into the node list (audit P0-3).
 *
 * A refresh used to rebuild the list as `[...others, ...fresh]`: the refreshed
 * subscription's nodes moved to the end with brand-new ids, while the selection
 * was a bare index. Refreshing SubA in `[SubA×10, SubB×10]` with SubA's fourth
 * node selected left index 3 on a SubB node, and the next reconnect routed
 * through a node the user never picked. Here a refresh is applied in place and
 * every node that survives it keeps its id, so a selection held by id
 * (nodeStore's selectedNodeId) follows its node.
 */

/** Written by the node tests at runtime; a refresh never carries them. */
const RUNTIME_FIELDS = ['latency', 'latencyKind', 'lastTested', 'speedMbps', 'udpOk'] as const;

/** The secret that identifies the account, whichever field the protocol keeps it in. */
export function credentialOf(node: ProxyNode): string {
  return node.uuid || node.password || node.privateKey || '';
}

/** The same account on the same server: how a node renamed by its provider is recognised. */
function sameEndpoint(a: ProxyNode, b: ProxyNode): boolean {
  return a.type === b.type && a.server === b.server && a.port === b.port && credentialOf(a) === credentialOf(b);
}

/** JSON with every object's keys sorted, so key order never counts as a difference. */
function sortedKeyJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v
  );
}

/**
 * True when two nodes are the same apart from test results. Keys holding
 * `undefined` count as absent, as they do once the store has saved the node.
 */
export function sameNodeIgnoringRuntime(a: ProxyNode, b: ProxyNode): boolean {
  const strip = (node: ProxyNode) => {
    const copy: Record<string, unknown> = { ...node };
    for (const field of RUNTIME_FIELDS) delete copy[field];
    return copy;
  };
  return sortedKeyJson(strip(a)) === sortedKeyJson(strip(b));
}

/**
 * Merge `fresh`, a subscription's newly fetched nodes, into `current`.
 *
 * Each current node of the subscription is matched to its refreshed twin:
 *   1. by name, in two passes over the fresh nodes of each name:
 *      a. the one with the same type, server, port and credential first, so
 *         two same-named servers the provider swapped keep their ids, and a
 *         selection held by id stays on its server (Round 2 follow-up N3:
 *         pairing by position alone moved it to the other server);
 *      b. then the rest by position: the k-th still unmatched current node
 *         of a name pairs with the k-th still free fresh node of that name,
 *         so duplicate names pair up in list order;
 *   2. then, among the nodes still unmatched, by type, server, port and
 *      credential (compared exactly, first come first served), which catches
 *      a node the provider renamed;
 *   3. a current node left without a twin was removed by the provider and is
 *      dropped. If it was the selected node the selection clears, as it does
 *      when the user deletes the selected node.
 * A twin takes over the current node's id; fresh nodes without a match keep
 * the new ids the fetcher gave them.
 *
 * Placement, so a refresh never reorders anything the user arranged: nodes of
 * other subscriptions, manual nodes and orphaned ones stay exactly where they
 * are; each node of this subscription is replaced at its position by its twin,
 * or removed; the subscription's new nodes go right after its last current
 * node, or at the end when it had none (its first refresh).
 *
 * `changed` is false when the result equals `current` position by position,
 * test results aside. `current` itself is then returned, so an identical
 * refresh writes nothing and keeps the latencies on screen.
 */
export function mergeSubscriptionNodes(
  current: ProxyNode[],
  subscriptionId: string,
  fresh: ProxyNode[]
): { nodes: ProxyNode[]; changed: boolean } {
  const own: number[] = [];
  current.forEach((node, i) => {
    if (node.subscriptionId === subscriptionId) own.push(i);
  });

  // current index -> index into `fresh`
  const twinOf = new Map<number, number>();
  const taken = new Array<boolean>(fresh.length).fill(false);

  // 1. By name. The fresh nodes of each name, in list order.
  const freshByName = new Map<string, number[]>();
  fresh.forEach((node, j) => {
    const group = freshByName.get(node.name);
    if (group) group.push(j);
    else freshByName.set(node.name, [j]);
  });
  // 1a. Within a name, the same endpoint and credential first.
  for (const i of own) {
    const j = freshByName.get(current[i].name)?.find((k) => !taken[k] && sameEndpoint(current[i], fresh[k]));
    if (j !== undefined) {
      twinOf.set(i, j);
      taken[j] = true;
    }
  }
  // 1b. The rest of each name by position, in list order on both sides.
  for (const i of own) {
    if (twinOf.has(i)) continue;
    const j = freshByName.get(current[i].name)?.find((k) => !taken[k]);
    if (j !== undefined) {
      twinOf.set(i, j);
      taken[j] = true;
    }
  }

  // 2. By endpoint and credential, among the still unmatched.
  for (const i of own) {
    if (twinOf.has(i)) continue;
    const j = fresh.findIndex((node, k) => !taken[k] && sameEndpoint(current[i], node));
    if (j >= 0) {
      twinOf.set(i, j);
      taken[j] = true;
    }
  }

  const added = fresh.filter((_, j) => !taken[j]);
  const lastOwn = own.length > 0 ? own[own.length - 1] : -1;
  const nodes: ProxyNode[] = [];
  current.forEach((node, i) => {
    if (node.subscriptionId !== subscriptionId) {
      nodes.push(node);
    } else {
      const j = twinOf.get(i);
      if (j !== undefined) nodes.push({ ...fresh[j], id: node.id });
    }
    if (i === lastOwn) nodes.push(...added);
  });
  if (lastOwn < 0) nodes.push(...added);

  const changed =
    nodes.length !== current.length || nodes.some((node, i) => !sameNodeIgnoringRuntime(node, current[i]));
  return changed ? { nodes, changed } : { nodes: current, changed };
}
