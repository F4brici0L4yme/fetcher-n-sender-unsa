# Design System: AI Doing My Homework (Aula Virtual UNSA)

## 1. Visual Theme & Atmosphere
- **Direction:** Academic Editorial Desk (fusion of **Ledger Minimal** precision + **Warm Editorial** clarity).
- **Purpose:** Personal academic command center for an UNSA student to monitor Aula Virtual (DUTIC) deadlines, authorize exact PDF submissions with zero ambiguity, manage persistent browser sessions, and track personal notes in real time.
- **Audience & Context:** Single student working on desktop/laptop (primary) and mobile (quick checks) during exam weeks, scanning deadlines in 10 seconds without visual fatigue.
- **Density:** Daily App Balanced (5/10) — structured tabular scanning for dates/priorities with generous breathing room around actions.
- **Memorable Moment:** A crisp left-rail workspace with live SSE pulse dot, monospace tabular due-date badges, and an explicit two-step "Authorize & Deliver" security ribbon that makes academic submission feel trustworthy and deliberate.
- **Restraint:** Zero purple/neon gradients, zero generic 3-equal-card marketing grids, zero emojis, zero pure black (`#000000`), zero decorative shadows on flat rows, zero cluttered dashboard KPI widgets with fake numbers.

## 2. Color Palette & Roles (Warm Neutral Slate + UNSA Crimson Accent)
Single cohesive neutral ramp (Stone/Zinc warm-neutral) with **one** high-contrast institutional accent (saturated < 75%):

- **Canvas Paper** (`#F8F7F4`) — Primary page background (warm off-white, reduces glare during late-night study).
- **Pure Sheet** (`#FFFFFF`) — Elevated primary workspace containers, sidebar, and form sheets.
- **Subtle Well** (`#F1EFEA`) — Secondary inset surfaces, active tab background, table header bar, code pills.
- **Charcoal Ink** (`#18181B`) — Primary headings, titles, active controls (Zinc-900, never `#000000`).
- **Graphite Secondary** (`#52525B`) — Course names, descriptions, secondary labels (WCAG AA > 7:1 on white).
- **Stone Muted** (`#71717A`) — Metadata, timestamps, empty-state helper copy (WCAG AA ≥ 4.6:1 on white).
- **Hairline Border** (`#E4E2DC`) — 1px structural rules, sidebar divider, list separators.
- **UNSA Crimson Accent** (`#9B1C2E` / hover `#7F1625` / soft tint `#FDF2F4`) — Single primary accent for primary CTAs, active nav indicator, and focus rings (< 10% of surface).
- **Semantic Status Tokens (restrained, badge/dot use only):**
  - Connected / Confirmed / Baja: Forest `#166534` on `#ECFDF3` border `#BBF7D0`.
  - Pending / Connecting / Media: Amber `#92400E` on `#FFFBEB` border `#FDE68A`.
  - Urgent / Expired / Error / Alta: Crimson `#991B1B` on `#FEF2F2` border `#FECACA`.

## 3. Typography Rules
- **Display & UI Sans:** `Plus Jakarta Sans` (fallback `system-ui, sans-serif`) — crisp geometric humanist sans with clear distinction for Spanish diacritics (`á, é, í, ó, ú, ñ`). Weights: `500`, `600`, `700`.
- **Tabular Mono:** `JetBrains Mono` (fallback `ui-monospace, monospace`) — for deadlines, SHA-256 prefixes, temporary VNC passwords, and live revision indicators (`font-variant-numeric: tabular-nums`).
- **Type Scale (1.200 minor third for productivity UI):**
  - `--step--1`: `0.8125rem` (13px — badges, metadata, micro labels)
  - `--step-0`: `0.9375rem` (15px — body copy, inputs, list titles)
  - `--step-1`: `1.125rem` (18px — section headers)
  - `--step-2`: `1.375rem` (22px — page headers)
  - `--step-3`: `1.75rem` (28px — primary view H1, tracking `-0.025em`)
- **Banned:** `Inter`, generic `Times New Roman`/`Georgia`, decorative script fonts.

## 4. Layout & Navigation Architecture (Multi-Tab MVC Workspace)
- **Persistent Left Sidebar (248px on desktop, collapsible top bar on `< 900px`):**
  - Brand mark: minimalist architectural monogram + **"Aula Virtual"** + subtle `UNSA · Local` subtitle.
  - Primary navigation tabs (URL-addressable query/routes so Back & refresh work cleanly):
    1. **Agenda** (`/`) — Unified timeline of pending tasks & personal notes ordered by deadline.
    2. **Tareas DUTIC** (`/?vista=tareas`) — Filtered view of Aula Virtual assignments with delivery status badges.
    3. **Mis Notas** (`/?vista=notas`) — Personal notes & events with priority badges (`Alta`, `Media`, `Baja`) and quick complete/edit actions.
    4. **Completadas** (`/?vista=completadas`) — Completed notes and confirmed deliveries archive.
    5. **Sesión DUTIC** (`/?vista=sesion` or `/sesion`) — Dedicated persistent browser session manager, connection wizard, account switch & disconnect controls.
  - Bottom sidebar footer: compact **Session Status Pill** (green/amber/red indicator + active identity or "Sin conectar" + SSE live indicator).
- **Main Content Area (max-width `960px` inside fluid workspace):**
  - Sticky subtle top action bar with view title, contextual primary CTA (`Buscar tareas` / `Nueva nota`), and live SSE status toast.
  - Structured hairline-separated agenda rows (replacing heavy nested boxes) with clear left priority/type rail, middle title + course/description, right monospace deadline + status pill + quick action.

## 5. Component Specifications (shadcn-inspired semantic primitives in clean MVC HTML/CSS)
- **Radius:** Locked single scale `--radius: 8px` (`--radius-sm: 6px` for inner badges/inputs, `--radius-pill: 999px` strictly for status dots/pills).
- **Shadows:** Exactly two — `--shadow-sm: 0 1px 2px rgba(24, 24, 27, 0.04)` for elevated sheets, `--shadow-md: 0 8px 24px rgba(24, 24, 27, 0.07)` for popovers/viewer cards.
- **Buttons:** 40px height (44px tap target on mobile), crisp 1px border, subtle `translateY(1px)` tactile press, `focus-visible` 2px crimson ring with 2px offset. Variants: Primary (Crimson fill), Secondary (White surface + hairline border), Ghost (transparent hover tint), Destructive outline (Crimson border/text for Disconnect/Delete).
- **Forms & Inputs:** Single-column layout, visible `<label>` above control, helper text below, inline `aria-invalid` error messages, segmented radio/toggle control for Priority (`Alta` / `Media` / `Baja`) and Status (`Pendiente` / `Completado`).
- **Empty, Loading & Error States:** Distinct copy and clear next action for every view (first-use empty, filter empty, all-caught-up cleared state, session expired alert banner with direct reconnect CTA).

## 6. Motion & Micro-Interactions
- **Durations:** `--dur-fast: 120ms`, `--dur: 200ms`, `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`.
- Subtle row hover tint, tactile button press, calm SSE pulse dot (disabled automatically under `prefers-reduced-motion: reduce`).
- In-place DOM swap via `panel.js` preserves active inputs/focus and announces updates through `aria-live="polite"`.
