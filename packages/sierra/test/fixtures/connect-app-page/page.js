/**
 * The page connect-app.mjs loads: a table, a form and a live list over a
 * Resource whose app is NOT this page's — `connectApp()` handed to
 * `createResource(name, { app })`. Plain DOM, since the claim is the seam
 * between the handle and a browser, not a component kit.
 *
 * The page registers its own `Customer` with a different column, so a row that
 * renders `email` was read through the hosted app's schema.
 */

import { createRoot, createEffect } from '@frontierjs/mesa/runtime'
import * as J from '../../../src/resource/index.js'

const PAGE_DEFS = {
  Customer: {
    type: 'object', title: 'Customer',
    properties: { title: { type: 'string' } },
    required: ['title'],
    'x-gate': { read: 0, create: 0, update: 0, delete: 0 },
  },
}

const schema = await fetch('/hosted/h1/__schema').then(r => r.json())

J.registerSchemas(PAGE_DEFS, ['Customer'])
J.initJunction({ url: location.origin })
J.getClient().setToken('studio-token')

const hosted    = J.connectApp({ url: '/hosted/h1', apiPrefix: '/api', schema })
const customers = J.createResource('customers', { app: hosted })

const table = document.querySelector('#rows')
const form  = document.querySelector('#add')
const note  = document.querySelector('#note')

createRoot(() => {
  const list = customers.tethered({ state: 'local' })
  createEffect(() => {
    table.replaceChildren(...list.rows.map(row => {
      const tr = document.createElement('tr')
      tr.textContent = row.email
      return tr
    }))
  })
})

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  note.textContent = ''
  try {
    await customers.save({ email: form.elements.email.value })
    form.reset()
  } catch (err) {
    note.textContent = String(err?.message ?? err)
  }
})

globalThis.__page = {
  fields:    Object.keys(customers.fields),
  pageField: Object.keys(J.createResource('customers').fields),
  socket:    () => hosted.client.connected,
  hosted,
}
