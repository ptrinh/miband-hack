import { bandFiles, type Deck } from '../decks/model';
import { bumpVersionCode, getDemoSigner } from './notes';
import { repackRpk, type RepackOptions } from './repack';
import type { RpkSigner } from './sign';

/**
 * Returns a signed Flashcards rpk holding `decks`: common/decks.json (the list) and one
 * common/deck<N>.json per deck replace the sample deck of the template, the same way Notes swaps
 * common/notes.json. `template` is public/apps/flashcards.rpk. Signs with the public demo key unless
 * another signer is given. Throws if the decks do not pass validateDecks().
 */
export async function buildFlashcardsRpk(
  template: Uint8Array,
  decks: Deck[],
  signer?: RpkSigner,
  options?: RepackOptions & { versionCode?: number },
): Promise<Uint8Array> {
  const replace = bandFiles(decks);
  if (options?.versionCode !== undefined) Object.assign(replace, bumpVersionCode(template, options.versionCode));
  return repackRpk(template, replace, signer ?? (await getDemoSigner()), options);
}
