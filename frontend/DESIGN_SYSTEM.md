# Safry — Night Atlas

## Design direction

A dark, bilingual travel workspace for companies and travelers. Deep navy surfaces, warm gold actions, high-contrast ivory text. Color is functional: gold identifies the next action, green confirms a state, red marks destructive actions. No fictional trust badges, customer counts, reviews, or payment claims.

## Architecture

- `src/design-system.css`: semantic colors, spacing, radii, typography, focus states, buttons, fields, dialogs, status labels, reduced-motion behavior.
- `src/styles.css`: legacy layout in a low-priority CSS cascade layer. New unlayered component styles override it explicitly; do not add new feature rules here.
- `src/pages/auth-premium.css`: authentication and registration.
- `src/pages/workspace-premium.css`: traveler/provider shell, overview, catalog, and bookings.
- `src/pages/platform-admin.css` and `organization-management.css`: administration and company management.
- `src/components/Brand.tsx`: original code-native brand mark. No remote image/font dependency.
- Existing React components retain the API client and role checks; styling does not confer permissions.

## Tokens

Use `--surface-0` for the canvas, `--surface-1` for cards, `--surface-2` for nested controls, and `--surface-3` for hover/raised controls. Use `--text-primary`, `--text-secondary`, and `--text-muted`, not arbitrary gray hex values. Main actions use `--accent` with dark text. Status colors must also have a text label; never communicate status through color alone.

Spacing follows 4/8/12/16/24/32/48px. Card radius is 20px; controls use 12px. Prefer a single clear primary action per panel and group infrequent/destructive actions behind an explicit disclosure.

## Arabic and English

Language context changes both `lang` and `dir`, persists preference, and syncs tabs. Use logical CSS properties (`margin-inline`, `inset-inline-start`, `text-align: start`) for direction-sensitive layout. Arabic and English inputs use explicit language/direction when both appear in one form. Email/password/IDs remain LTR.

Use `pick(ar, en)` for component-local copy and translation dictionaries for reusable/backend labels. `pnpm check:i18n` checks dictionary coverage and recognizes explicitly paired `pick` strings. Avoid concatenating count + fixed singular/plural words; use a localized label followed by a localized number where grammar would be ambiguous.

User-authored names/descriptions without an English version remain as entered. The UI must not invent translations or imply bilingual content is present when it is not.

## Accessibility and responsive behavior

- Visible keyboard focus and 44px touch targets for primary interactive controls.
- Native `dialog` for focus trapping and Escape dismissal.
- Visible form labels; errors use alerts; icon-only actions need localized accessible labels.
- Responsive single-column forms and cards on phones. Admin record labels remain visible when table rows become cards.
- Honor `prefers-reduced-motion`; do not rely on animation to explain state.
- Keep keyboard, RTL/LTR, and 390px phone checks part of future visual acceptance testing.

## Release boundary

This design improves UI readiness, not full commercial readiness of the platform. Payment, legal content, verified provider onboarding, production deployment/security, load testing, and unsupported booking integrations still require their own implementation and acceptance checks. Existing demo accounts are development-only.
