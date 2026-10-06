// tty.test.js — `$.tty`: keys, the footer, aside, onExit, and the terminal
// put back.
//
// The streams are fakes because a unit test has no terminal; what they fake is
// only what tty.js reads (isTTY, columns, setRawMode, write). The last block
// runs a real command through `script`, a pseudo-terminal, where Ctrl-C is a
// byte in raw mode and the runtime's own signal path has to carry onExit.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { EventEmitter } from 'events'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const __dir = dirname(fileURLToPath(import.meta.url))
global.fliRoot     = resolve(__dir, '..')
global.projectRoot = global.fliRoot

import { createTty, width, wrap, truncate, fit } from '../core/tty.js'
import { Command } from '../core/runtime.js'

const ERASE = '\r\x1b[2K'

const terminal = ({ tty = true, columns = 40 } = {}) => {
  const input = Object.assign(new EventEmitter(), {
    isTTY: tty, rawMode: false,
    setRawMode(on) { this.rawMode = on },
    resume() {}, pause() {},
  })
  const out = []
  const output = { isTTY: tty, columns, write(s) { out.push(String(s)); return true } }
  const errput = { isTTY: false, write(s) { out.push(`ERR:${s}`); return true } }
  const press = (k) => input.emit('data', Buffer.from(k))
  return { input, output, errput, out, press, text: () => out.join('') }
}

const make = (t, opts = {}) => createTty({ input: t.input, output: t.output, errput: t.errput, ...opts })

describe('measuring', () => {
  test('width counts what the screen shows', () => {
    expect(width('\x1b[1mab\x1b[22m')).toBe(2)
    expect(width('●·')).toBe(2)
  })

  test('wrap keeps each line its indent', () => {
    expect(wrap('  one two three four', 11)).toEqual(['  one two', '  three', '  four'])
    expect(wrap('a\n    b c', 5)).toEqual(['a', '    b', '    c'])
  })

  test('truncate cuts by visible width and keeps escape codes whole', () => {
    expect(truncate('\x1b[1mabcdef\x1b[22m', 3)).toBe('\x1b[1mabc\x1b[22m\x1b[0m')
    expect(truncate('ab\ncd', 10)).toBe('ab cd')
  })

  test('fit drops parts from the right, and empties never count', () => {
    expect(fit(['aaaa', null, 'bbbb', 'cccc'], ' · ', 12)).toBe('aaaa · bbbb')
    expect(fit(['aaaaaaaa'], ' · ', 4)).toBe('aaaa\x1b[0m')
  })
})

describe('keys', () => {
  test('one keypress answers, and the answer stays on screen', async () => {
    const t = terminal(), tty = make(t)
    const asked = tty.keys('Send #821?', { y: 'yes', e: 'edit', s: 'skip' })
    expect(t.input.rawMode).toBe(true)
    expect(t.text()).toContain('Send #821? [Y]es [e]dit [s]kip ')
    t.press('E')
    expect(await asked).toBe('e')
    expect(t.text()).toEndWith(`${ERASE}Send #821? [Y]es [e]dit [s]kip edit\n`)
    await tty.close()
    expect(t.input.rawMode).toBe(false)
  })

  test('Enter picks the first choice, or the one named enter; Esc only when named', async () => {
    const t = terminal(), tty = make(t)
    const first = tty.keys('Go?', { y: 'yes', n: 'no' })
    t.press('\r')
    expect(await first).toBe('y')

    const named = tty.keys('Back?', { d: 'delete', esc: 'back' })
    t.press('x')
    t.press('\x1b[A')
    t.press('\x1b')
    expect(await named).toBe('esc')
    await tty.close()
  })

  test('a question takes the keys from a bare listener whatever their age', async () => {
    const t = terminal(), tty = make(t)
    const asking = tty.keys('Send?', { y: 'yes', n: 'no' })
    const menu   = tty.keys(null, { y: 'why', q: 'quit' })
    t.press('y')
    expect(await asking).toBe('y')
    t.press('\r')
    t.press('q')
    expect(await menu).toBe('q')
    await tty.close()
  })

  test('Ctrl-C goes to the interrupt path', async () => {
    const t = terminal()
    let hit = 0
    const tty = make(t, { interrupt: () => hit++ })
    tty.keys('Go?', { y: 'yes' })
    t.press('\x03')
    expect(hit).toBe(1)
    await tty.close()
  })

  test('with no terminal it refuses by name; under emit it names fli gui', async () => {
    const piped = make(terminal({ tty: false }))
    await expect(piped.keys('Send?', { y: 'yes' })).rejects.toThrow(
      'tty.keys("Send?") needs a person at a terminal, and this run has none. Check tty.interactive before asking.')

    const gui = make(terminal(), { emit: () => {} })
    expect(gui.interactive).toBe(false)
    await expect(gui.keys('Send?', { y: 'yes' })).rejects.toThrow(/fli gui runs a command with no terminal/)
  })

  test('yes answers a question with its first choice and never opens stdin', async () => {
    const t = terminal({ tty: false }), tty = make(t, { yes: true })
    expect(await tty.keys('Send?', { s: 'skip', y: 'yes' })).toBe('s')
    expect(t.input.rawMode).toBe(false)
    await expect(tty.keys(null, { q: 'quit' })).rejects.toThrow(/needs a person/)
  })
})

