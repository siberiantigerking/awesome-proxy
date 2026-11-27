import { describe, expect, it } from 'vitest';
import {
  credentialOf,
  mergeSubscriptionNodes,
  sameNodeIgnoringRuntime,
} from '../../src/services/subscription-merge';
import type { ProxyNode } from '../../src/types';

/**
 * mergeSubscriptionNodes (audit P0-3): a refresh is applied in place, the nodes
 * that survive it keep their ids, and nothing outside the refreshed
 * subscription moves. Pure, so no mock API is needed. Every node is
 * Shadowsocks on 127.0.0.1; nothing dials them.
 */

let seq = 0;

/** A node as the store holds it. `subscriptionId` undefined = a manual node. */
function node(name: string, subscriptionId: string | undefined, extra: Partial<ProxyNode> = {}): ProxyNode {
  seq += 1;
  return {
    id: `id-${seq}`,
    name,
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19199,
    method: 'aes-256-gcm',
    password: `pw-${name}`,
    ...(subscriptionId === undefined ? {} : { subscriptionId }),
    ...extra,
  };
}

/** A node the provider just added, as the fetcher returns it: a new id. */
function fetched(name: string, subscriptionId: string, extra: Partial<ProxyNode> = {}): ProxyNode {
  return { ...node(name, subscriptionId, extra), id: `fresh-${seq}` };
}

/** An existing node fetched again: the fetcher gives it a new id. */
function refetched(existing: ProxyNode, extra: Partial<ProxyNode> = {}): ProxyNode {
  seq += 1;
  return { ...existing, id: `fresh-${seq}`, ...extra };
}

