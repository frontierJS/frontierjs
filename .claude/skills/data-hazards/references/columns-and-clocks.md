# Columns and clocks

The full entries behind this section of the `data-hazards` skill's index.

- **Litestone emits columns verbatim camelCase and `DateTime` as ISO-8601 TEXT.** Hand-written SQL assuming snake_case or epoch-ms will not match.
- **Every timestamp litestone writes comes from the CLIENT's clock, and a raw `UPDATE` therefore stamps nothing.** `@default(now())`, `@updatedAt` on create and on update, `@@softDelete`'s stamp, `now()` in a policy and the retention cutoff all read `createClient({ now })`, so `advance('100d')` then `$retain()` is a test anybody can write. **`@updatedAt` is not a trigger** (`FJS-531`, `FJS-396`, `FJS-D152`), since a trigger reads SQLite's clock and a frozen clock could not be staged. The column DEFAULT stays as the floor, so a raw INSERT still stamps; a hand-written UPDATE sets its own. No clock reaches a raw statement or a `@derived` expression reading `now()`, which is compiled once at startup. **A deadline the CALLER computes is minted from `db.$now()`, never `Date.now()`**: `@@expires` grades it on the client's clock, so a `Date.now() + ttl` mint lapses early or never in exactly the test that moves the clock.
