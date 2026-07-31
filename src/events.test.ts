import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_KINDS,
  SSEParser,
  TrafficStreamError,
  matchesFilters,
  parseTrafficEvent,
  streamTrafficEvents,
  type TrafficEvent,
} from './events';

/**
 * The wire fixtures below are the real framing the facilitator emits, captured
 * from https://facilitator.ultravioletadao.xyz/events on 2026-07-28 (v1.59.5):
 * an `event:` name that IS the operation, a JSON `data:` line, and bare `:`
 * comments as keepalives on an idle rail.
 *
 * The keepalive case matters more than it looks: on a quiet rail (measured ~1.3
 * settles/min, with 35-minute stretches of nothing) those comments are the ONLY
 * thing on the wire, so a parser that treats them as data breaks in production
 * and nowhere else.
 */
const SETTLE_FRAME =
  'event: settle\n' +
  'data: {"ts":1785256783513,"kind":"settle","network":"base","ok":true,' +
  '"payer":"0x87228cF28dd82546d76249A8Bb92AdEa9258F404","tx":"0xdeadbeef",' +
  '"amount":"100000","asset":"0x8335"}\n' +
  '\n';

const VERIFY_FRAME =
  'event: verify\n' +
  'data: {"ts":1785256783000,"kind":"verify","network":"skale-base","ok":false,"payer":"0xabc"}\n' +
  '\n';

const KEEPALIVES = ':\n\n:\n\n:\n\n';

const anEvent = (network: string, kind = 'settle'): TrafficEvent => ({
  ts: 1785256783513,
  kind,
  network,
  ok: true,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SSEParser', () => {
  it('parses a settle frame', () => {
    const frames = new SSEParser().push(SETTLE_FRAME);
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('settle');
  });

  it('treats keepalive comments as nothing, not as events', () => {
    expect(new SSEParser().push(KEEPALIVES)).toEqual([]);
  });

  it('survives minutes of keepalives and still delivers the next event', () => {
    const frames = new SSEParser().push(KEEPALIVES + SETTLE_FRAME + KEEPALIVES);
    expect(frames.map((f) => f.event)).toEqual(['settle']);
  });

  it('reassembles a frame split across chunks', () => {
    // TCP does not respect message boundaries; a frame arriving in two reads is
    // normal, not exotic.
    const parser = new SSEParser();
    const half = Math.floor(SETTLE_FRAME.length / 2);
    expect(parser.push(SETTLE_FRAME.slice(0, half))).toEqual([]);
    expect(parser.push(SETTLE_FRAME.slice(half))).toHaveLength(1);
  });

  it('ignores id and retry fields instead of choking on them', () => {
    const frames = new SSEParser().push('id: 7\nretry: 3000\n' + SETTLE_FRAME);
    expect(frames).toHaveLength(1);
  });

  it('strips carriage returns so they never land inside the JSON', () => {
    const frames = new SSEParser().push(SETTLE_FRAME.replace(/\n/g, '\r\n'));
    expect(frames[0].data.startsWith('{')).toBe(true);
  });
});

describe('parseTrafficEvent', () => {
  const frameOf = (wire: string) => new SSEParser().push(wire)[0];

  it('decodes a settle, which carries a tx', () => {
    const event = parseTrafficEvent(frameOf(SETTLE_FRAME));
    expect(event).not.toBeNull();
    expect(event!.kind).toBe('settle');
    expect(event!.network).toBe('base');
    expect(event!.tx).toBe('0xdeadbeef');
  });

  it('decodes a verify, which has no tx because nothing settled yet', () => {
    const event = parseTrafficEvent(frameOf(VERIFY_FRAME));
    expect(event!.kind).toBe('verify');
    expect(event!.tx).toBeUndefined();
    expect(event!.ok).toBe(false);
  });

  it('reads ts as epoch MILLIS', () => {
    // Reading it as seconds lands in the year 58,000 -- and silently.
    const event = parseTrafficEvent(frameOf(SETTLE_FRAME));
    expect(new Date(event!.ts).getUTCFullYear()).toBe(2026);
  });

  it('parses minimal-detail events, where every optional field is omitted', () => {
    const event = parseTrafficEvent({
      event: 'settle',
      data: '{"ts":1785256783513,"kind":"settle","network":"base","ok":true}',
    });
    expect(event).not.toBeNull();
    expect(event!.payer).toBeUndefined();
    expect(event!.amount).toBeUndefined();
  });

  it('returns null for a malformed frame instead of throwing', () => {
    // One bad message must never tear down a long-lived connection.
    expect(parseTrafficEvent({ event: 'settle', data: 'not json' })).toBeNull();
    expect(parseTrafficEvent({ event: 'settle', data: '[1,2,3]' })).toBeNull();
    expect(parseTrafficEvent({ event: 'settle', data: '{"ts":"nope"}' })).toBeNull();
  });
});

