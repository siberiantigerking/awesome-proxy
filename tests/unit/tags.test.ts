import { describe, expect, it } from 'vitest';
import {
  buildOutboundTags,
  INTERNAL_TAG_PREFIXES,
  RESERVED_OUTBOUND_TAGS,
  SHADOWTLS_HELPER_TAG_PREFIX,
  SPLIT_SELECTOR_TAG_PREFIX,
  splitSelectorTag,
  tagForIndex,
} from '../../src/services/outbound-tags';
import { COLLISION_CASES } from '../fixtures/matrix';
import { generate, generator } from '../helpers/generator';
import { outboundTags } from '../helpers/invariants';
import { mulberry32, pick } from '../helpers/prng';

/**
 * The renderer computes outbound tags itself (src/services/outbound-tags.ts) to
 * address selectors live through the Clash API, so its copy must match the
 * generator's buildOutboundTags exactly. A mismatch means switching to a node
 * silently selects the wrong one, or fails.
 */

type TagInput = { name?: string; tag?: string };

/** Names that stress the de-dup and fallback rules. `undefined` means "no name". */
const NAME_POOL: (string | undefined)[] = [
  'HK',
  'HK',
  'HK-1',
  'HK-2',
  'JP',
  'JP-1',
  ' JP ',
  'node-0',
  'node-1',
  '',
  ' ',
  '\t',
  undefined,
  '🇭🇰 香港 01',
  '🇭🇰 香港 01',
  '日本-1',
  '日本',
  'proxy',
  'direct',
  'auto',
  'a-b-c',
  // Audit P0-4: the suffixes the reserved names and duplicates turn into, and
  // names inside (or next to) the internal namespaces.
  'proxy-1',
  'HK-1-1',
  'split:openai',
  'split:',
  'shadowtls:X',
  'node-split:openai',
  'X-shadowtls',
];
const TAG_POOL: (string | undefined)[] = [undefined, undefined, undefined, 'custom', 'HK', ' T ', ''];

function randomNodes(rand: () => number): TagInput[] {
  const length = Math.floor(rand() * 16); // 0..15
  return Array.from({ length }, () => {
    const node: TagInput = {};
    const name = pick(rand, NAME_POOL);
    if (name !== undefined) node.name = name;
    const tag = pick(rand, TAG_POOL);
    if (tag !== undefined) node.tag = tag;
    return node;
  });
}

describe('outbound tag parity (renderer vs generator)', () => {
  it('2000 seeded random node lists give identical tags', () => {
    const rand = mulberry32(20261108);
    for (let i = 0; i < 2000; i++) {
      const nodes = randomNodes(rand);
      const renderer = buildOutboundTags(nodes as any);
      const shared = generator.buildOutboundTags(nodes);
      expect(renderer, JSON.stringify(nodes)).toEqual(shared);
      expect(renderer.length).toBe(nodes.length);
    }
  });

  it('common cases', () => {
    const both = (nodes: TagInput[]) => {
      const renderer = buildOutboundTags(nodes as any);
      expect(renderer).toEqual(generator.buildOutboundTags(nodes));
      return renderer;
    };
    expect(both([{ name: 'HK' }, { name: 'HK' }, { name: 'HK' }])).toEqual(['HK', 'HK-1', 'HK-2']);
    expect(both([{ name: ' A ' }, { name: '' }])).toEqual(['A', 'node-1']);
    expect(both([{}, { name: '   ' }])).toEqual(['node-0', 'node-1']);
    expect(both([{ name: 'shown name', tag: 'my-tag' }])).toEqual(['my-tag']);
    expect(both([{ name: '🇭🇰 香港 01' }, { name: '🇭🇰 香港 01' }])).toEqual(['🇭🇰 香港 01', '🇭🇰 香港 01-1']);
    expect(both([])).toEqual([]);
  });

  it('tagForIndex', () => {
    const nodes = [{ name: 'HK' }, { name: 'HK' }, { name: 'JP' }] as any;
    expect(tagForIndex(nodes, 0)).toBe('HK');
    expect(tagForIndex(nodes, 1)).toBe('HK-1');
    expect(tagForIndex(nodes, 2)).toBe('JP');
    expect(tagForIndex(nodes, -1)).toBeNull();
    expect(tagForIndex(nodes, 3)).toBeNull();
    expect(tagForIndex([], 0)).toBeNull();
  });
});

/**
 * buildOutboundTags as it was before Round 2, pasted from the baseline copy of
 * shared/config-generator.cjs (types added). It only registered each BASE, so
 * a suffix could repeat another node's name (HK, HK, HK-1 → HK, HK-1, HK-1)
 * and nothing kept nodes off the generator's own tags.
 */