describe('mergeSubscriptionNodes', () => {
  it('replaces the subscription’s nodes in place and keeps their ids', () => {
    const a1 = node('A1', 'sub-a');
    const manual = node('Manual', undefined);
    const a2 = node('A2', 'sub-a');
    const b1 = node('B1', 'sub-b');
    const current = [a1, manual, a2, b1];
    const fresh = [refetched(a1, { port: 19198 }), refetched(a2, { password: 'rotated' })];

    const { nodes, changed } = mergeSubscriptionNodes(current, 'sub-a', fresh);

    expect(changed).toBe(true);
    expect(nodes).toEqual([{ ...fresh[0], id: a1.id }, manual, { ...fresh[1], id: a2.id }, b1]);
    // Nodes outside the subscription are the very same objects.
    expect(nodes[1]).toBe(manual);
    expect(nodes[3]).toBe(b1);
    // The input list is left alone (the store treats state as immutable).
    expect(current).toEqual([a1, manual, a2, b1]);
  });

  it('pairs duplicate names in list order', () => {
    const hk1 = node('HK', 'sub-a', { port: 19193 });
    const hk2 = node('HK', 'sub-a', { port: 19194 });
    const jp = node('JP', 'sub-a');
    // The provider moved JP between the two HK nodes and changed both HK ports.
    const fresh = [refetched(hk1, { port: 19195 }), refetched(jp), refetched(hk2, { port: 19196 })];

    const { nodes } = mergeSubscriptionNodes([hk1, hk2, jp], 'sub-a', fresh);

    expect(nodes.map((n) => [n.id, n.name, n.port])).toEqual([
      [hk1.id, 'HK', 19195],
      [hk2.id, 'HK', 19196],
      [jp.id, 'JP', 19199],
    ]);
  });

  it('recognises a renamed node by type, server, port and credential', () => {
    const x = node('X', 'sub-a');
    const y = node('Y', 'sub-a', { port: 19198 });
    const renamedX = refetched(x, { name: 'X (renamed)' });
    // Renamed AND a different account: not the same node any more.
    const otherY = refetched(y, { name: 'Y (new account)', password: 'other' });

    const { nodes } = mergeSubscriptionNodes([x, y], 'sub-a', [renamedX, otherY]);

    expect(nodes).toEqual([{ ...renamedX, id: x.id }, otherY]);
  });

  it('matches by name first, and by endpoint only among the nodes still unmatched', () => {
    const a = node('A', 'sub-a', { port: 19193 });
    const b = node('B', 'sub-a', { port: 19194 });
    // A moved onto B's port and password; C took A's old endpoint and password.
    const freshA = refetched(a, { port: 19194, password: b.password });
    const freshC = refetched(a, { name: 'C' });

    const { nodes } = mergeSubscriptionNodes([a, b], 'sub-a', [freshA, freshC]);

    // A pairs by name. B's endpoint now belongs to the fresh A, which is taken,
    // so B has no twin and is dropped. C is new and keeps its new id.
    expect(nodes).toEqual([{ ...freshA, id: a.id }, freshC]);
  });

  it('credentialOf takes the uuid, else the password, else the private key', () => {
    expect(credentialOf(node('n', 's', { uuid: 'u', password: 'p' }))).toBe('u');
    expect(credentialOf(node('n', 's', { password: 'p', privateKey: 'k' }))).toBe('p');
    expect(credentialOf(node('n', 's', { password: undefined, privateKey: 'k' }))).toBe('k');
    expect(credentialOf(node('n', 's', { password: undefined }))).toBe('');
  });

  it('drops a node the provider removed and puts new nodes right after the subscription’s block', () => {
    const [a1, a2, a3] = ['A1', 'A2', 'A3'].map((name) => node(name, 'sub-a'));
    const b1 = node('B1', 'sub-b');
    const a4 = fetched('A4', 'sub-a');
    const a5 = fetched('A5', 'sub-a');

    const { nodes } = mergeSubscriptionNodes([a1, a2, a3, b1], 'sub-a', [refetched(a1), a4, refetched(a3), a5]);

    expect(nodes.map((n) => n.name)).toEqual(['A1', 'A3', 'A4', 'A5', 'B1']);
    expect(nodes.map((n) => n.id)).toEqual([a1.id, a3.id, a4.id, a5.id, b1.id]);
  });

  it('puts new nodes where the last one was when the provider removed that one', () => {
    const a1 = node('A1', 'sub-a');
    const a2 = node('A2', 'sub-a');
    const b1 = node('B1', 'sub-b');

    const { nodes } = mergeSubscriptionNodes([a1, a2, b1], 'sub-a', [refetched(a1), fetched('A9', 'sub-a')]);

    expect(nodes.map((n) => n.name)).toEqual(['A1', 'A9', 'B1']);
  });

  it('appends a first refresh at the end, with the fetcher’s ids', () => {
    const manual = node('Manual', undefined);
    const b1 = node('B1', 'sub-b');
    const fresh = [fetched('A1', 'sub-a'), fetched('A2', 'sub-a')];

    const { nodes, changed } = mergeSubscriptionNodes([manual, b1], 'sub-a', fresh);

    expect(changed).toBe(true);
    expect(nodes).toEqual([manual, b1, ...fresh]);
  });

  it('leaves other subscriptions’, manual and orphaned nodes untouched and in place', () => {
    const m1 = node('M1', undefined);
    const a1 = node('A1', 'sub-a');
    const orphan = node('O1', 'sub-deleted');
    const b1 = node('B1', 'sub-b');
    const a2 = node('A2', 'sub-a');
    const m2 = node('M2', undefined);
    const fresh = [refetched(a2, { port: 19195 }), refetched(a1, { port: 19196 }), fetched('A3', 'sub-a')];

    const { nodes } = mergeSubscriptionNodes([m1, a1, orphan, b1, a2, m2], 'sub-a', fresh);

    expect(nodes.map((n) => n.name)).toEqual(['M1', 'A1', 'O1', 'B1', 'A2', 'A3', 'M2']);
    expect(nodes[0]).toBe(m1);
    expect(nodes[2]).toBe(orphan);
    expect(nodes[3]).toBe(b1);
    expect(nodes[6]).toBe(m2);
    expect(nodes[1]).toMatchObject({ id: a1.id, port: 19196 });
    expect(nodes[4]).toMatchObject({ id: a2.id, port: 19195 });
  });

  it('an identical refresh is unchanged: the same array comes back, test results kept', () => {
    const a1: ProxyNode = {
      ...node('A1', 'sub-a'),
      latency: 120,
      latencyKind: 'real',
      lastTested: 1_700_000_000_000,
      speedMbps: 42.5,
      udpOk: true,
    };
    const b1 = node('B1', 'sub-b');
    const a2 = node('A2', 'sub-a');
    const current = [a1, b1, a2];
    // As the fetcher returns them: new ids, no test results, keys in another
    // order, `country: undefined` where the saved node has no key at all, and
    // the provider's own order.
    const asFetched = ({ id, latency, latencyKind, lastTested, speedMbps, udpOk, ...rest }: ProxyNode): ProxyNode =>
      ({ country: undefined, ...Object.fromEntries(Object.entries(rest).reverse()), id: `fresh-${id}` }) as ProxyNode;

    const result = mergeSubscriptionNodes(current, 'sub-a', [asFetched(a2), asFetched(a1)]);

    expect(result.changed).toBe(false);
    expect(result.nodes).toBe(current);
    expect(result.nodes[0]).toMatchObject({ latency: 120, latencyKind: 'real', speedMbps: 42.5, udpOk: true });
  });

  it('the audit example: refreshing SubA in [SubA×10, SubB×10] keeps the selected node at index 3 and SubB in place', () => {
    const subA = Array.from({ length: 10 }, (_, i) => node(`A${i}`, 'sub-a'));
    const subB = Array.from({ length: 10 }, (_, i) => node(`B${i}`, 'sub-b'));
    const current = [...subA, ...subB];
    const selectedId = current[3].id; // a SubA node
    // The provider returns SubA in reverse order, with every password rotated.
    const fresh = [...subA].reverse().map((n) => refetched(n, { password: `rotated-${n.name}` }));

    const { nodes, changed } = mergeSubscriptionNodes(current, 'sub-a', fresh);

    expect(changed).toBe(true);
    expect(nodes.findIndex((n) => n.id === selectedId)).toBe(3);
    expect(nodes[3]).toMatchObject({ name: 'A3', password: 'rotated-A3' });
    // SubB doesn't move to the front: same objects, same positions.
    expect(nodes.slice(10)).toEqual(subB);
    nodes.slice(10).forEach((n, i) => expect(n).toBe(subB[i]));
    // What the old `[...others, ...fresh]` did: index 3 became a SubB node.
    const before = [...current.filter((n) => n.subscriptionId !== 'sub-a'), ...fresh];
    expect(before[3].subscriptionId).toBe('sub-b');
  });
});

