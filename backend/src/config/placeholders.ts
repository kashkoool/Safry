/** Example values shipped in *.env.example files. They must never be accepted as real secrets or passwords. */
const PLACEHOLDER_FRAGMENTS = ["change_me", "change-me", "changeme", "replace-with", "replace_with", "replace-before", "placeholder", "your-secret", "example"];

export function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDER_FRAGMENTS.some((fragment) => lower.includes(fragment));
}
