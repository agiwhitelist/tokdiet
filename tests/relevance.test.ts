// tests/relevance.test.ts — pure relevance & salience helpers.
import { describe, it, expect } from 'vitest';
import {
  extractSalientLines,
  queryTerms,
  relevanceScore,
  looksDurable,
} from '../src/compactor/relevance.js';

describe('extractSalientLines', () => {
  it('picks out error / id / KEY=VALUE / url lines and skips plain prose', () => {
    const text = [
      'Just some ordinary descriptive prose about the weather today.',
      'The quick brown fox jumped over the lazy dog near the river.',
      'ERROR: connection refused while dialing the backend',
      'request failed with code ERR_TIMEOUT after several retries',
      'API_TOKEN=abc123def456',
      'see https://example.com/docs/setup for more details',
      'Nothing interesting on this particular line at all here.',
    ].join('\n');

    const lines = extractSalientLines(text, 10);

    // The four signal-bearing lines are kept...
    expect(lines.some((l) => l.includes('ERROR: connection refused'))).toBe(true);
    expect(lines.some((l) => l.includes('ERR_TIMEOUT'))).toBe(true);
    expect(lines.some((l) => l.includes('API_TOKEN=abc123def456'))).toBe(true);
    expect(lines.some((l) => l.includes('https://example.com/docs/setup'))).toBe(true);

    // ...and the pure prose lines are dropped.
    expect(lines.some((l) => l.includes('weather today'))).toBe(false);
    expect(lines.some((l) => l.includes('quick brown fox'))).toBe(false);
    expect(lines.some((l) => l.includes('Nothing interesting'))).toBe(false);
  });

  it('keeps paths, ports, and big standalone numbers', () => {
    const text = [
      'opened file /var/log/app/server.log for tailing',
      'listening on host 0.0.0.0:8080 now',
      'processed 12345 records in the batch run',
      'windows path C:\\Users\\admin\\config.json loaded',
    ].join('\n');

    const lines = extractSalientLines(text, 10);
    expect(lines.some((l) => l.includes('/var/log/app/server.log'))).toBe(true);
    expect(lines.some((l) => l.includes(':8080'))).toBe(true);
    expect(lines.some((l) => l.includes('12345'))).toBe(true);
    expect(lines.some((l) => l.includes('C:\\Users\\admin\\config.json'))).toBe(true);
  });

  it('respects the max, preserves original order, and de-duplicates', () => {
    const text = [
      'ERROR one',
      'ERROR two',
      'ERROR one', // exact duplicate of the first salient line
      'ERROR three',
      'ERROR four',
    ].join('\n');

    const lines = extractSalientLines(text, 2);
    expect(lines).toEqual(['ERROR one', 'ERROR two']);

    const all = extractSalientLines(text, 10);
    // Duplicate "ERROR one" collapsed -> 4 unique, original order.
    expect(all).toEqual(['ERROR one', 'ERROR two', 'ERROR three', 'ERROR four']);
  });

  it('collapses whitespace and truncates to ~200 chars', () => {
    const long = 'ERROR ' + 'x'.repeat(500);
    const [line] = extractSalientLines('prefix\n' + long, 5);
    expect(line!.length).toBeLessThanOrEqual(200);

    const messy = 'ERROR:    too     many\tspaces   here';
    const [cleaned] = extractSalientLines(messy, 5);
    expect(cleaned).toBe('ERROR: too many spaces here');
  });

  it('is robust to malformed input', () => {
    expect(extractSalientLines('', 5)).toEqual([]);
    // @ts-expect-error wrong type on purpose
    expect(extractSalientLines(null, 5)).toEqual([]);
    expect(extractSalientLines('ERROR x', 0)).toEqual([]);
    // @ts-expect-error wrong type on purpose
    expect(extractSalientLines('ERROR x', NaN)).toEqual([]);
  });
});

