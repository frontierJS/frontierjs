// QuietSchedule -- local to this laptop: the caller's own row, one per member.
// Read with find; the first write is create, every later one a patch.
//
//   create { isEnabled?, days?, fromMinute, toMinute, timezone } -> the row
//   patch  { isEnabled?, days?, fromMinute?, toMinute?, timezone? }
//   days are 0 (Sunday) to 6; minutes are past midnight, 0 to 1439, in timezone
import { createService, BadRequest } from '@frontierjs/junction'
import { linkedCaller, oneRow } from '../../domain/chat/local.ts'

function checked (d: Record<string, unknown>): void {
  if ('days' in d) {
    const days = d.days
    if (!Array.isArray(days) || days.some(x => !Number.isInteger(x) || (x as number) < 0 || (x as number) > 6)) throw new BadRequest('days is a list of 0 (Sunday) to 6')
    d.days = [...new Set(days as number[])].sort()
  }
  if ('timezone' in d) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: String(d.timezone) }) } catch { throw new BadRequest('timezone is an IANA zone, such as America/Chicago') }
  }
}

function made (ctx: any): void {
  const d = oneRow(ctx, 'create')
  const { profile } = linkedCaller('setting quiet hours')
  checked(d)
  ctx.data = { ...d, profileExternalId: profile }
  ctx.system.add('profileExternalId')
}

function changed (ctx: any): void {
  checked(oneRow(ctx, 'patch'))
}

export default createService({
  model:    'QuietSchedule',
  channel:  'quietSchedules',
  paginate: { default: 10, max: 10 },
  hooks: { before: { create: [made], patch: [changed], update: [changed] } },
} as any)
