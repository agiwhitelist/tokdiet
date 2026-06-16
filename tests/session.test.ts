// tests/session.test.ts — session identity + event bus behavior.
import { describe, it, expect } from 'vitest';
import { DefaultSessionTracker } from '../src/session.js';
import { InProcessEventBus } from '../src/events.js';
import type { RequestMeta, GovernorEvent } from '../src/types.js';

function meta(headers: Record<string, string>): RequestMeta {
  return { method: 'POST', path: '/v1/messages', headers };
}

describe('DefaultSessionTracker', () => {
  it('returns the same session id for two quick calls with same source/repo', () => {
    const t = new DefaultSessionTracker();
    const m = meta({ 'user-agent': 'claude-code/1.0', 'x-ctxgov-repo': 'acme' });
    const a = t.idFor(m, {});
    const b = t.idFor(m, {});
    expect(a).toBe(b);
  });

  it('respects an explicit x-ctxgov-session header', () => {
    const t = new DefaultSessionTracker();
    const m = meta({ 'x-ctxgov-session': 'fixed-123', 'user-agent': 'cursor/2' });
    expect(t.idFor(m, {})).toBe('fixed-123');
    expect(t.idFor(m, {})).toBe('fixed-123');
  });

  it('mints distinct ids for different source/repo keys', () => {
    const t = new DefaultSessionTracker();
    const a = t.idFor(meta({ 'user-agent': 'claude-code', 'x-ctxgov-repo': 'r1' }), {});
    const b = t.idFor(meta({ 'user-agent': 'cursor', 'x-ctxgov-repo': 'r1' }), {});
    const c = t.idFor(meta({ 'user-agent': 'claude-code', 'x-ctxgov-repo': 'r2' }), {});
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('maps a claude-code user-agent to source claude-code', () => {
    const t = new DefaultSessionTracker();
    expect(t.sourceFor(meta({ 'user-agent': 'Claude-Code/1.2.3' }))).toBe('claude-code');
    expect(t.sourceFor(meta({ 'user-agent': 'claude-cli/0.1' }))).toBe('claude-code');
  });

  it('maps other known user-agents and falls back to unknown', () => {
    const t = new DefaultSessionTracker();
    expect(t.sourceFor(meta({ 'user-agent': 'Cursor/0.4' }))).toBe('cursor');
    expect(t.sourceFor(meta({ 'user-agent': 'codex-cli' }))).toBe('codex');
    expect(t.sourceFor(meta({ 'user-agent': 'opencode/1' }))).toBe('opencode');
    expect(t.sourceFor(meta({ 'user-agent': 'python-requests/2.31' }))).toBe('python-sdk');
    expect(t.sourceFor(meta({ 'user-agent': 'node-fetch/3' }))).toBe('node-sdk');
    expect(t.sourceFor(meta({ 'user-agent': 'mystery/9' }))).toBe('unknown');
    expect(t.sourceFor(meta({}))).toBe('unknown');
  });

  it('honors an explicit x-ctxgov-source over the user-agent', () => {
    const t = new DefaultSessionTracker();
    expect(t.sourceFor(meta({ 'x-ctxgov-source': 'custom-tool', 'user-agent': 'cursor' }))).toBe('custom-tool');
  });

  it('defaults repo to "default" when no header present', () => {
    const t = new DefaultSessionTracker();
    expect(t.repoFor(meta({ 'user-agent': 'codex' }), {})).toBe('default');
    expect(t.repoFor(meta({ 'x-ctxgov-repo': 'my-repo' }), {})).toBe('my-repo');
  });
});

describe('InProcessEventBus', () => {
  const sample: GovernorEvent = { type: 'log', payload: { level: 'info', message: 'hi' } };

  it('delivers emitted events to a subscribed listener', () => {
    const bus = new InProcessEventBus();
    const received: GovernorEvent[] = [];
    bus.subscribe((e) => received.push(e));
    bus.emit(sample);
    expect(received).toEqual([sample]);
  });

  it('stops delivery after unsubscribe', () => {
    const bus = new InProcessEventBus();
    const received: GovernorEvent[] = [];
    const off = bus.subscribe((e) => received.push(e));
    bus.emit(sample);
    off();
    bus.emit(sample);
    expect(received).toHaveLength(1);
  });

  it('a throwing listener does not block others', () => {
    const bus = new InProcessEventBus();
    const received: GovernorEvent[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => received.push(e));
    expect(() => bus.emit(sample)).not.toThrow();
    expect(received).toEqual([sample]);
  });
});
