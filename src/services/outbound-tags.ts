import type { ProxyNode, SplitRule } from '../types';

/*
 * The renderer's copy of the outbound tag rules in `shared/config-generator.cjs`
 * (its "Outbound Tags" section). The renderer addresses the generated config's
 * outbounds by tag through the Clash API (live node switching, Split rule
 * targets, node tests), so these MUST produce exactly the generator's tags.
 * tests/unit/tags.test.ts enforces the parity; change both copies together.
 *
 * Why the rules exist (audit P0-4): sing-box refuses the whole config when two
 * outbounds share a tag, so a node named like one of the generator's own
 * outbounds, or like another node's de-dup suffix, used to stop the core for
 * every node.
 */

/** The generator's own outbounds. A node named like one is numbered (`direct-1`). */
export const RESERVED_OUTBOUND_TAGS: readonly string[] = ['proxy', 'auto', 'direct'];
export const SPLIT_SELECTOR_TAG_PREFIX = 'split:';
export const SHADOWTLS_HELPER_TAG_PREFIX = 'shadowtls:';
/** Prefixes of the generator's internal outbounds. No node tag starts with one. */
export const INTERNAL_TAG_PREFIXES: readonly string[] = [SPLIT_SELECTOR_TAG_PREFIX, SHADOWTLS_HELPER_TAG_PREFIX];

/**
 * Tag of the selector a Split rule routes through, `split:<rule id>`. The id,
 * not the display name, because a name can equal a node's.
 */
export function splitSelectorTag(rule: Pick<SplitRule, 'id'>): string {
  return SPLIT_SELECTOR_TAG_PREFIX + String(rule.id);
}

/**
 * Compute the sing-box outbound tag for each node: its tag or name, trimmed
 * (`node-<index>` when empty), with `node-` in front when it starts with an
 * internal prefix, and the first free `-N` suffix when it is reserved or taken.
 * Every tag handed out is registered, so `HK`, `HK`, `HK-1` become `HK`,
 * `HK-1`, `HK-1-1`.
 */
export function buildOutboundTags(nodes: Pick<ProxyNode, 'tag' | 'name'>[]): string[] {
  const tags: string[] = [];
  // Every tag handed out so far, plus the generator's own.
  const taken = new Set<string>(RESERVED_OUTBOUND_TAGS);
  // Next suffix to try per base, so HK, HK, HK still gives HK, HK-1, HK-2.
  const nextSuffix = new Map<string, number>();
  nodes.forEach((node, index) => {
    let base = (node && (node.tag || node.name)) || `node-${index}`;
    base = String(base).trim() || `node-${index}`;
    // Keep nodes out of the internal namespace.
    if (INTERNAL_TAG_PREFIXES.some((p) => base.startsWith(p))) base = `node-${base}`;
    let tag = base;
    if (taken.has(tag)) {
      let n = nextSuffix.get(base) || 1;
      while (taken.has(`${base}-${n}`)) n += 1;
      tag = `${base}-${n}`;
      nextSuffix.set(base, n + 1);
    }
    taken.add(tag);
    tags.push(tag);
  });
  return tags;
}

/** Tag for a single node at `index` within `nodes`. */
export function tagForIndex(nodes: Pick<ProxyNode, 'tag' | 'name'>[], index: number): string | null {
  if (index < 0 || index >= nodes.length) return null;
  return buildOutboundTags(nodes)[index];
}
