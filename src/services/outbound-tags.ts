import type { ProxyNode } from '../types';

/**
 * Compute the sing-box outbound tag for each node.
 *
 * This MUST stay in sync with `buildOutboundTags` in
 * `shared/config-generator.cjs` so the renderer can address the exact
 * selector outbound names that the generated config uses (needed for live
 * switching via the Clash API).
 */
export function buildOutboundTags(nodes: Pick<ProxyNode, 'tag' | 'name'>[]): string[] {
  const tags: string[] = [];
  const seen = new Map<string, number>();
  nodes.forEach((node, index) => {
    let base = (node && (node.tag || node.name)) || `node-${index}`;
    base = String(base).trim() || `node-${index}`;
    let tag = base;
    if (seen.has(tag)) {
      const count = (seen.get(tag) as number) + 1;
      seen.set(tag, count);
      tag = `${base}-${count}`;
    } else {
      seen.set(tag, 0);
    }
    tags.push(tag);
  });
  return tags;
}

/** Tag for a single node at `index` within `nodes`. */
export function tagForIndex(nodes: Pick<ProxyNode, 'tag' | 'name'>[], index: number): string | null {
  if (index < 0 || index >= nodes.length) return null;
  return buildOutboundTags(nodes)[index];
}
