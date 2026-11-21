# Testing Guide

How to prove an app does what its schema says, one quick page per idea.
The guide shows what is possible; the READMEs beside it explain it.

A page is a skim, not a lesson:

- one or two sentences on what the feature is for
- one example, the smallest that shows it working
- a short list of what else it can do, a line each, with no explanation
- a closing **In depth** link to the doc its `from` note names

Edge cases, refusals, rulings and `FJS-` ids belong in the full doc. If a page
needs a second example to make sense, that material belongs in the full doc and
the page links to it.

Every `js` example runs: `test/doc-examples.test.ts` runs each one as a module
in its own process, against the `lite` block above it, and a page may not use
`fragment`. The browser pages need Chrome and are skipped where there is none.
The lesson that walks the checks is `fli tutor:test`. Writing a service's own
tests is Junction's [Testing](../../../junction/docs/guide/running/testing.md)
page, and a factory-built database without an app is Litestone's
[Testing](../../../litestone/docs/guide/misc/testing.md).

This list is the page order. The website builds `/docs/testing/` from it, so a
page that is not listed here is not published.

## Environment

- [A test environment](environment/a-test-env.md)
<!-- from: README.md § top, Mounting your app, The act is the announcement window -->
- [Calling as a user](environment/calling-as-a-user.md)
<!-- from: README.md § Calling a service, sessionContext(), Binding the principal -->
- [Transport parity](environment/transport-parity.md)
<!-- from: README.md § Transport parity -->
- [A mail double](environment/a-mail-double.md)
<!-- from: README.md § Doubles -->

## Checks

- [The checks a schema contains](checks/derived-checks.md)
<!-- from: ../litestone/docs/testing.md § createTestEnv, verifyRowPolicies; packages/cli/commands/tutor/_steps-test/04-checks.md -->
- [Grading the checks](checks/grading-the-checks.md)
<!-- from: ../litestone/docs/testing.md § Schema mutation testing; packages/cli/commands/test/mutate.md -->

## Browser

- [Driving a page](browser/driving-a-page.md)
<!-- from: README.md § Driving the app in a browser; src/drive.ts -->
- [What the page did](browser/what-the-page-did.md)
<!-- from: ../mesa/docs/guide/reference/drive.md -->
