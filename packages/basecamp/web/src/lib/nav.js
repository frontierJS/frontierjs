// Basecamp's navigation table, drawn by routes/_module.mesa and fed to ⌘K by
// paletteItems, so the two cannot list different screens.
//
// Every `show` is an affordance and not a boundary (Invariant 6): each model
// carries its own `@@gate`, graded per workspace, so hiding a link changes what
// is worth clicking and nothing about what is reachable. Every group says
// `show: member`, because the table is members-only and the sign-in page would
// otherwise draw the members' nav.

const member = ({ user }) => !!user

// The handful opened many times a day. They sit in the topbar rather than the
// sidebar, and the drawer below 767px repeats them above the groups.
export const primary = { label: null, show: member, entries: [
  { href: '/',             label: 'Overview',    icon: 'home', exact: true },
  { href: '/apps/',        label: 'Apps',        icon: 'apps',        sub: 'every app in the workspace' },
  { href: '/deployments/', label: 'Deployments', icon: 'deployments' },
  { href: '/servers/',     label: 'Servers',     icon: 'servers' },
  { href: '/alerts/',      label: 'Alerts',      icon: 'alerts',      sub: 'rules and firings' },
] }

// Everything else. `open` is basecamp's own field: a group starts open when it
// says so or holds the current screen, since twenty-odd links at once read as a
// wall and ⌘K reaches every one of them without a group to open.
export const groups = [
  { label: 'Work', icon: 'work', open: true, show: member, entries: [
    { href: '/dashboards/',         label: 'Dashboards',      icon: 'dashboards',    sub: 'saved views' },
    { href: '/projects/',           label: 'Projects',        icon: 'projects' },
    { href: '/sites/',              label: 'Sites',           icon: 'pages',         sub: 'the static sites you may edit, and their drafts' },
    { href: '/jobs/',               label: 'Jobs',            icon: 'jobs' },
    { href: '/flags/',              label: 'Flags',           icon: 'flags',         sub: 'feature flags' },
    { href: '/activity/',           label: 'Activity',        icon: 'activity',      sub: 'what happened here' },
    { href: '/trash/',              label: 'Trash',           icon: 'trash',         sub: 'deleted, and restorable' },
  ] },
  { label: 'Infrastructure', icon: 'servers', show: member, entries: [
    { href: '/networks/',           label: 'Networking',      icon: 'networks',      sub: 'private networks' },
    { href: '/volumes/',            label: 'Volumes',         icon: 'volumes',       sub: 'disks the fleet has' },
    { href: '/registry/',           label: 'Registry',        icon: 'registry',      sub: 'images this workspace pushed' },
    { href: '/dns/',                label: 'DNS & edge',      icon: 'dns',           sub: 'hostnames and certificates' },
    { href: '/security/',           label: 'Security',        icon: 'security' },
    { href: '/cleanup/',            label: 'Cleanup',         icon: 'cleanup',       sub: 'what disk can be reclaimed' },
    { href: '/infra-graph/',        label: 'Graph',           icon: 'graph',         sub: 'the fleet as nodes and edges' },
  ] },
  { label: 'Build', icon: 'build', show: member, entries: [
    { href: '/blueprints/',         label: 'Blueprints',      icon: 'blueprints',    sub: 'the deployment catalog' },
    { href: '/recipes/',            label: 'Recipes',         icon: 'recipes',       sub: 'scripts to run on a server' },
    { href: '/portal/',             label: 'Portal',          icon: 'portal',        sub: 'shared appliances' },
    { href: '/git-activity/',       label: 'Git activity',    icon: 'git',           sub: 'the git host', exact: true },
    { href: '/git-activity/local/', label: 'Local repos',     icon: 'local-repos',   sub: 'git checkouts on this machine' },
    { href: '/workbench/',          label: 'Workbench',       icon: 'workbench',     sub: 'a Claude Code chat per pinned checkout' },
    { href: '/pages/',              label: 'Pages',           icon: 'pages',         sub: 'the pages fli writes about this workspace, and its tools' },
    { href: '/registers/',          label: 'Registers',       icon: 'registers',     sub: 'issues, open questions and rulings — and Claude to talk one through', exact: true },
    { href: '/registers/decide/',   label: 'Decide',          icon: 'registers',     sub: 'the open questions one card at a time — swipe to rule, Claude to explain' },
    { href: '/dependencies/',       label: 'Dependencies',    icon: 'dependencies',  sub: 'packages each project depends on, and which need an update' },
    { href: '/observability/',      label: 'Observability',   icon: 'observability', sub: 'metrics and logs' },
    { href: '/channels/',           label: 'Channels',        icon: 'channels',      sub: 'where alerts land' },
  ] },
  { label: 'Settings', icon: 'settings', show: member, entries: [
    { href: '/secrets/',            label: 'Secrets',         icon: 'secrets',       sub: 'machine credentials' },
    { href: '/api-keys/',           label: 'API keys',        icon: 'api-keys',      sub: 'tokens we issue' },
    { href: '/cloud-spend/',        label: 'Cloud spend',     icon: 'spend',         sub: 'what a bill would cover' },
    { href: '/admin/',              label: 'Admin',           icon: 'admin' },
    // Not hidden once it is finished: the six checks go back to undone when the
    // thing they recorded is deleted, so a link that disappeared would be the
    // one thing on it that could go stale.
    { href: '/onboarding/',         label: 'Getting started', icon: 'onboarding',    sub: 'the six setup checks' },
  ] },
  // The hub tier is not a workspace role, so it is offered only to people who
  // hold it. The service answers 404 to anyone else regardless, which is where
  // the refusal is.
  { label: 'System', icon: 'system', show: ({ user }) => !!user?.isSystemAdmin, entries: [
    { href: '/hub/',                label: 'Hub',             icon: 'hub',           sub: 'every workspace' },
  ] },
]

// Screens ⌘K reaches that no nav link names: the caller's own account and
// notifications hang off the topbar's menus, and the Admin and Hub subpages
// are one click inside their section.
export const elsewhere = [
  { label: null, show: member, entries: [
    { href: '/notifications/',      label: 'Notifications',   sub: 'what you have been told' },
    { href: '/settings/',           label: 'Your settings',   sub: 'password, notifications, sessions' },
    { href: '/admin/audit/',        label: 'Audit trail',     sub: 'Admin' },
    { href: '/admin/adapters/',     label: 'Adapters',        sub: 'Admin' },
  ] },
  { label: null, show: ({ user }) => !!user?.isSystemAdmin, entries: [
    { href: '/hub/workspaces/',     label: 'Hub workspaces',  sub: 'Hub' },
    { href: '/hub/users/',          label: 'Hub users & bots', sub: 'Hub' },
    { href: '/hub/flags/',          label: 'Hub flags',       sub: 'Hub' },
    { href: '/hub/backups/',        label: 'Hub backups',     sub: 'Hub' },
    { href: '/hub/settings/',       label: 'Hub settings',    sub: 'Hub' },
  ] },
]