describe('line', () => {
  test('a typed line answers, without its newline', async () => {
    const t = terminal(), tty = make(t)
    const asked = tty.line('Name?')
    expect(t.text()).toContain('Name? ')
    t.press('maid\n')
    expect(await asked).toBe('maid')
    await tty.close()
  })

  test('an empty answer is the default, which the prompt shows', async () => {
    const t = terminal(), tty = make(t)
    const asked = tty.line('Branch?', { default: 'main' })
    expect(t.text()).toContain('Branch? (main) ')
    t.press('\n')
    expect(await asked).toBe('main')
    await tty.close()
  })

  test('raw mode is handed back for the line and taken again after, so keys() still hears', async () => {
    const t = terminal(), tty = make(t)
    const first = tty.keys('Go?', { y: 'yes', n: 'no' })
    expect(t.input.rawMode).toBe(true)
    t.press('y')
    expect(await first).toBe('y')
    const line = tty.line('Why?')
    await new Promise(r => setTimeout(r, 0))
    expect(t.input.rawMode).toBe(false)
    t.press('because\n')
    expect(await line).toBe('because')
    expect(t.input.rawMode).toBe(true)
    const again = tty.keys('Sure?', { y: 'yes', n: 'no' })
    t.press('n')
    expect(await again).toBe('n')
    await tty.close()
  })

  test('--yes answers the default, and no terminal refuses by name', async () => {
    const t = terminal()
    expect(await make(t, { yes: true }).line('Name?', { default: 'x' })).toBe('x')
    expect(await make(t, { yes: true }).line('Name?')).toBe('')
    const piped = make(terminal({ tty: false }))
    await expect(piped.line('Name?')).rejects.toThrow('tty.line("Name?") needs a person at a terminal')
    expect(piped.interactive).toBe(false)
  })
})

describe('live', () => {
  test('output prints above the footer, which is redrawn after it', async () => {
    const t = terminal(), tty = make(t)
    tty.live(() => 'status')
    t.output.write('hello\n')
    expect(t.out).toEqual(['status', ERASE, 'hello\n', 'status'])
    await tty.close()
  })

  // Bun's console writes to the fd and never calls process.stdout.write, and
  // `log` and `echo` are both console.log.
  test('console prints above the footer too', async () => {
    const t = terminal()
    const real = console.log
    const fake = (s) => t.out.push(`${s}\n`)
    console.log = fake
    try {
      const tty = make(t)
      tty.live(() => 'status')
      console.log('hello')
      expect(t.out).toEqual(['status', ERASE, 'hello\n', 'status'])
      await tty.close()
      expect(console.log).toBe(fake)
    } finally {
      console.log = real
    }
  })

  test('a partial line is finished before the footer comes back', async () => {
    const t = terminal(), tty = make(t)
    tty.live(() => 'status')
    t.output.write('a')
    t.output.write('b\n')
    expect(t.out).toEqual(['status', ERASE, 'a', 'b\n', 'status'])
    await tty.close()
  })

  test('update redraws only on a change, and parts drop to fit', async () => {
    const t = terminal({ columns: 16 }), tty = make(t)
    let n = 1
    const bar = tty.live(() => [`● ${n}`, 'waiting', 'next 12s'])
    bar.update()
    expect(t.out).toEqual(['● 1 · waiting'])
    n = 2
    bar.update()
    expect(t.out.at(-1)).toBe('● 2 · waiting')
    bar.stop()
    expect(t.out.at(-1)).toBe(ERASE)
    await tty.close()
  })

  test('an open question is the footer until it is answered', async () => {
    const t = terminal(), tty = make(t)
    tty.live(() => 'status')
    const asked = tty.keys('Go?', { y: 'yes' })
    expect(t.out.at(-1)).toBe('Go? [Y]es ')
    t.press('y')
    await asked
    expect(t.out.at(-1)).toBe('status')
    await tty.close()
  })

  test('with no terminal it writes nothing and patches nothing', async () => {
    const t = terminal({ tty: false }), tty = make(t)
    const write = t.output.write
    tty.live(() => 'status').update()
    expect(t.out).toEqual([])
    expect(t.output.write).toBe(write)
    await tty.close()
  })
})