describe('mergeSubscriptionNodes with same-named nodes (Round 2 follow-up N3)', () => {
  it('two same-named nodes the provider swapped keep their ids on the same servers', () => {
    const hk1 = node('HK', 'sub-a', { port: 19193 });
    const hk2 = node('HK', 'sub-a', { port: 19194 });
    // The provider lists the same two servers the other way round.
    const swapped = mergeSubscriptionNodes([hk1, hk2], 'sub-a', [refetched(hk2), refetched(hk1)]);

    expect(swapped.nodes.map((n) => [n.id, n.port])).toEqual([
      [hk1.id, 19193],
      [hk2.id, 19194],
    ]);
    // Every id has the node it had, so the refresh changes nothing.
    expect(swapped.changed).toBe(false);

    // Two accounts on one server, swapped: told apart by the credential.
    const a = node('HK', 'sub-a', { password: 'pw-1' });
    const b = node('HK', 'sub-a', { password: 'pw-2' });
    const accounts = mergeSubscriptionNodes([a, b], 'sub-a', [refetched(b), refetched(a)]);

    expect(accounts.nodes.map((n) => [n.id, n.password])).toEqual([
      [a.id, 'pw-1'],
      [b.id, 'pw-2'],
    ]);
  });

  it('pairs the endpoint twin first and the rest of the name by position', () => {
    const hk1 = node('HK', 'sub-a', { port: 19193 });
    const hk2 = node('HK', 'sub-a', { port: 19194 });
    const hk3 = node('HK', 'sub-a', { port: 19195 });
    // hk3's server is unchanged and now listed first. hk1's server rotated its
    // password and hk2's moved to another port, so nothing identifies those
    // two any more; a fourth HK server is new.
    const fresh = [
      refetched(hk3),
      refetched(hk1, { password: 'rotated' }),
      refetched(hk2, { port: 19197 }),
      fetched('HK', 'sub-a', { port: 19198 }),
    ];

    const { nodes } = mergeSubscriptionNodes([hk1, hk2, hk3], 'sub-a', fresh);

    // By position alone hk1 would have taken hk3's server.
    expect(nodes.map((n) => [n.id, n.port, n.password])).toEqual([
      [hk1.id, 19193, 'rotated'],
      [hk2.id, 19197, 'pw-HK'],
      [hk3.id, 19195, 'pw-HK'],
      [fresh[3].id, 19198, 'pw-HK'],
    ]);
  });

  it('a selection held by id stays on its server', () => {
    const hk1 = node('HK', 'sub-a', { port: 19193 });
    const hk2 = node('HK', 'sub-a', { port: 19194 });
    const jp = node('JP', 'sub-a');
    const current = [hk1, hk2, jp];
    const selectedId = hk2.id; // the user picked the HK server on 19194
    // The provider puts JP first with a new port, and lists the HK servers the
    // other way round.
    const fresh = [refetched(jp, { port: 19198 }), refetched(hk2), refetched(hk1)];

    const { nodes, changed } = mergeSubscriptionNodes(current, 'sub-a', fresh);

    expect(changed).toBe(true);
    // nodeStore holds the selection by id (selectedNodeId) and recomputes the
    // index from it, so the selection is wherever this id ends up.
    expect(nodes.findIndex((n) => n.id === selectedId)).toBe(1);
    expect(nodes.find((n) => n.id === selectedId)).toMatchObject({ name: 'HK', server: '127.0.0.1', port: 19194 });
  });
});

describe('sameNodeIgnoringRuntime', () => {
  it('ignores test results, key order and keys that hold undefined', () => {
    const plain = node('A', 'sub-a');
    const tested: ProxyNode = { ...plain, latency: 80, latencyKind: 'tcp', lastTested: 1, speedMbps: 3, udpOk: false };
    const reordered = Object.fromEntries(Object.entries(plain).reverse()) as unknown as ProxyNode;
    expect(sameNodeIgnoringRuntime(plain, tested)).toBe(true);
    expect(sameNodeIgnoringRuntime(plain, reordered)).toBe(true);
    expect(sameNodeIgnoringRuntime(plain, { ...plain, country: undefined })).toBe(true);
  });

  it('sees every other field, the id included', () => {
    const plain = node('A', 'sub-a');
    expect(sameNodeIgnoringRuntime(plain, { ...plain, id: 'other' })).toBe(false);
    expect(sameNodeIgnoringRuntime(plain, { ...plain, port: 19198 })).toBe(false);
    expect(sameNodeIgnoringRuntime(plain, { ...plain, country: 'HK' })).toBe(false);
    expect(sameNodeIgnoringRuntime(plain, { ...plain, serverPorts: ['19196:19198'] })).toBe(false);
  });
});
