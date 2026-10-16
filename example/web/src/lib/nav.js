// The shop's navigation table, drawn by the Shell in routes/_module.mesa and
// fed to ⌘K by paletteItems, so the two cannot list different screens.
//
// Every `show` is an affordance and not a boundary (Invariant 6): the tables
// behind each screen carry their own gates, so hiding a link changes what is
// worth clicking and changes nothing about what is reachable. The first entries
// have no `show` because a shopper with no account reaches them — the Cart gate
// is level 0 — and that is what gives a guest the frame at all.

const staff = ({ level }) => level >= 5

// One link standing for several screens: they cross-link, and a topbar that
// names every screen stops being a way in and becomes a table of contents.
const under = (...prefixes) => (path) =>
  prefixes.some((p) => path === p.slice(0, -1) || path.startsWith(p))

export const groups = [
  { label: null, entries: [
    { href: '/', label: 'Home', exact: true },
    // exact, because /orders/ is a prefix of /orders/create/ and both would
    // light up at once.
    { href: '/orders/', label: 'Orders', exact: true },
    { href: '/orders/create/', label: 'New order', sub: 'Create an order' },
    { href: '/products/', label: 'Products' },
    { href: '/customers/', label: 'Customers' },
    { href: '/subscriptions/', label: 'Billing', sub: 'Plans, subscriptions and invoices',
      match: under('/subscriptions/', '/plans/', '/invoices/') },
    { href: '/cart/', label: 'Basket' },

    { href: '/inventory/', label: 'Inventory', sub: 'On hand, held, and the ledger', show: staff },
    // The one-audience half of this app. Every model behind it reads at 5, so
    // the level is not narrowing an audience — it is the whole audience there is.
    { href: '/payroll/', label: 'Payroll', show: staff, match: under('/payroll/', '/people/') },
    // `User` READS at 4, so a shopper is served their own single row by the
    // row policy — a working page that says nothing. The link is at 5 because
    // that is the level the screen is FOR, not the level the boundary enforces.
    { href: '/users/', label: 'Users', sub: 'Staff and shoppers', show: staff },
    // The view reads at 5 while every order reads at 1, so most of the people
    // who see this nav legitimately cannot open it.
    { href: '/reports/', label: 'Reports', sub: 'What the shop took, by order state', show: staff },
    // Orion's screens, mounted from the package (automations.mount.js). For
    // staff, whom db/schema.lite lets draft a flow; a shopper grades the same 4
    // and may not (FJS-1169). Activating is the move at 5.
    { href: '/automations/', label: 'Automations', show: ({ user }) => !!user?.isStaff },

    { href: '/settings/', label: 'Settings' },
    { href: '/account/', label: 'Account', sub: 'Two-step sign-in and recovery codes', show: ({ user }) => !!user },
  ] },
]
