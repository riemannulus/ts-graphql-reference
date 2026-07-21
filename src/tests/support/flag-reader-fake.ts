import type { FlagReader } from '../../flags/flag-registry.js';
import { FeatureDisabledError } from '../../foundation/errors.js';
import type { WelcomeVariant } from '../../modules/onboarding/onboarding.content.js';

export interface FakeFlags {
  pointTransfer?: boolean;
  pointTransferPreferFree?: boolean;
  welcomeVariant?: WelcomeVariant;
}

const gateAssert = (on: boolean, name: string) => () =>
  on ? Promise.resolve() : Promise.reject(new FeatureDisabledError(name));

/**
 * A `FlagReader` with canned values — no OpenFeature, no database. Lets a pure
 * service/unit test drive the flag axis directly (gate on/off, a chosen variant)
 * without standing up a provider. The seam analogue of the OAuth / search fakes.
 * Gates default ON and the variant to its `classic` default, so a test that only
 * cares about the happy path can call `fakeFlagReader()`.
 */
export function fakeFlagReader(values: FakeFlags = {}): FlagReader {
  const pointTransfer = values.pointTransfer ?? true;
  const pointTransferPreferFree = values.pointTransferPreferFree ?? false;
  const welcomeVariant: WelcomeVariant = values.welcomeVariant ?? 'classic';
  return {
    pointTransfer: () => Promise.resolve(pointTransfer),
    pointTransferPreferFree: () => Promise.resolve(pointTransferPreferFree),
    welcomeVariant: () => Promise.resolve(welcomeVariant),
    assert: {
      pointTransfer: gateAssert(pointTransfer, 'pointTransfer'),
      pointTransferPreferFree: gateAssert(pointTransferPreferFree, 'pointTransferPreferFree'),
    },
  } as unknown as FlagReader;
}
