// Loaded by verify-crash.mjs with `bun --preload`, and only there. It gives the
// drive a way to make the API die of an uncaught throw once it is listening,
// without a route or an env switch in the app that production could reach.
//
// A signal and not a timer: a timer fires at an instant nobody chose, and a
// throw before notifications' boot() has registered its listener crashes the
// app with no ping and fails the drive for a reason that is not the ping.
// SIGUSR2 is not one of the signals junction handles, so this does not switch
// its crash handler off (it installs `uncaughtException` only when none is set).

process.on('SIGUSR2', () => {
  setTimeout(() => { throw new Error('verify-crash: crashed on purpose') }, 0)
})
