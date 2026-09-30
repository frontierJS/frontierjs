// policy-some.test.ts — a row policy asking whether ANY row of a to-many
// relation matches.
//
// *The caller is one of this row's members* had no spelling (`FJS-1291`), so
// five sites across three apps carried a copy instead: a resolver-filled
// `claim teamIds`, a `readerIds String[] @system`, a `submittedIds` — each
// rewritten by one service, and each left stale by a seed, a job or a named
// move made on the model. `FJS-D566` rules `members.some(userId == auth().id)`,
// a correlated EXISTS, the same word and the same SQL as the query where's
// `{ members: { some: … } }`.
//
// The two compilers agreeing is asserted in `policy-interpreters.test.ts`,
// beside the path block it shares a shape with — one oracle, not two.
//
// **Every refusal is PAIRED with the legitimate shape one character away**
// (`FJS-351`), as in `policy-paths.test.ts`.

import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'
import { checkRules } from '../src/core/advise.js'

/** The message `createClient` refuses a schema with, or '' when it accepts. */
async function refusal(schema: string): Promise<string> {
  try {
    const db: any = await createClient({ schema, db: ':memory:' })
    db.$close()
    return ''
  } catch (e: any) { return String(e.message).replace(/\s+/g, ' ') }
}

/** linear's shape: a team, its memberships, one rule on the team. */
const TEAMS = (rule: string, memberCols = '') => `
model Team {
  id      String       @id
  private Boolean      @default(false)
  members TeamMember[]
  ${rule}
}
model TeamMember {
  id        String    @id
  teamId    String
  team      Team      @relation(fields: [teamId], references: [id])
  userId    String
  status    String    @default("active")
  deletedAt DateTime?
  ${memberCols}
  @@softDelete
}
`

async function seeded(rule: string) {
  const db: any = await createClient({ schema: TEAMS(rule), db: ':memory:' })
  const sys = db.asSystem()
  for (const t of [
    { id: 'ENG', private: false },
    { id: 'SEC', private: true },
    { id: 'DES', private: true },
    { id: 'EMPTY', private: true },
  ]) await sys.team.create({ data: t })
  for (const m of [
    { id: 'm1', teamId: 'SEC', userId: 'u1' },
    { id: 'm2', teamId: 'DES', userId: 'u2' },
    { id: 'm3', teamId: 'DES', userId: 'u1', status: 'revoked' },
    { id: 'm4', teamId: 'ENG', userId: 'u2' },
  ]) await sys.teamMember.create({ data: m })
  return db
}

const readIds = async (db: any, who: string | null) =>
  (await db.$setAuth(who ? { id: who } : null).team.findMany()).map((x: any) => x.id).sort()

describe('the membership row decides', () => {
  it('a private team is visible to its members and to nobody else', async () => {
    const db = await seeded(`@@allow('read', private == false || members.some(userId == auth().id))`)
    // u1's row in DES is revoked, and this condition does not ask about state,
    // so DES is admitted. The next test is the one that separates them.
    expect(await readIds(db, 'u1')).toEqual(['DES', 'ENG', 'SEC'])
    expect(await readIds(db, 'u2')).toEqual(['DES', 'ENG'])
    expect(await readIds(db, null)).toEqual(['ENG'])
    db.$close()
  })

  it('the condition reads the CHILD row, so a revoked membership admits nothing', async () => {
    // Portal's grant and jazzhr's submitted scorecard — membership that depends
    // on a state of the membership row.
    const db = await seeded(`@@allow('read', members.some(userId == auth().id && status == 'active'))`)
    expect(await readIds(db, 'u1')).toEqual(['SEC'])
    // The revoke is a write to the MEMBERSHIP row, made the way a seed or a job
    // makes it — and nothing else has to move for the team to disappear.
    await db.asSystem().teamMember.update({ where: { id: 'm1' }, data: { status: 'revoked' } })
    expect(await readIds(db, 'u1')).toEqual([])
    db.$close()
  })

  it('a soft-deleted membership is not a membership — the same rows the query where calls the relation', async () => {
    const db = await seeded(`@@allow('read', members.some(userId == auth().id))`)
    expect(await readIds(db, 'u2')).toEqual(['DES', 'ENG'])
    await db.asSystem().teamMember.remove({ where: { id: 'm4' } })
    expect(await readIds(db, 'u2')).toEqual(['DES'])
    // The query where agreeing is the point: one definition of the relation's rows.
    const viaWhere = (await db.asSystem().team.findMany({ where: { members: { some: { userId: 'u2' } } } }))
      .map((x: any) => x.id).sort()
    expect(viaWhere).toEqual(['DES'])
    db.$close()
  })

  it('a negated test admits the rows with no match, including a team with no members at all', async () => {
    const db = await seeded(`@@allow('read', !members.some(userId == auth().id))`)
    expect(await readIds(db, 'u1')).toEqual(['EMPTY', 'ENG'])
    db.$close()
  })
})

