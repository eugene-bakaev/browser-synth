import { describe, it, expect } from 'vitest';
import { generateRoomId, resolveRoomIdFromUrl } from './roomId';

describe('generateRoomId', () => {
  it('returns a 9-character crockford-base32 string', () => {
    const id = generateRoomId();
    expect(id).toMatch(/^[0-9a-z]{9}$/);
  });
});

describe('resolveRoomIdFromUrl', () => {
  it('extracts the room id from /r/<id>', () => {
    const fakeLoc = { pathname: '/r/j7k2mq8n3' } as Location;
    expect(resolveRoomIdFromUrl(fakeLoc)).toBe('j7k2mq8n3');
  });

  it('matches case-insensitively and normalizes to lowercase', () => {
    const fakeLoc = { pathname: '/r/J7K2MQ8N3' } as Location;
    expect(resolveRoomIdFromUrl(fakeLoc)).toBe('j7k2mq8n3');
  });
});
