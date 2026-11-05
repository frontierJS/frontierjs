// @frontierjs/conduit-google -- the Google products an app reaches with its OWN
// project credential (an API key or a service account). The user's delegated
// OAuth grant is `conduit-gmail`; the line between the two is whose credential
// signs the call, not which product it is.
//
// One namespace per product, so a second module cannot collide with the first
// on `translate` or `Failure`.

export * as maps from './maps/index.ts'
export * as fcm from './fcm/index.ts'
