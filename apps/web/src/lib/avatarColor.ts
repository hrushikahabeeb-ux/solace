/** Deterministic avatar background color from a user id, so different people in a
 *  group get visually distinct initials instead of every avatar being the same
 *  lavender block. Palette stays inside the approved theme's accent colors. */
const PALETTE = ['var(--color-accent-lavender)', 'var(--color-accent-coral)', 'var(--color-accent-peach)', 'var(--color-accent-lavender-deep)'];

export function avatarColorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}
