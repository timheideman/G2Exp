/**
 * VoiceprintStore — Persistent storage for enrolled speaker voiceprints
 *
 * Stores voiceprints as JSON. In production, this backs to a file on disk
 * or a database. For now, file-based with in-memory cache.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import type { Voiceprint } from '../types/speaker';

export class VoiceprintStore {
  private voiceprints: Map<string, Voiceprint> = new Map();
  private filePath: string;
  private dirty = false;

  constructor(storagePath?: string) {
    this.filePath = storagePath || join(process.cwd(), 'data', 'voiceprints.json');
  }

  /** Load voiceprints from disk */
  async load(): Promise<void> {
    try {
      if (existsSync(this.filePath)) {
        const raw = await readFile(this.filePath, 'utf-8');
        const data: Voiceprint[] = JSON.parse(raw);
        this.voiceprints.clear();
        for (const vp of data) {
          this.voiceprints.set(vp.id, vp);
        }
      }
    } catch (err) {
      console.error('[VoiceprintStore] Failed to load:', err);
    }
  }

  /** Save voiceprints to disk */
  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      const data = Array.from(this.voiceprints.values());
      await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
    } catch (err) {
      console.error('[VoiceprintStore] Failed to save:', err);
    }
  }

  /** Add or update a voiceprint */
  add(voiceprint: Voiceprint): void {
    this.voiceprints.set(voiceprint.id, voiceprint);
    this.dirty = true;
  }

  /** Remove a voiceprint by ID */
  remove(id: string): boolean {
    const deleted = this.voiceprints.delete(id);
    if (deleted) this.dirty = true;
    return deleted;
  }

  /** Get a voiceprint by ID */
  get(id: string): Voiceprint | undefined {
    return this.voiceprints.get(id);
  }

  /** Get all voiceprints */
  getAll(): Voiceprint[] {
    return Array.from(this.voiceprints.values());
  }

  /** Find a voiceprint by name (case-insensitive) */
  findByName(name: string): Voiceprint | undefined {
    const lower = name.toLowerCase();
    for (const vp of this.voiceprints.values()) {
      if (vp.name.toLowerCase() === lower) return vp;
    }
    return undefined;
  }

  /** Number of stored voiceprints */
  get size(): number {
    return this.voiceprints.size;
  }

  /** Clear all voiceprints (for testing) */
  clear(): void {
    this.voiceprints.clear();
    this.dirty = true;
  }
}