describe('a create', () => {
  it('a create answers false — nothing points at a row that does not exist yet — and says so as a refusal', async () => {
    const db: any = await createClient({
      schema: TEAMS(`@@allow('read', true)\n  @@allow('create', members.some(userId == auth().id))`), db: ':memory:' })
    await expect(db.$setAuth({ id: 'u1' }).team.create({ data: { id: 'NEW' } })).rejects.toThrow()
    // The control: the same caller creates under a rule that does not ask.
    const db2: any = await createClient({ schema: TEAMS(`@@allow('all', true)`), db: ':memory:' })
    expect((await db2.$setAuth({ id: 'u1' }).team.create({ data: { id: 'NEW' } })).id).toBe('NEW')
    db.$close(); db2.$close()
  })
})

describe('mapped names and a self-relation', () => {
  it('the correlation and the condition read @map columns and @@map tables', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
model Team {
  id      String       @id
  members TeamMember[]
  @@allow('read', members.some(userId == auth().id))
}
model TeamMember {
  id     String @id
  teamId String @map("team_ref")
  team   Team   @relation(fields: [teamId], references: [id])
  userId String @map("user_ref")
  @@map("memberships")
}
` })
    const sys = db.asSystem()
    await sys.team.create({ data: { id: 'A' } })
    await sys.team.create({ data: { id: 'B' } })
    await sys.teamMember.create({ data: { id: 'm', teamId: 'B', userId: 'u1' } })
    expect(await readIds(db, 'u1')).toEqual(['B'])
    db.$close()
  })

  it('a self-relation compares the child with the parent, not with itself', async () => {
    // Unaliased, `"user"."id" = "user"."managerId"` inside the subquery reads
    // the child's own two columns and admits a user who manages themself.
    const db: any = await createClient({ db: ':memory:', schema: `
model User {
  id        String  @id
  managerId String?
  manager   User?   @relation("reports", fields: [managerId], references: [id])
  reports   User[]  @relation("reports")
  @@allow('read', id == auth().id || reports.some(id == auth().id))
}
` })
    const sys = db.asSystem()
    await sys.user.create({ data: { id: 'boss' } })
    await sys.user.create({ data: { id: 'ann', managerId: 'boss' } })
    await sys.user.create({ data: { id: 'bob', managerId: 'boss' } })
    const read = async (who: string) =>
      (await db.$setAuth({ id: who }).user.findMany()).map((x: any) => x.id).sort()
    // ann reads herself and her manager — boss has a report who is ann.
    expect(await read('ann')).toEqual(['ann', 'boss'])
    expect(await read('boss')).toEqual(['boss'])
    db.$close()
  })
})

describe('the bound is one hop, and the mistake says where the rule goes', () => {
  it('a to-many test is accepted', async () => {
    expect(await refusal(TEAMS(`@@allow('read', members.some(userId == auth().id))`))).toBe('')
  })

  it('the to-many read as a PATH is refused and still points at a to-one', async () => {
    const msg = await refusal(TEAMS(`@@allow('read', members.userId == auth().id)`))
    expect(msg).toContain('hasMany')
  })

  it('.some() over a to-ONE is refused, naming the path it should be', async () => {
    const msg = await refusal(TEAMS('', `@@allow('read', team.some(private == false))`))
    expect(msg).toContain('to-one')
    expect(msg).toContain("'team.<column>'")
    expect(await refusal(TEAMS('', `@@allow('read', team.private == false)`))).toBe('')
  })

  it('a dot inside the condition is a second hop, refused at parse', async () => {
    const msg = await refusal(TEAMS(`@@allow('read', members.some(team.private == false))`))
    expect(msg).toContain('crosses a second relation')
  })

  it('check() inside the condition is a second hop too', async () => {
    const msg = await refusal(TEAMS(`@@allow('read', members.some(check(team)))`))
    expect(msg).toContain('second hop')
  })

  it("two relations away names the to-many test, not the hops", async () => {
    // jazzhr wrote `interview.scorecards.any(…)` and was told it crosses two
    // relations — true of the path, silent about where the rule belongs.
    const msg = await refusal(TEAMS('', `@@allow('read', team.members.some(userId == auth().id))`))
    expect(msg).toContain('two relations away')
    expect(msg).toContain("'members.some(…)'")
  })

  it('an unknown column names the CHILD model and its fields', async () => {
    const msg = await refusal(TEAMS(`@@allow('read', members.some(usrId == auth().id))`))
    expect(msg).toContain("TeamMember: 'usrId' is not a field")
    expect(msg).toContain('userId')
  })

  it('a column of the PARENT inside the condition is refused rather than read off the parent', async () => {
    // The subquery would resolve an unqualified `private` to the outer table
    // and answer a question nobody asked.
    const msg = await refusal(TEAMS(`@@allow('read', members.some(private == false))`))
    expect(msg).toContain("'private' is not a field")
  })

  it('an empty condition is refused', async () => {
    const msg = await refusal(TEAMS(`@@allow('read', members.some())`))
    expect(msg).toContain('needs a condition')
  })

  it('an unknown claim inside is refused like one outside', async () => {
    const msg = await refusal(TEAMS(`@@allow('read', members.some(userId == auth().nope))`).replace('model Team', 'claim teamIds\nmodel Team'))
    expect(msg).toContain("'nope' is not a claim")
  })
})

describe('a to-many test is a policy form and not a schema-wide one', () => {
  it('@derived refuses it and points at @from', async () => {
    const msg = await refusal(TEAMS('', '').replace('members TeamMember[]', 'members TeamMember[]\n  staffed Boolean @derived(members.some(status == "active"))'))
    expect(msg).toContain('crosses a relation')
    expect(msg).toContain('@from(members')
  })

  it('an index predicate refuses it', async () => {
    const msg = await refusal(TEAMS(`@@index([private], where: members.some(status == 'active'))`))
    expect(msg).toContain('crosses')
  })
})

// ─── the cost, which no assertion above can see ───────────────────────────────
//
// The EXISTS correlates on the CHILD's foreign key, and SQLite indexes no
// foreign key on its own. Unindexed, every parent row read builds a throwaway
// index over the children — correct rows, a cost no behavioral test sees. The
// owner of that fact already exists: `litestone advise`'s
// `foreign-key-without-index` names the column. So the pair is: advise names
// it when it is missing, and with the index it asks for the plan is a SEARCH.

describe('the EXISTS reaches the children by their foreign key', () => {
  const RULE = `@@allow('read', members.some(userId == auth().id))`

  it('advise names the foreign key the EXISTS correlates on when nothing indexes it', () => {
    const at = (cols: string) => checkRules(parse(TEAMS(RULE, cols)).schema)
      .filter((f: any) => f.id === 'foreign-key-without-index').map((f: any) => `${f.model}.${f.field}`)
    expect(at('')).toEqual(['TeamMember.teamId'])
    expect(at('@@index([teamId])')).toEqual([])
  })

  it('EXPLAIN says SEARCH on the child by that index, never an AUTOMATIC one', async () => {
    const dir  = mkdtempSync(join(tmpdir(), 'litestone-some-'))
    try {
      const plan = async (cols: string) => {
        const file = join(dir, `db${cols ? 'i' : ''}.sqlite`)
        const seen: any[] = []
        const db: any = await createClient({ schema: TEAMS(RULE, cols), db: file, onQuery: (e: any) => seen.push(e) })
        const sys = db.asSystem()
        // Past the point SQLite is right to scan.
        for (let i = 0; i < 300;  i++) await sys.team.create({ data: { id: 't' + i } })
        for (let i = 0; i < 3000; i++) await sys.teamMember.create({ data: { id: 'm' + i, teamId: 't' + (i % 300), userId: 'u' + (i % 50) } })
        await sys.sql`ANALYZE`
        seen.length = 0
        expect((await db.$setAuth({ id: 'u1' }).team.findMany()).length).toBeGreaterThan(0)
        const q = seen.find(e => e.operation === 'findMany')
        db.$close()
        expect(q.sql).toContain('EXISTS (SELECT 1 FROM "team_member" AS "__some" WHERE "__some"."teamId" = "team"."id"')
        const raw = new Database(file, { readonly: true })
        try {
          return (raw.prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...q.params) as any[]).map(r => r.detail).join(' | ')
        } finally { raw.close() }
      }

      const indexed = await plan('@@index([teamId])')
      expect(indexed).toMatch(/SEARCH __some (EXISTS )?USING (COVERING )?INDEX idx_team_member_teamId/)
      expect(indexed).not.toContain('AUTOMATIC')
      // The control, and what makes the two lines above an assertion: the same
      // bytes over the unindexed child are answered with an AUTOMATIC index, so
      // the plan CAN say the thing being ruled out.
      expect(await plan('')).toContain('AUTOMATIC')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60000)
})
