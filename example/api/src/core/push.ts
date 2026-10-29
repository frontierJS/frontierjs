// api/src/core/push.ts — whether this app sends Web Push, decided once.
//
// Two readers have to agree: app.ts registers the webPush() driver, and every
// notification whose `via` names 'push'. A via naming a transport with no
// driver throws NotificationDriverNotFoundError at notify(), which here is
// inside payment-announce's retry loop. So both read `vapid` from this file.
//
// No dev fallback, unlike ENCRYPTION_KEY: a pair minted per boot rotates the
// key on every restart, and every browser that subscribed is pushed to under a
// key it no longer holds. Without the pair, push is off and says so once.
//
//   fli crypto:keygen vapid --env --subject mailto:shop@example.test

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env

export const vapid = VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT
  ? { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT }
  : null

if (!vapid) {
  console.warn(
    '[example] VAPID_* not set — Web Push is off.\n' +
    '          Turn it on with: fli crypto:keygen vapid --env --subject mailto:shop@example.test'
  )
}
