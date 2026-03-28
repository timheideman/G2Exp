/**
 * Tests for SessionLabels — temporary speaker labels and name resolution
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionLabels } from '../glass/session-labels';

describe('SessionLabels', () => {
  let labels: SessionLabels;

  beforeEach(() => {
    labels = new SessionLabels();
  });

  describe('default labels', () => {
    it('returns letter for unknown speaker', () => {
      expect(labels.getDisplayName(0)).toBe('Speaker A');
      expect(labels.getDisplayName(1)).toBe('Speaker B');
      expect(labels.getDisplayName(2)).toBe('Speaker C');
    });

    it('returns short letter tag', () => {
      expect(labels.getShortTag(0)).toBe('A');
      expect(labels.getShortTag(1)).toBe('B');
    });

    it('returns empty string for system messages (speaker -1)', () => {
      expect(labels.getDisplayName(-1)).toBe('');
      expect(labels.getShortTag(-1)).toBe('');
    });
  });

  describe('session labels (temporary)', () => {
    it('sets and retrieves a session label', () => {
      labels.setLabel(0, 'Doctor');
      expect(labels.getDisplayName(0)).toBe('Doctor');
    });

    it('session label overrides default letter', () => {
      labels.setLabel(1, 'Cashier');
      expect(labels.getDisplayName(1)).toBe('Cashier');
      // Other speakers unaffected
      expect(labels.getDisplayName(0)).toBe('Speaker A');
    });

    it('short tag truncates long labels', () => {
      labels.setLabel(0, 'Receptionist');
      expect(labels.getShortTag(0)).toBe('Recepti.');
    });

    it('removes a session label', () => {
      labels.setLabel(0, 'Doctor');
      labels.removeLabel(0);
      expect(labels.getDisplayName(0)).toBe('Speaker A');
    });
  });

  describe('identified names (from voiceprint)', () => {
    it('identified name takes priority over session label', () => {
      labels.setLabel(0, 'Doctor');
      labels.setIdentified(0, 'Sarah van Berg');
      expect(labels.getDisplayName(0)).toBe('Sarah van Berg');
    });

    it('identified name takes priority over default letter', () => {
      labels.setIdentified(2, 'Marco');
      expect(labels.getDisplayName(2)).toBe('Marco');
    });

    it('short tag uses first name', () => {
      labels.setIdentified(0, 'Sarah van Berg');
      expect(labels.getShortTag(0)).toBe('Sarah');
    });

    it('short tag truncates long first names', () => {
      labels.setIdentified(0, 'Bartholomew');
      expect(labels.getShortTag(0)).toBe('Barthol.');
    });
  });

  describe('priority order', () => {
    it('identified > labeled > anonymous', () => {
      // Start anonymous
      expect(labels.getDisplayName(0)).toBe('Speaker A');

      // Add session label
      labels.setLabel(0, 'Doctor');
      expect(labels.getDisplayName(0)).toBe('Doctor');

      // Voiceprint identified
      labels.setIdentified(0, 'Sarah');
      expect(labels.getDisplayName(0)).toBe('Sarah');
    });
  });

  describe('getAllLabels', () => {
    it('returns all labeled and identified speakers', () => {
      labels.setLabel(0, 'Doctor');
      labels.setIdentified(1, 'Sarah');

      const all = labels.getAllLabels();
      expect(all).toHaveLength(2);
      expect(all[0]).toEqual({ speakerIndex: 0, name: 'Doctor', type: 'labeled' });
      expect(all[1]).toEqual({ speakerIndex: 1, name: 'Sarah', type: 'identified' });
    });

    it('identified takes priority in getAllLabels too', () => {
      labels.setLabel(0, 'Doctor');
      labels.setIdentified(0, 'Sarah');

      const all = labels.getAllLabels();
      expect(all).toHaveLength(1);
      expect(all[0].type).toBe('identified');
      expect(all[0].name).toBe('Sarah');
    });
  });

  describe('reset', () => {
    it('clears all labels and identified names', () => {
      labels.setLabel(0, 'Doctor');
      labels.setIdentified(1, 'Sarah');
      labels.reset();

      expect(labels.getDisplayName(0)).toBe('Speaker A');
      expect(labels.getDisplayName(1)).toBe('Speaker B');
      expect(labels.getAllLabels()).toHaveLength(0);
    });
  });

  describe('applyServerIdentification', () => {
    it('updates the display name for a speaker index', () => {
      labels.applyServerIdentification(0, 'Sarah van Berg', 'vp-sarah-01');
      expect(labels.getDisplayName(0)).toBe('Sarah van Berg');
    });

    it('identified name takes priority over session label', () => {
      labels.setLabel(0, 'Doctor');
      labels.applyServerIdentification(0, 'Dr. Janssen', 'vp-janssen');
      expect(labels.getDisplayName(0)).toBe('Dr. Janssen');
    });

    it('works when voiceprintId is null', () => {
      labels.applyServerIdentification(1, 'Marco', null);
      expect(labels.getDisplayName(1)).toBe('Marco');
      expect(labels.getShortTag(1)).toBe('Marco');
    });

    it('appears as identified type in getAllLabels', () => {
      labels.applyServerIdentification(2, 'Tim', 'vp-tim');
      const all = labels.getAllLabels();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual({ speakerIndex: 2, name: 'Tim', type: 'identified' });
    });

    it('updates an existing identification', () => {
      labels.applyServerIdentification(0, 'Sarah', 'vp-1');
      labels.applyServerIdentification(0, 'Sarah van Berg', 'vp-1');
      expect(labels.getDisplayName(0)).toBe('Sarah van Berg');
    });

    it('bridges server pipeline to display: short tag uses first name', () => {
      labels.applyServerIdentification(0, 'Bartholomew Smith', 'vp-x');
      expect(labels.getShortTag(0)).toBe('Barthol.');
    });
  });
});