describe('queryTerms', () => {
  it('drops stopwords and short prose words, lowercases the rest', () => {
    const terms = queryTerms('What is the database connection timeout for the server?');
    // Kept content words (length >= 4, not stopwords).
    expect(terms.has('database')).toBe(true);
    expect(terms.has('connection')).toBe(true);
    expect(terms.has('timeout')).toBe(true);
    expect(terms.has('server')).toBe(true);
    // Stopwords removed.
    expect(terms.has('what')).toBe(false);
    expect(terms.has('the')).toBe(false);
    expect(terms.has('for')).toBe(false);
    // Short prose word dropped ("is" is length 2).
    expect(terms.has('is')).toBe(false);
  });

  it('keeps short code/number tokens regardless of length', () => {
    const terms = queryTerms('upgrade to v2 and check error 404 on api-key');
    expect(terms.has('v2')).toBe(true); // short but code-ish (has digit)
    expect(terms.has('404')).toBe(true); // number token
    expect(terms.has('api-key')).toBe(true); // hyphenated code token
    expect(terms.has('upgrade')).toBe(true);
    expect(terms.has('check')).toBe(true);
    expect(terms.has('and')).toBe(false); // stopword
  });

  it('drops Russian stopwords', () => {
    const terms = queryTerms('что это за ошибка таймаута соединения');
    expect(terms.has('что')).toBe(false);
    expect(terms.has('это')).toBe(false);
    expect(terms.has('ошибка')).toBe(true);
    expect(terms.has('соединения')).toBe(true);
  });

  it('returns an empty set for empty/malformed input', () => {
    expect(queryTerms('').size).toBe(0);
    // @ts-expect-error wrong type on purpose
    expect(queryTerms(null).size).toBe(0);
  });
});

describe('relevanceScore', () => {
  it('is high when terms overlap the text', () => {
    const terms = queryTerms('database connection timeout server');
    const text = 'The database connection timeout was raised on the server pool.';
    expect(relevanceScore(text, terms)).toBe(1);
  });

  it('is partial for partial overlap', () => {
    const terms = new Set(['alpha', 'beta', 'gamma', 'delta']);
    const text = 'only alpha and beta appear here';
    expect(relevanceScore(text, terms)).toBeCloseTo(0.5, 5);
  });

  it('is 0 when nothing overlaps', () => {
    const terms = queryTerms('database connection timeout');
    expect(relevanceScore('completely unrelated kitten photos', terms)).toBe(0);
  });

  it('is 0 when terms are empty or text is unusable', () => {
    expect(relevanceScore('anything at all', new Set())).toBe(0);
    expect(relevanceScore('', new Set(['alpha']))).toBe(0);
    // @ts-expect-error wrong type on purpose
    expect(relevanceScore(null, new Set(['alpha']))).toBe(0);
    // @ts-expect-error wrong type on purpose
    expect(relevanceScore('alpha', null)).toBe(0);
  });
});

describe('looksDurable', () => {
  it('is true for short KEY=VALUE / credential / id facts', () => {
    expect(looksDurable('API_TOKEN=abc123')).toBe(true);
    expect(looksDurable('DATABASE_URL=postgres://localhost:5432/app')).toBe(true);
    expect(looksDurable('service.endpoint=https://api.example.com')).toBe(true);
    expect(looksDurable('AWS_SECRET_KEY: s3cr3tValue')).toBe(true);
  });

  it('is false for a paragraph of prose even with a stray colon', () => {
    const paragraph =
      'This is a long descriptive paragraph that talks at length about how the ' +
      'system behaves under load and what the operator should expect to see in ' +
      'the dashboard, including notes such as the following observation about ' +
      'latency and throughput trends over the past several weeks of operation, ' +
      'which goes well beyond four hundred characters in total length so that it ' +
      'is unambiguously treated as a paragraph of ordinary prose, not a fact.';
    expect(paragraph.length).toBeGreaterThanOrEqual(400);
    expect(looksDurable(paragraph)).toBe(false);
  });

  it('is false for short plain prose with no key=value', () => {
    expect(looksDurable('the build finished successfully')).toBe(false);
    expect(looksDurable('hello world')).toBe(false);
  });

  it('is robust to malformed input', () => {
    expect(looksDurable('')).toBe(false);
    // @ts-expect-error wrong type on purpose
    expect(looksDurable(null)).toBe(false);
  });
});
