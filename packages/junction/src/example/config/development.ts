// example/config/development.ts
// Overrides applied when NODE_ENV=development (the default)

export default {
  debug: true,
  http: {
    ddos: { enabled: false },
  },
}
