/**
 * tests/principal-snapshot.test.ts — `junction principal` (`FJS-514`).
 *
 * The committed access snapshot holds the tenancy PREDICATE and the `snapshots`
 * CI phase fails a stale one. Nothing held its INPUT — who emits the claim, off
 * which request, verified against which model — so a resolver emitting the wrong
 * tenant left every artefact byte-identical.
 *
 * These grade the two halves that can be wrong independently: what
 * `describePrincipalRealm` reads off a built app, and what the renderer says
 * about it. The renderer is tested separately from the app because the sentences
 * are the product — a row that reads *no tenancy* about an app that is nothing
 * but tenancy is the failure this file exists to catch, and it happened.
 */

import { describe, test, expect } from 'bun:test'

import { membershipClaim, describePrincipalRealm, PRINCIPAL_RESOLVER, TENANT_REGISTRY } from '../src/core/litestone.ts'
import { renderPrincipalSnapshot } from '../tools/principal-snapshot.ts'

const claim = membershipClaim({
  tenantFrom: () => 'ws-1',
  model:      'workspaceMember',
  subject:    'userId',
  tenant:     'workspaceId',
  standing:   'role',
  standingAs: 'memberRole',
  include:    ['workspace'],
  namedBy:    'the X-Workspace-Id header',
})

// A client is duck-typed the way the describer reads one — `$tenancy` and
// `$schema` are the whole of what it asks for, and a Litestone client THROWS on
// an unknown property, so anything else would be a defect rather than undefined.
const db = {
  $tenancy: { strategy: 'row', column: 'workspaceId', claim: 'workspaceId', resolve: null },
  $schema: {
    models: [
      { name: 'Workspace',       attributes: [{ kind: 'tenant', mode: 'none' }], fields: [] },
      { name: 'WorkspaceMember', attributes: [{ kind: 'tenant', mode: 'none' }],
        fields: [{ name: 'role', type: { name: 'MemberRole' } }] },
      { name: 'Project',         attributes: [{ kind: 'deny', generated: 'tenancy' }],
        fields: [{ name: 'workspaceId', type: { name: 'String' } }] },
      { name: 'Deployment',      attributes: [{ kind: 'deny', generated: 'tenancy' }],
        fields: [{ name: 'projectId', type: { name: 'String' } }] },
    ],
    enums: [{ name: 'MemberRole', values: ['viewer', 'admin', 'owner'] }],
  },
}

const appWith = (resolver: unknown, extra: Record<symbol, unknown> = {}) =>
  Object.defineProperties({}, {
    [PRINCIPAL_RESOLVER]: { value: resolver },
    ...Object.fromEntries(Object.getOwnPropertySymbols(extra).map(s => [s, { value: extra[s] }])),
  })

describe('membershipClaim().describe()', () => {
  test('answers the four columns that decide who a request turns out to be', () => {
    const d = claim.describe()
    expect(d).toEqual({
      kind: 'membership', model: 'workspaceMember', subject: 'userId',
      tenant: 'workspaceId', standing: 'role', standingClaim: 'memberRole', capabilities: null,
      claims: ['workspaceId', 'memberRole'], include: ['workspace'],
      namedBy: 'the X-Workspace-Id header',
    })
  })

  test('a grant column is named, and adds the one claim the framework spells', () => {
    // `capabilities` is not renameable the way a tenant claim is: litestone's
    // grid reads `auth().capabilities` (`FJS-D151`), so what the app chooses is
    // which COLUMN it comes out of, and the claim's name is fixed.
    const d = membershipClaim({
      tenantFrom: () => 'ws-1', model: 'workspaceMember', subject: 'userId',
      tenant: 'workspaceId', standing: 'role', standingAs: 'memberRole',
      capabilities: 'capabilities',
    }).describe()
    expect(d.capabilities).toBe('capabilities')
    expect(d.claims).toEqual(['workspaceId', 'memberRole', 'capabilities'])
    // The standing's claim is STATED. It used to be read off the end of
    // `claims`, which was the standing only while a resolver emitted exactly
    // two — so the third claim took the label the moment one existed, and the
    // snapshot said the grant column was 'read from WorkspaceMember.role'.
    expect(d.standingClaim).toBe('memberRole')
  })

  test('emits NO values — a claim name is the app, a claim value is a caller', () => {
    const d = JSON.stringify(claim.describe())
    expect(d).not.toContain('ws-1')          // what tenantFrom would answer
  })
})

