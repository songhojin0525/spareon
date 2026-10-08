// SKELETON(S23): replaced by the Next.js App Router app (owner /owner, buyer /app, operator /ops).

/** UI locales. Korean is the default and, for now, the only locale (CLAUDE.md: next-intl, ko default). */
export const SUPPORTED_LOCALES = ['ko'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ko';

/** Resolve a requested locale to a supported one, falling back to the default. */
export function resolveLocale(requested: string | undefined): Locale {
  const match = SUPPORTED_LOCALES.find((l) => l === requested?.toLowerCase());
  return match ?? DEFAULT_LOCALE;
}
