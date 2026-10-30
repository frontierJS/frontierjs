// shared/login.ts
// Where a Frontier member's machine posts its signed login. The route
// (`api/src/login.ts`) answers here and the terminal client (`sign-in.js`)
// signs this path, so a signature made for one spelling never verifies at the
// other. Nothing else lives here: the route is server code.

export const LOGIN_PATH = '/haven/login'
