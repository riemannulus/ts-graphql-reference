import type { Client } from '@openfeature/server-sdk';
import { describe, expect, it } from 'vitest';
import { createFlagReader } from '../../flags/flag-reader.js';
import { gate, variant } from '../../flags/flags.js';
import { FeatureDisabledError } from '../../foundation/errors.js';

// The client-binding reader over a fixture registry (so the machinery is proven
// without depending on the shipped FLAGS). A fake OpenFeature client records how
// many times each flag is read, making per-request memoization observable.
function fakeClient(bools: Record<string, boolean>, strings: Record<string, string> = {}) {
  const calls: Record<string, number> = {};
  const client = {
    getBooleanDetails(flagKey: string, defaultValue: boolean) {
      calls[flagKey] = (calls[flagKey] ?? 0) + 1;
      return Promise.resolve({ flagKey, value: bools[flagKey] ?? defaultValue, reason: 'STATIC' });
    },
    getStringDetails(flagKey: string, defaultValue: string) {
      calls[flagKey] = (calls[flagKey] ?? 0) + 1;
      return Promise.resolve({ flagKey, value: strings[flagKey] ?? defaultValue, reason: 'STATIC' });
    },
  } as unknown as Client;
  return { client, calls };
}

const SPECS = { alpha: gate(false, 'alpha gate'), beta: gate(true, 'beta gate') };
const VARIANT_SPECS = { theme: variant(['light', 'dark'], 'light', 'ui theme') };

describe('createFlagReader', () => {
  it('reads a gate through the client and returns its value', async () => {
    const { client } = fakeClient({ alpha: true, beta: false });
    const flags = createFlagReader(SPECS, client);
    expect(await flags.alpha()).toBe(true);
    expect(await flags.beta()).toBe(false);
  });

  it('falls back to the registered default when the client has no value', async () => {
    const { client } = fakeClient({});
    const flags = createFlagReader(SPECS, client);
    expect(await flags.alpha()).toBe(false); // gate default
    expect(await flags.beta()).toBe(true);
  });

  it('memoizes per reader: a flag read repeatedly hits the client once', async () => {
    const { client, calls } = fakeClient({ alpha: true });
    const flags = createFlagReader(SPECS, client);
    await Promise.all([flags.alpha(), flags.alpha()]);
    await flags.alpha();
    expect(calls.alpha).toBe(1);
  });

  it('mints a fresh memo per reader (caches are not shared across requests)', async () => {
    const { client, calls } = fakeClient({ alpha: true });
    await createFlagReader(SPECS, client).alpha();
    await createFlagReader(SPECS, client).alpha();
    expect(calls.alpha).toBe(2);
  });

  describe('assert', () => {
    it('resolves when the gate is on', async () => {
      const { client } = fakeClient({ alpha: true });
      await expect(createFlagReader(SPECS, client).assert.alpha()).resolves.toBeUndefined();
    });

    it('throws FeatureDisabledError (code UNAVAILABLE) when the gate is off', async () => {
      const { client } = fakeClient({ alpha: false });
      const flags = createFlagReader(SPECS, client);
      await expect(flags.assert.alpha()).rejects.toBeInstanceOf(FeatureDisabledError);
      await expect(flags.assert.alpha()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('shares the memo with the value accessor (assert + read = one client call)', async () => {
      const { client, calls } = fakeClient({ alpha: true });
      const flags = createFlagReader(SPECS, client);
      await flags.alpha();
      await flags.assert.alpha();
      expect(calls.alpha).toBe(1);
    });
  });

  describe('variant', () => {
    it('returns the resolved variant when it is one of the declared set', async () => {
      const { client } = fakeClient({}, { theme: 'dark' });
      expect(await createFlagReader(VARIANT_SPECS, client).theme()).toBe('dark');
    });

    it('falls back to the default variant when the backend returns an out-of-set value', async () => {
      const { client } = fakeClient({}, { theme: 'neon' });
      expect(await createFlagReader(VARIANT_SPECS, client).theme()).toBe('light');
    });

    it('falls back to the default variant when unset', async () => {
      const { client } = fakeClient({});
      expect(await createFlagReader(VARIANT_SPECS, client).theme()).toBe('light');
    });

    it('memoizes per reader', async () => {
      const { client, calls } = fakeClient({}, { theme: 'dark' });
      const flags = createFlagReader(VARIANT_SPECS, client);
      await Promise.all([flags.theme(), flags.theme()]);
      expect(calls.theme).toBe(1);
    });
  });
});
