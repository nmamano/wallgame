/**
 * Names for players who are not logged in.
 *
 * Every guest used to be called "Guest", so a game between two of them read
 * "Guest won by resignation" - which does not say who won - and their chat
 * lines, the live-games list and the past-games list were equally ambiguous.
 * Giving each guest an animal makes the two sides tellable apart everywhere at
 * once, because every one of those surfaces reads the same seat name.
 *
 * The "Guest " prefix is load-bearing: an account display name may not contain
 * "guest" (see the check in `server/routes/settings.ts`), so a name of this
 * shape can only ever belong to a guest, and no account can impersonate one.
 */

const GUEST_ANIMALS = [
  "Otter",
  "Badger",
  "Falcon",
  "Heron",
  "Osprey",
  "Marmot",
  "Puffin",
  "Raven",
  "Salmon",
  "Tapir",
  "Vulture",
  "Walrus",
  "Wombat",
  "Yak",
  "Gecko",
  "Ibex",
  "Jackal",
  "Kestrel",
  "Lemur",
  "Manatee",
  "Narwhal",
  "Wallaby",
  "Pangolin",
  "Quokka",
  "Ferret",
  "Stoat",
  "Toucan",
  "Urchin",
  "Viper",
  "Weasel",
  "Axolotl",
  "Bison",
  "Cormorant",
  "Dingo",
  "Egret",
  "Kiwi",
  "Gibbon",
  "Hoopoe",
  "Impala",
  "Tuatara",
] as const;

/** Exposed for tests: the exact set of animals a guest name can be built from. */
export const guestAnimals: readonly string[] = GUEST_ANIMALS;

const guestName = (animal: string, suffix: number): string =>
  suffix === 0 ? `Guest ${animal}` : `Guest ${animal} ${suffix}`;

const normalize = (name: string): string => name.trim().toLowerCase();

/**
 * Picks a guest name that nobody in the same game is already using.
 *
 * `taken` is compared trimmed and case-insensitively, because it holds names
 * from wherever a seat got its own - an account name, a bot name, a placeholder
 * - and none of those are normalized to match this list's capitalization.
 *
 * Animals are drawn at random rather than in order so two games started back to
 * back do not both open with the same one. If every animal is taken (only
 * reachable with more than 40 spectators in one game) the search repeats with a
 * numeric suffix, so this always returns an unused name.
 */
export const pickGuestName = (taken: Iterable<string> = []): string => {
  const used = new Set([...taken].map(normalize));

  for (let suffix = 0; ; suffix++) {
    const free = GUEST_ANIMALS.filter(
      (animal) => !used.has(normalize(guestName(animal, suffix))),
    );
    if (free.length > 0) {
      return guestName(free[Math.floor(Math.random() * free.length)], suffix);
    }
  }
};