describe('matchesFilters', () => {
  it('keeps and drops by network', () => {
    const opts = { networks: ['base', 'polygon'] };
    expect(matchesFilters(anEvent('base'), opts)).toBe(true);
    expect(matchesFilters(anEvent('celo'), opts)).toBe(false);
  });

  it('matches the canonical slug, not the inbound alias', () => {
    // 'skale' is accepted when you SEND it, but events always say 'skale-base'.
    // Keying on the alias silently drops every SKALE event -- this exact bug hit
    // the KarmaCadabra observatory.
    expect(matchesFilters(anEvent('skale-base'), { networks: ['skale-base'] })).toBe(true);
    expect(matchesFilters(anEvent('skale-base'), { networks: ['skale'] })).toBe(false);
  });

  it('filters by kind', () => {
    expect(matchesFilters(anEvent('base', 'settle'), { kinds: ['settle'] })).toBe(true);
    expect(matchesFilters(anEvent('base', 'verify'), { kinds: ['settle'] })).toBe(false);
  });

  it('lets everything through when no filter is set', () => {
    expect(matchesFilters(anEvent('anything'), {})).toBe(true);
  });
});

/** Minimal ReadableStream over a list of string chunks. */
function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
}

describe('streamTrafficEvents', () => {
  it('yields the events on the wire and stops when the server closes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(bodyOf([KEEPALIVES, SETTLE_FRAME, VERIFY_FRAME]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
    );

    const seen: TrafficEvent[] = [];
    for await (const event of streamTrafficEvents()) seen.push(event);

    expect(seen.map((e) => e.kind)).toEqual(['settle', 'verify']);
  });

  it('applies client-side filters, since the server has none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(bodyOf([SETTLE_FRAME, VERIFY_FRAME]), { status: 200 }))
    );

    const seen: TrafficEvent[] = [];
    for await (const event of streamTrafficEvents({ kinds: ['settle'] })) seen.push(event);

    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('settle');
  });

  it('throws a typed 404 when the operator disabled the stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('events stream disabled', { status: 404 }))
    );

    await expect(streamTrafficEvents().next()).rejects.toMatchObject({
      name: 'TrafficStreamError',
      status: 404,
    });
  });

  it('surfaces Retry-After when shed at subscriber capacity', async () => {
    // 503 here is admission control, not an outage -- a caller that retries
    // immediately just burns its rate-limit budget.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('events stream at capacity', {
          status: 503,
          headers: { 'retry-after': '30' },
        })
      )
    );

    try {
      await streamTrafficEvents().next();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TrafficStreamError);
      expect((error as TrafficStreamError).status).toBe(503);
      expect((error as TrafficStreamError).retryAfter).toBe(30);
    }
  });

  it('requests text/event-stream and honours a custom facilitator url', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(bodyOf([SETTLE_FRAME]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    // Trailing slash must not produce a double slash in the path.
    for await (const _ of streamTrafficEvents({ facilitatorUrl: 'https://example.com/' })) {
      // drain
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/events',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'text/event-stream' }),
      })
    );
  });
});

describe('EVENT_KINDS', () => {
  it('matches what the facilitator publishes', () => {
    expect(EVENT_KINDS).toEqual(['verify', 'settle']);
  });
});

/**
 * Fields added 2026-07-30 so an event says WHAT was bought, not just how much.
 */
describe('richer settle metadata', () => {
  const WIRE =
    'event: settle\n' +
    'data: {"ts":1785432522148,"kind":"settle","network":"base","ok":true,' +
    '"payer":"0xe4dc","tx":"0xd8c1","amount":"1000000","asset":"0x8335",' +
    '"resource":"https://api.example.com/premium","payTo":"0xseller",' +
    '"description":"Premium feed","scheme":"exact"}\n\n';

  it('parses the endpoint, the seller and the scheme', () => {
    const event = parseTrafficEvent(new SSEParser().push(WIRE)[0]);
    expect(event!.resource).toBe('https://api.example.com/premium');
    expect(event!.payTo).toBe('0xseller');
    expect(event!.scheme).toBe('exact');
  });

  it('still parses events that predate these fields', () => {
    // minimal detail mode, and any consumer pointed at an older facilitator.
    const event = parseTrafficEvent({
      event: 'settle',
      data: '{"ts":1,"kind":"settle","network":"base","ok":true}',
    });
    expect(event).not.toBeNull();
    expect(event!.resource).toBeUndefined();
    expect(event!.payTo).toBeUndefined();
  });
});

/** Facilitator v1.63.0+: errored operations, when the operator enables them. */
describe('failure category', () => {
  it('parses the bounded category', () => {
    const event = parseTrafficEvent({
      event: 'settle',
      data: '{"ts":1,"kind":"settle","network":"base","ok":false,"error":"contract_revert"}',
    });
    expect(event!.error).toBe('contract_revert');
    expect(event!.ok).toBe(false);
  });

  it('distinguishes resolved-negative from blew-up', () => {
    // ok:false alone means the operation resolved and came back negative.
    const resolved = parseTrafficEvent({
      event: 'settle',
      data: '{"ts":1,"kind":"settle","network":"base","ok":false}',
    });
    expect(resolved!.error).toBeUndefined();
  });
});