describe('describePrincipalRealm', () => {
  test('splits the models three ways off the generated rules, not a re-derivation', () => {
    const realm = describePrincipalRealm(appWith(claim), db)!
    expect(realm.scoped).toEqual(['Project'])          // carries the column
    expect(realm.delegated).toEqual(['Deployment'])    // generated deny, no column
    expect(realm.exempt).toEqual(['Workspace', 'WorkspaceMember'])
  })

  test('reads the standing values off the enum, and names the column it came from', () => {
    const realm = describePrincipalRealm(appWith(claim), db)!
    expect(realm.standing).toEqual({
      column: 'WorkspaceMember.role', claim: 'memberRole', values: ['viewer', 'admin', 'owner'],
    })
  })

  test('finds the declaration on the REGISTRY when there is no app-wide client', () => {
    // `createApp({ tenants })` has no `app.db` — a client is per request. Asking
    // the client answered *no tenancy* about an app that is nothing but, which
    // is what this covers.
    const realm = describePrincipalRealm(
      appWith(claim, { [TENANT_REGISTRY]: { tenancy: { strategy: 'database', resolve: { kind: 'subdomain' } } } }),
      undefined,
    )!
    expect(realm.tenancy?.strategy).toBe('database')
    expect(realm.tenancy?.resolve).toBe('the request subdomain')
    expect(realm.hasSchema).toBe(false)
  })

  test('an app with neither a declaration nor a resolver describes nothing', () => {
    expect(describePrincipalRealm({}, undefined)).toBeNull()
  })
})

describe('the rendered page', () => {
  const render = (realm: ReturnType<typeof describePrincipalRealm>) =>
    renderPrincipalSnapshot(realm, { source: 'api/app.ts', command: 'junction principal --app api/app.ts' })

  test('names its own generator, which is how the CI phase reruns it', () => {
    expect(render(describePrincipalRealm(appWith(claim), db)))
      .toContain('<!-- generated by: junction principal --app api/app.ts -->')
  })

  test('a resolver that reads no row is not rendered as membership with blank cells', () => {
    const bearer = Object.assign(function cartClaim() { return {} }, {
      describe: () => ({ kind: 'bearer', model: null, subject: null, tenant: null,
                         standing: null, claims: ['cartToken'], include: [], namedBy: 'the x-cart-token header' }),
    })
    const page = render(describePrincipalRealm(appWith(bearer), db))

    expect(page).toContain('| Kind | `bearer` |')
    expect(page).not.toContain('Membership proved by')
    expect(page).toContain('**This resolver reads no row**')
    // And the claim is classified as what it is, rather than as a standing.
    expect(page).toContain('| `cartToken` | a capability')
  })

  test('a claim the schema reads and the resolver does not emit is called out', () => {
    const wrong = Object.assign(function wrongClaim() { return {} }, {
      describe: () => ({ kind: 'membership', model: 'member', subject: 'userId', tenant: 'orgId',
                         standing: null, claims: ['orgId'], include: [], namedBy: null }),
    })
    const page = render(describePrincipalRealm(appWith(wrong), db))
    // The schema's tenancy claim is `workspaceId`; the resolver emits `orgId`.
    expect(page).toContain('The resolver emits no `workspaceId`')
    expect(page).toContain('result with a 200 on every screen')
  })

  test('per-tenant config: an app that installs no resolver says so plainly', () => {
    const page = render(describePrincipalRealm(appWith(claim), db))
    expect(page).toContain('## Per-tenant configuration')
    expect(page).toContain('installs no `createApp({ tenantConfig })`')
  })

  test('per-tenant config: the allow-list is committed path by path', () => {
    // The section phase 2 reserved, now filled. This list is the half that makes
    // the feature safe rather than the half that makes it work, so a path
    // arriving here is a value a tenant can newly change — which is what the
    // diff has to show.
    const app = Object.defineProperties({}, {
      [PRINCIPAL_RESOLVER]: { value: claim },
      tenantConfig: { value: { keys: ['name', 'mail.from', 'branding.logo'] }, enumerable: true },
    })
    const page = render(describePrincipalRealm(app, db))

    expect(page).toContain('| `mail.from` | a tenant may set this |')
    expect(page).toContain('3 path(s).')
    expect(page).toContain('refused by name rather than dropped')
    // And the reserved set is stated, so a reader knows the floor exists.
    expect(page).toContain('`port`, `host`, `database`')
  })

  test('under strategy database the model breakdown is absent by name, not blank', () => {
    const page = render(describePrincipalRealm(
      appWith(claim, { [TENANT_REGISTRY]: { tenancy: { strategy: 'database', resolve: { kind: 'subdomain' } } } }),
      undefined,
    ))
    expect(page).toContain('**Not applicable, and not missing.**')
    expect(page).not.toContain('| Scoped by column |')
  })
})
