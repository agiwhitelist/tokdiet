// src/session.ts — derive stable session identity, repo, and source from a request.
import type { RequestMeta, SessionTracker } from './types.js';

/** Idle gap after which a new session id is minted for the same source+repo key. */
const SESSION_IDLE_MS = 30 * 60 * 1000;

interface SessionEntry {
  id: string;
  lastTs: number;
}

/**
 * Heuristic session tracker.
 *
 * Sessions are keyed by `source:repo`. An explicit `x-ctxgov-session` header
 * always wins. Otherwise a session persists until it has been idle for longer
 * than {@link SESSION_IDLE_MS}, after which a fresh monotonically-numbered id
 * is minted for that key. All state is in-memory and process-local.
 */
export class DefaultSessionTracker implements SessionTracker {
  private readonly sessions = new Map<string, SessionEntry>();
  private counter = 0;

  /** Stable id for the agent session this request belongs to. */
  idFor(meta: RequestMeta, body: unknown): string {
    const explicit = headerValue(meta, 'x-ctxgov-session');
    if (explicit) return explicit;

    const key = `${this.sourceFor(meta)}:${this.repoFor(meta, body)}`;
    const now = Date.now();
    const existing = this.sessions.get(key);

    if (!existing || now - existing.lastTs > SESSION_IDLE_MS) {
      const id = `${key}-${this.counter++}`;
      this.sessions.set(key, { id, lastTs: now });
      return id;
    }

    existing.lastTs = now;
    return existing.id;
  }

  /** Repo / working-dir identifier for per-repo budgets. */
  repoFor(meta: RequestMeta, _body: unknown): string {
    return headerValue(meta, 'x-ctxgov-repo') || 'default';
  }

  /** Originating tool label (claude-code, cursor, codex, ...). */
  sourceFor(meta: RequestMeta): string {
    const explicit = headerValue(meta, 'x-ctxgov-source');
    if (explicit) return explicit;

    const ua = (headerValue(meta, 'user-agent') ?? '').toLowerCase();
    if (ua.includes('claude-code') || ua.includes('claude-cli')) return 'claude-code';
    if (ua.includes('cursor')) return 'cursor';
    if (ua.includes('codex')) return 'codex';
    if (ua.includes('opencode')) return 'opencode';
    if (ua.includes('python')) return 'python-sdk';
    if (ua.includes('node')) return 'node-sdk';
    return 'unknown';
  }
}

/** Read a header value robustly; headers are expected lower-cased but guard regardless. */
function headerValue(meta: RequestMeta, name: string): string | undefined {
  const headers = meta?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const v = (headers as Record<string, unknown>)[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