describe('aside', () => {
  test('lends the keyboard out and holds output until it returns', async () => {
    const t = terminal(), tty = make(t)
    tty.live(() => 'status')
    const menu = tty.keys(null, { q: 'quit' })
    let during
    await tty.aside(async () => {
      during = t.input.rawMode
      t.output.write('late\n')
      expect(t.text()).not.toContain('late')
    })
    expect(during).toBe(false)
    expect(t.input.rawMode).toBe(true)
    expect(t.text()).toContain('late\n')
    expect(t.out.at(-1)).toBe('status')
    t.press('q')
    expect(await menu).toBe('q')
    await tty.close()
  })
})

describe('close', () => {
  test('puts the terminal back: footer erased, raw off, title cleared, writes unpatched', async () => {
    const t = terminal(), tty = make(t)
    const write = t.output.write
    tty.title('● 2 waiting')
    tty.live(() => 'status')
    tty.keys(null, { q: 'quit' })
    await tty.close()
    expect(t.input.rawMode).toBe(false)
    expect(t.output.write).toBe(write)
    expect(t.out.slice(-2)).toEqual([ERASE, '\x1b]0;\x07'])
  })

  test('runs every onExit once, and a hung one does not hold it past the cap', async () => {
    const t = terminal(), tty = make(t, { cap: 30 })
    let ran = 0
    tty.onExit(() => { ran++ })
    tty.onExit(() => new Promise(() => {}))
    await Promise.all([tty.close(), tty.close()])
    expect(ran).toBe(1)
    expect(t.out).toContain('ERR:onExit did not finish in 0.03s; exiting anyway\n')
  })
})

// ─── through the runtime ────────────────────────────────────────────────────

