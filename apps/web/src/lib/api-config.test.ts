import { describe, expect, it } from 'vitest';
import { API_BASE_URL, apiUrl } from './api-config';

describe('api-config', () => {
  it('exposes a base URL without a trailing slash', () => {
    expect(API_BASE_URL.endsWith('/')).toBe(false);
  });

  it('builds an absolute URL from an absolute path', () => {
    expect(apiUrl('/images/abc/dzi')).toBe(`${API_BASE_URL}/images/abc/dzi`);
  });

  it('adds the leading slash when it is missing', () => {
    expect(apiUrl('images/abc/dzi')).toBe(`${API_BASE_URL}/images/abc/dzi`);
  });

  it('returns an absolute URL unchanged', () => {
    expect(apiUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
    expect(apiUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
  });

  it('returns an uppercase-scheme URL unchanged', () => {
    expect(apiUrl('HTTPS://example.com/a.png')).toBe('HTTPS://example.com/a.png');
  });
});
