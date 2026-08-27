import { createService, $ } from '@frontierjs/junction'

// The shop as a BUSINESS, rather than as a set of rows.
//
// Every other service here answers rows in this shop's database. This one
// answers the things a shop is that are not rows: the name a customer reads on
// a receipt, and the address the confirmation arrives from. One process serves
// the whole fleet, so both are per shop and neither can be a constant
// (`FJS-D126`).
//
// It reads `$.config`, which resolves the calling shop's own answer over the
// app's floor — so a shop that has set nothing reads the deployment's defaults
// and costs nothing, and a shop that has set both reads both. What it may set is
// `tenantConfigKeys` in `api/src/app.ts` and nothing else: the port this is
// served on is the deployment's, and junction refuses the reserved paths at boot
// rather than trusting the list to be written carefully.
//
// Over no model, so the gate ladder does not apply and access is the service's
// own business — a storefront's name is public by construction, since it is
// printed on the page every visitor loads.

export default createService({
  name: 'shopfront',

  // `settings` and not `find`: `find` promises a LIST and this is one object,
  // which is refused at both ends (`FJS-144`). A collection-level custom method
  // — `POST /shopfront` with `X-Service-Method: settings` — wraps as a single
  // and unwraps whole.
  //
  // `methods:` also narrows the surface: without it the base service answers
  // every CRUD verb it was not given, and on a service with no model that is a
  // 500 rather than a refusal.
  methods: ['settings'],

  async settings() {
    const config = $.config

    return {
      name: config.name,
      from: config.mail?.from ?? null,
      // Read back so a drive can assert that a shop CANNOT move it. A shop
      // naming its own port or its own database file is the whole reason the
      // override list is an allow-list with a reserved floor under it.
      port: config.port,
    }
  },
})
