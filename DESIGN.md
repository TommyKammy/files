# Design

## Theme

Light, tool-first, Linear-inspired. The workspace is a near-white content panel floating inside a light gray application shell. The sidebar is a quiet neutral layer, not a dark brand block. Indigo appears only for primary actions, selection, focus, and active navigation.

## Color

Use OKLCH-derived neutrals and a single indigo accent. Measured from Linear's light workspace.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#efeff1` | Application shell and sidebar |
| `--surface` | `#f9f9fa` | Main workspace panel |
| `--surface-raised` | `#ffffff` | Inputs, menus, table surface |
| `--surface-hover` | `#f2f2f4` | Hover rows/buttons |
| `--border` | `#e7e7ea` | Panel and control borders |
| `--border-subtle` | `#f0f0f1` | Table dividers |
| `--text` | `#111214` | Primary text |
| `--text-secondary` | `#55565a` | Body/UI secondary |
| `--text-muted` | `#8a8c91` | Metadata, placeholders |
| `--accent` | `#5e6ad2` | Primary action, selection |
| `--accent-hover` | `#4f5ac2` | Primary hover |
| `--accent-soft` | `#eef0fb` | Selected row, soft badge |
| `--accent-border` | `#dfe2f5` | Selected border, focus tint |
| `--danger` | `#d9343f` | Destructive action |
| `--success` | `#2f9e5f` | Public/success |
| `--warning` | `#b7791f` | Confidential/warning |

Classification colors remain semantic but use soft tints and a dot rather than saturated pills.

## Typography

- Family: `"Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif`.
- Base UI: 13px / 1.4, weight 450-500.
- Metadata: 12px, weight 400-500.
- Micro labels: 11px, weight 500.
- Page/folder title: 15-16px, weight 600, letter-spacing `-0.01em`.
- No display fonts inside the workspace. No uppercase body copy. Section labels may use 11px medium with normal case.
- Tables can run dense; keep names on one line with truncation and a second line for metadata when needed.

## Layout

- Shell: 245px sidebar + a main panel inset 8px from the top/right/bottom, radius 12px, 1px border.
- Sidebar: 12px horizontal padding, 28px navigation rows, 8px row radius.
- Main: 24-32px horizontal padding, 16-20px vertical rhythm.
- File rows: 44px tall; table header 36px; selection toolbar 28-32px controls.
- Grid cards: 8px radius, 1px border, no shadow.
- Popovers/menus: 8px radius, menu shadow, 28-30px rows.
- No nested cards. Use borders and background shifts rather than shadows to separate surfaces.

## Components

### Buttons

Default: height 28px, 6px radius, 1px `--border`, white surface, 12px medium text, icon 14px. Hover: `--surface-hover`, `--text`. Primary: `--accent` background, white text, no border. Destructive: `--danger` text, soft red hover. Icon buttons: 24-28px square, muted icon, hover surface. No glows, gradients, or pill-shaped action buttons.

### Inputs

Height 28-32px, 6px radius, white surface, 1px `--border`, 12-13px text. Focus: 1px `--accent` ring plus a soft accent tint. Placeholder: `--text-muted` at AA contrast.

### Table

Header: 36px, 11px medium, `--text-muted`, 1px bottom border. Rows: 44px, 1px bottom `--border-subtle`, hover `--surface-hover`, selected `--accent-soft` with a 1px `--accent-border` inset ring. Checkbox 14px. File/folder icon 16px. Row action buttons appear as 24px muted icons.

### Sidebar

Light `--bg`, no border. Workspace switcher 28px. Search row 28px. Nav rows 28px, 8px radius, 13px medium. Active row `#e2e2e6` with primary text. Section labels 11px medium muted, normal case. Folder tree rows 26-28px with 12px chevrons. User footer is a quiet row, not a card.

### Menus

White, 1px `--border`, 8px radius, menu shadow, 12px text. Row height 28px, hover `--surface-hover`, selected `--accent-soft`. Header 11px muted with a bottom divider. Submenus share the same surface and shadow.

### Classification

Small dot + label. Editable classification uses a compact select styled like a subtle control, not a filled pill. Confidential/internal/public tints stay distinguishable but muted.

## Motion

150-200ms ease-out for hover, focus, and menu state. No page-load choreography. Respect `prefers-reduced-motion`.

## Accessibility

WCAG AA. Focus rings use `--accent` with a 2px visible ring. Selected and active states never rely on color alone (checkmark, icon, or border). Preserve all existing keyboard, IME, and screen-reader behavior.