describe('Command() closes the tty', () => {
  let dir
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fli-tty-')) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const command = (name, body) => {
    const file = join(dir, `${name}.md`)
    writeFileSync(file, ['---', `title: probe:${name}`, '---', '', '```js', body, '```', ''].join('\n'))
    return file
  }

  test('onExit runs on a return and on a throw', async () => {
    const mark = join(dir, 'marks')
    const ok  = command('ok',  `tty.onExit(() => fs.appendFileSync(${JSON.stringify(mark)}, 'ok '))`)
    const bad = command('bad', `tty.onExit(() => fs.appendFileSync(${JSON.stringify(mark)}, 'bad '))\nthrow new Error('boom')`)
    await (await Command({ file: ok, arg: [], flag: {} }))()
    await expect((await Command({ file: bad, arg: [], flag: {} }))()).rejects.toThrow('boom')
    expect(readFileSync(mark, 'utf8')).toBe('ok bad ')
  })

  test('an emitted run is never interactive', async () => {
    const file = command('gui', `echo(String(tty.interactive))`)
    const events = []
    await (await Command({ file, arg: [], flag: {}, emit: (e) => { events.push(e); return Promise.resolve() } }))()
    expect(events.map(e => e.text).join('')).toBe('false\n')
  })

  // `script` gives the command a real pseudo-terminal: in raw mode Ctrl-C is a
  // byte, and in cooked mode the terminal signals every process on it, fli and
  // its child both. Either way onExit has to be reached through the runtime.
  const hasScript = spawnSync('script', ['--version']).status === 0
  const inPty = (name, body, env = {}) => {
    const file   = command(name, body.join('\n'))
    const runner = join(dir, `${name}.mjs`)
    writeFileSync(runner, [
      `global.fliRoot = ${JSON.stringify(global.fliRoot)}`,
      'global.projectRoot = global.fliRoot',
      `const { Command } = await import(${JSON.stringify(join(global.fliRoot, 'core/runtime.js'))})`,
      `await (await Command({ file: ${JSON.stringify(file)}, arg: [], flag: {} }))()`,
    ].join('\n'))
    // The byte waits a second for the command to get going; `-e` returns its status.
    // The runner's own color switches are dropped: CI sets CI=1 and FORCE_COLOR=0,
    // chalk honors both, and *without NO_COLOR chalk colors* then fails for CI's reason.
    const inherited = { ...process.env }
    for (const key of ['CI', 'FORCE_COLOR', 'NO_COLOR']) delete inherited[key]
    return spawnSync('sh', ['-c', `(sleep 1; printf '\\003'; sleep 2) | script -qec "${process.execPath} ${runner}" /dev/null`],
      { encoding: 'utf8', timeout: 15000, env: { ...inherited, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...env } })
  }
  const away = (mark) => `tty.onExit(async () => { await Bun.sleep(50); fs.writeFileSync(${JSON.stringify(mark)}, 'away') })`

  // A body's chalk is color.js's, and follows its rule: nothing styled into a
  // pipe or under NO_COLOR, truecolor at a terminal.
  const PAINT = `echo(JSON.stringify([chalk.hex('#9fc612')('l'), chalk.bold(chalk.red('r'))]))`

  test('a piped body gets a chalk that styles nothing', async () => {
    const file = command('paint', PAINT)
    const r = spawnSync(process.execPath, ['-e', [
      `global.fliRoot = ${JSON.stringify(global.fliRoot)}; global.projectRoot = global.fliRoot`,
      `const { Command } = await import(${JSON.stringify(join(global.fliRoot, 'core/runtime.js'))})`,
      `await (await Command({ file: ${JSON.stringify(file)}, arg: [], flag: {} }))()`,
    ].join('\n')], { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '', NO_COLOR: '' } })
    expect(r.stdout.trim()).toBe('["l","r"]')
  })

  test.skipIf(!hasScript)('NO_COLOR at a terminal turns chalk off; without it chalk colors', () => {
    expect(inPty('paint-off', [PAINT], { NO_COLOR: '1' }).stdout).toContain('["l","r"]')
    expect(inPty('paint-on', [PAINT]).stdout).toContain('\\u001b[38;2;159;198;18ml')
  })

  test.skipIf(!hasScript)('Ctrl-C at a keys prompt runs onExit and exits 130', () => {
    const mark = join(dir, 'away-keys')
    const r = inPty('keys', [away(mark), `tty.live(() => 'online')`, `await tty.keys('Go?', { y: 'yes' })`, `echo('not reached')`])
    expect(r.status).toBe(130)
    expect(existsSync(mark) && readFileSync(mark, 'utf8')).toBe('away')
    expect(r.stdout).not.toContain('not reached')
  })

  test.skipIf(!hasScript)('Ctrl-C during $.stream runs onExit and exits 130', () => {
    const mark = join(dir, 'away-stream')
    const r = inPty('stream', [away(mark), `await $.stream({ command: 'sleep 5' })`, `echo('not reached')`])
    expect(r.status).toBe(130)
    expect(existsSync(mark) && readFileSync(mark, 'utf8')).toBe('away')
    expect(r.stdout).not.toContain('not reached')
  })

  test.skipIf(!hasScript)('Ctrl-C inside aside is the child\'s, and the command carries on', () => {
    const r = inPty('aside', [
      `try { await tty.aside(() => $.stream({ command: 'sleep 5' })) } catch (e) { echo('caught ' + e.message) }`,
      `echo('carried on')`,
    ])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('caught interrupted: sleep 5')
    expect(r.stdout).toContain('carried on')
  })
})
