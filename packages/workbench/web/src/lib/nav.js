// Workbench's navigation table, drawn by routes/_module.mesa.
//
// Every `show` is an affordance and not a boundary (Invariant 6): each model
// carries its own `@@gate`, so hiding a link changes what is worth clicking and
// nothing about what is reachable.

const member = ({ user }) => !!user

// An unlabeled group is links on the bar; a labeled one is a menu there and a
// headed list in the drawer.
export const groups = [
  { label: null, show: member, entries: [
    { href: '/workbench/',          label: 'Chats',           icon: 'workbench',     sub: 'a Claude Code chat per pinned checkout' },
    { href: '/terminal/',           label: 'Terminal',        icon: 'workbench',     sub: 'a shell in your home folder that outlives the tab' },
  ] },
  { label: 'Atlas', show: member, entries: [
    { href: '/atlas/',              label: 'Atlas',           icon: 'atlas',         sub: 'issues, open questions and rulings — and Claude to talk one through', exact: true },
    { href: '/atlas/decide/',       label: 'Decide',          icon: 'atlas',         sub: 'the open questions one card at a time — swipe to rule, Claude to explain' },
    { href: '/atlas/autopilot/',    label: 'Autopilot',       icon: 'atlas',         sub: 'the project\'s loops as a town — lanes, the Dock, the Switch, and a replay of the day' },
    { href: '/notifications/',      label: 'Notifications',   icon: 'atlas',         sub: 'what you have been told' },
  ] },
  { label: 'Machines', show: member, entries: [
    { href: '/basecamps/',          label: 'Basecamps',       icon: 'workbench',     sub: 'every Basecamp this laptop made — whether it answers, Back up now, Restart' },
    { href: '/charter/',            label: 'Charter',         icon: 'workbench',     sub: 'run Charter\'s cases on its Basecamp and watch each stage — Reinstall its box' },
    { href: '/servers/',            label: 'Servers',         icon: 'workbench',     sub: 'the machines and IPs this laptop\'s accounts reach' },
    { href: '/laptop/',             label: 'Laptop',          icon: 'workbench',     sub: 'fli\'s files on this machine — disk, keys, what is running' },
  ] },
]