function legacyBuildOutboundTags(nodes: TagInput[]): string[] {
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

/**
 * Audit P0-4: one node name could stop the core for every node. The rules are
 * written out here rather than read from the modules, so a module that loosened
 * them would fail instead of agreeing with itself.
 */
describe('reserved and namespaced tags (audit P0-4)', () => {
  const RESERVED = ['proxy', 'auto', 'direct'];
  const PREFIXES = ['split:', 'shadowtls:'];
  const isReserved = (tag: string) => RESERVED.includes(tag);
  const isInternal = (tag: string) => PREFIXES.some((p) => tag.startsWith(p));
  const collision = (id: string) => {
    const c = COLLISION_CASES.find((x) => x.id === id);
    if (!c) throw new Error(`no collision case ${id}`);
    return c;
  };

  it('the constants and splitSelectorTag are the same in both copies', () => {
    expect(RESERVED_OUTBOUND_TAGS).toEqual(RESERVED);
    expect(SPLIT_SELECTOR_TAG_PREFIX).toBe('split:');
    expect(SHADOWTLS_HELPER_TAG_PREFIX).toBe('shadowtls:');
    expect(INTERNAL_TAG_PREFIXES).toEqual(PREFIXES);
    expect(generator.RESERVED_OUTBOUND_TAGS).toEqual(RESERVED);
    expect(generator.SPLIT_SELECTOR_TAG_PREFIX).toBe('split:');
    expect(generator.SHADOWTLS_HELPER_TAG_PREFIX).toBe('shadowtls:');
    expect(generator.INTERNAL_TAG_PREFIXES).toEqual(PREFIXES);

    // Rule ids: preset ids, the app's generated ids, and awkward strings.
    const rand = mulberry32(20261109);
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-_:/ .香';
    for (let i = 0; i < 500; i++) {
      const id = Array.from({ length: Math.floor(rand() * 13) }, () => pick(rand, [...chars])).join('');
      expect(splitSelectorTag({ id }), JSON.stringify(id)).toBe(generator.splitSelectorTag({ id }));
      expect(splitSelectorTag({ id })).toBe(`split:${id}`);
    }
  });

  it('every tag is unique, never reserved and never in an internal namespace', () => {
    const rand = mulberry32(20261108);
    for (let i = 0; i < 2000; i++) {
      const nodes = randomNodes(rand);
      const context = JSON.stringify(nodes);
      for (const tags of [generator.buildOutboundTags(nodes) as string[], buildOutboundTags(nodes as any)]) {
        expect(new Set(tags).size, context).toBe(tags.length);
        expect(tags.filter(isReserved), context).toEqual([]);
        expect(tags.filter(isInternal), context).toEqual([]);
      }
    }
  });

  it('no rename: a list whose old tags were already valid keeps exactly those tags', () => {
    // So no working setup loses a cached selector choice or a Split rule's
    // node target when it upgrades.
    const rand = mulberry32(20261108);
    let compared = 0;
    for (let i = 0; i < 2000; i++) {
      const nodes = randomNodes(rand);
      const old = legacyBuildOutboundTags(nodes);
      const valid = new Set(old).size === old.length && !old.some((t) => isReserved(t) || isInternal(t));
      if (!valid) continue;
      compared++;
      expect(generator.buildOutboundTags(nodes), JSON.stringify(nodes)).toEqual(old);
      expect(buildOutboundTags(nodes as any), JSON.stringify(nodes)).toEqual(old);
    }
    expect(compared, 'lists that had valid tags before').toBeGreaterThan(200);
  });

  it('the collisions the audit reproduced', () => {
    const both = (nodes: TagInput[]) => {
      const renderer = buildOutboundTags(nodes as any);
      expect(renderer).toEqual(generator.buildOutboundTags(nodes));
      return renderer;
    };
    expect(both([{ name: 'direct' }, { name: 'proxy' }, { name: 'auto' }])).toEqual(['direct-1', 'proxy-1', 'auto-1']);
    expect(both([{ name: 'HK' }, { name: 'HK' }, { name: 'HK-1' }])).toEqual(['HK', 'HK-1', 'HK-1-1']);
    expect(both([{ name: 'proxy-1' }, { name: 'proxy' }])).toEqual(['proxy-1', 'proxy-2']);
    expect(both([{ name: 'split:openai' }])).toEqual(['node-split:openai']);
  });

  it('ShadowTLS helpers are shadowtls:<tag> and Split selectors split:<rule id>', () => {
    expect(generator.shadowtlsHelperTag('X')).toBe('shadowtls:X');
    expect(generator.splitSelectorTag({ id: 'youtube' })).toBe('split:youtube');

    const helper = generate(collision('collision-shadowtls-helper'));
    expect(outboundTags(helper)).toEqual(['proxy', 'auto', 'X', 'shadowtls:X', 'X-shadowtls', 'direct']);
    expect(helper.outbounds.find((o: any) => o.tag === 'X').detour).toBe('shadowtls:X');

    const split = generate(collision('collision-split-rule-like-node'));
    expect(split.outbounds.find((o: any) => o.tag === 'split:youtube')).toMatchObject({
      type: 'selector',
      outbounds: ['proxy', 'auto', 'direct', 'YouTube'],
      default: 'proxy',
    });
    expect(split.route.rules.filter((r: any) => r.rule_set)).toEqual([
      { rule_set: ['geosite-youtube'], outbound: 'split:youtube' },
    ]);
  });
});
