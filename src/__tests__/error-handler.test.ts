/**
 * Tests for handleServerError — Deepgram / server error → user-friendly message
 */

import { describe, it, expect } from 'vitest';
import { handleServerError } from '../glass/settings-manager';

describe('handleServerError', () => {
  describe('API key / authentication errors', () => {
    it('handles UNAUTHORIZED code', () => {
      const msg = handleServerError('UNAUTHORIZED', 'unauthorized access');
      expect(msg).toBe('Transcription service unavailable — check API key');
    });

    it('handles 401 HTTP status code', () => {
      const msg = handleServerError('401', 'Invalid credentials');
      expect(msg).toBe('Transcription service unavailable — check API key');
    });

    it('handles api_key in code', () => {
      const msg = handleServerError('invalid_api_key', 'The API key provided is invalid');
      expect(msg).toBe('Transcription service unavailable — check API key');
    });

    it('handles api key mention in message text (case-insensitive)', () => {
      const msg = handleServerError('AUTH_ERROR', 'API key has expired');
      expect(msg).toBe('Transcription service unavailable — check API key');
    });

    it('handles 403 forbidden', () => {
      const msg = handleServerError('403', 'Forbidden');
      expect(msg).toBe('Transcription service unavailable — check API key');
    });
  });

  describe('quota / rate limit errors', () => {
    it('handles QUOTA_EXCEEDED code', () => {
      const msg = handleServerError('QUOTA_EXCEEDED', 'Daily quota exceeded');
      expect(msg).toBe('Usage limit reached — please try again later');
    });

    it('handles 429 HTTP status', () => {
      const msg = handleServerError('429', 'Too Many Requests');
      expect(msg).toBe('Usage limit reached — please try again later');
    });

    it('handles rate_limit in code', () => {
      const msg = handleServerError('rate_limit', 'Request rate limit reached');
      expect(msg).toBe('Usage limit reached — please try again later');
    });

    it('handles quota in message text (case-insensitive)', () => {
      const msg = handleServerError('ERR', 'Your monthly quota has been exhausted');
      expect(msg).toBe('Usage limit reached — please try again later');
    });
  });

  describe('generic errors', () => {
    it('returns raw message for unknown codes', () => {
      const msg = handleServerError('NETWORK_ERROR', 'Connection timed out');
      expect(msg).toBe('Connection timed out');
    });

    it('returns fallback when message is empty', () => {
      const msg = handleServerError('UNKNOWN', '');
      expect(msg).toBe('An unknown error occurred');
    });

    it('returns raw message for server-side errors', () => {
      const msg = handleServerError('500', 'Internal server error');
      expect(msg).toBe('Internal server error');
    });
  });
});
