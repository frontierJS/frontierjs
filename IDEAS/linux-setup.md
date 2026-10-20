---
id: linux-setup
status: proposed
dated: 2026-10-19
---

# Idea — the owner's ideal Linux dev setup

**Status: PROPOSED. Nothing here is installed.** This is a workstation note, not
framework work, and `overview.md` does not rank it. The Omarchy facts below are
from outside the repo, read 2026-10-19 and not checked against Omarchy's source.

**The ask** (owner, 2026-10-19): what the best terminal experience on Linux is,
starting from not knowing what the current one is.

---

## What exists (probed 2026-10-19)

| Layer | Now |
| --- | --- |
| OS | Ubuntu 22.04.5 LTS, GNOME, **X11** session |
| Terminal emulator | GNOME Terminal (the `x-terminal-emulator` default; nothing else installed) |
| Shell | bash, a plain `~/.bashrc` |
| Multiplexer | tmux installed |

**X11 rules out Foot**, which is Wayland-only. Every other candidate below runs on
either.

## Prior art — Omarchy

Omarchy (DHH; Arch + Hyprland) is the reference for an opinionated dev desktop.

- **Terminal: Foot since Omarchy 4** (2026-08-14), chosen for lower resource use.
  Earlier releases shipped Alacritty, then Ghostty for a while. Its menu switches
  it (Install > Terminal).
- **Shell: bash, kept**, with starship, fzf, zoxide, eza, bat and mise added on
  top (from memory, not checked against v4).
- **Desktop shell: one Quickshell process since v4**, replacing Waybar, Walker,
  mako, SwayOSD, hyprlock, hypridle, swaybg and polkit-gnome. `fjs-os.md` § 1
  still says Omarchy's shell is not Quickshell; that line predates v4.
- **Tiling WM (Hyprland)** is much of its appeal. GNOME's nearest is the Forge or
  Pop Shell extension.

## The pick

- **Emulator: Ghostty.** It's GPU-drawn, has native tabs and splits, needs no
  config, and fits GNOME. WezTerm is second, for Lua config and splits/sessions
  without tmux. Alacritty is the minimal choice that's closest to old Omarchy.
- **Shell: stay on bash, Omarchy-style.** fish gives more out of the box, but
  bash-syntax one-liners pasted from docs then need translating.
- **Tools:** starship (prompt), fzf (Ctrl-R / Ctrl-T), zoxide (`z`), atuin
  (synced history), eza, bat; `rg` is already used.

---

## Phase 0 — shell layer, any emulator

- [ ] 0.1 `sudo apt install fzf bat`, then install starship, zoxide and eza.
- [ ] 0.2 `~/.bashrc`: starship init, zoxide init, fzf key bindings, `ls`→eza and
      `cat`→bat aliases.
- [ ] 0.3 Optional: atuin for history.

## Phase 1 — emulator

- [ ] 1.1 `snap install ghostty --classic` (or the community `.deb`).
- [ ] 1.2 Make it the default: `sudo update-alternatives --config x-terminal-emulator`.
- [ ] 1.3 A short Ghostty config: font, theme, keybinds for splits.

## Phase 2 — tiling, if wanted

- [ ] 2.1 Try Forge or Pop Shell on GNOME before considering a distro change.
- [ ] 2.2 Only past that: Omarchy itself, which means Arch, Wayland and Hyprland
      (a reinstall, and Foot becomes available).

---

Sources: [Omarchy v4.0.0 release notes](https://newreleases.io/project/github/basecamp/omarchy/release/v4.0.0) ·
[Omarchy manual — Terminal](https://learn.omacom.io/2/the-omarchy-manual/106/terminal) ·
[Omarchy 4 review](https://dashen-tech.com/en/dev-tools/omarchy-4-quattro-review/)
