import { expect, mock, test } from 'claude-code/testing'

const OPTIONS = { relayUrl: 'http://relay.test:7777/', name: 'alice', key: 'k' }

const POLL = {
  messages: [],
  peers: [
    { name: 'alice', online: true, lastSeen: 0, activity: 'idle', leader: true },
    { name: 'bob', online: true, lastSeen: 0, activity: 'working', leader: false },
  ],
  tasks: [{ id: 3, title: 'Write login tests', note: '', status: 'open', owner: null, assignee: 'bob', by: 'alice', at: 0 }],
  leader: 'alice',
  shared: [],
  cursor: 7,
}

function fakeRelay(on: any, seen: { url: string; init: any }[] = []) {
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  on('http.fetch', async (_$: unknown, e: any) => {
    seen.push({ url: e.url, init: e.init })
    const body = e.url.includes('raw.githubusercontent.com')
      ? { version: LATEST }
      : e.url.includes('/send')
      ? { id: 7, from: 'alice', to: 'bob', kind: 'request', text: 'review auth', at: 0 }
      : e.url.includes('/leader')
        ? { leader: JSON.parse(e.init.body).name || null }
        : POLL
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  return seen
}

let LATEST = '0.3.0'

const PANE = { component: 'Pane', requestId: 'crew', props: { bodyColumns: 80 }, viewport: { columns: 100, rows: 40 } } as any

test('crew_send posts to the relay with the crew headers', { options: OPTIONS }, async ($, on) => {
  const seen = fakeRelay(on)

  const ran: any = await $.tool.call({ tool: 'mcp__crew__crew_send', text: 'review auth', to: 'bob', kind: 'request' } as any)

  expect(ran.result).toBe('Sent #7 to bob.')
  const send = seen.find(s => s.url === 'http://relay.test:7777/send')
  expect(send?.init.headers['X-Crew-Name']).toBe('alice')
  expect(JSON.parse(send?.init.body).kind).toBe('request')
})

test('a relay error reaches the model as a denial with the reason', { options: OPTIONS }, async ($, on) => {
  on('http.fetch', async () => ({ value: { status: 401, ok: false, headers: {}, text: '{"error":"bad key"}' } }))

  const ran: any = await $.tool.call({ tool: 'mcp__crew__crew_send', text: 'hi' } as any)

  expect(String(ran.text ?? ran.deny)).toContain('relay 401: bad key')
})

test('the leader gets leader instructions in the system prompt', { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }) as any)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)

  const composed: any = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)

  const role = composed.sections.find((s: any) => s.id === 'crew:role')
  expect(role.text).toContain('You are the crew LEADER')
  expect(role.text).toContain("don't loop on crew_wait") // waiting on a teammate shouldn't burn tokens
})

test('the pane draws leader, crew, tasks and settings on terminal and desktop', { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'crew', surface, ...PANE })
    expect(await ui.find({ key: 'say' })).toBeDefined() // Chat is the tab /crew opens on
    await ui.press({ key: 'tab-crew' })
    expect(await ui.find({ key: 'leader' })).toBeDefined()
    expect(await ui.find({ text: /bob.*working/ } as any)).toBeDefined()
    await ui.press({ key: 'tab-tasks' })
    expect(await ui.find({ text: /for bob/ } as any)).toBeDefined()
    expect(await ui.find({ key: 'leader' })).toBeUndefined() // one tab at a time
    expect(await ui.find({ key: 'opt-relayUrl' })).toBeUndefined()
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'opt-relayUrl' })).toBeDefined()
    expect(await ui.find({ key: 'opt-autoRun' })).toBeDefined()
    await ui.press({ key: 'settings' })
    expect(await ui.find({ text: /for bob/ } as any)).toBeDefined() // closing Settings goes back to the tab you were on
    await ui.press({ key: 'tab-chat' }) // /crew reopens on the last tab, so leave it where the next surface starts
    await ui.unmount()
  }
})

test('picking a leader in the pane tells the relay', { options: OPTIONS }, async ($, on) => {
  const seen = fakeRelay(on)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)

  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-crew' })
  await ui.select({ key: 'leader', value: 'bob' })
  await ui.press({ key: 'leader-yes' }) // leader changes ask first
  await ui.unmount()

  const call = seen.find(s => s.url.endsWith('/leader'))
  expect(JSON.parse(call?.init.body).name).toBe('bob')
})

test('without settings the pane opens on the settings block', async ($, on) => {
  fakeRelay(on)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ key: 'setup-name' })).toBeDefined() // the guided setup starts with your name
  expect(await ui.find({ key: 'leader' })).toBeUndefined()
  await ui.unmount()
})

test('a newer version on GitHub shows the update banner, the current one does not', { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  LATEST = '0.3.0'
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'crew', surface, ...PANE })
    expect(await ui.find({ key: 'update' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the update check toasts and the pane offers the commands', { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  LATEST = '9.9.9'
  const toasts: string[] = []
  on('ui.toast', async (_$: unknown, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  mock.clock(on)
  on('tool.register', async () => ({ value: undefined }) as any)
  on('command.register', async () => ({ value: undefined }) as any)
  on('session.start', async (_$: unknown, e: any) => e)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  // the update check runs in the background; let it land
  await new Promise(r => setTimeout(r, 100))
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ key: 'update' })).toBeDefined()
  await ui.unmount()
  expect(toasts.some(t => t.includes('9.9.9'))).toBe(true)
  LATEST = '0.3.0'
})

test('hitting the usage limit tells the crew, and a good answer later says we are back', { options: OPTIONS }, async ($, on) => {
  const seen = fakeRelay(on)
  on('classic.StopFailure', async () => ({}) as any)
  on('turn.complete', async () => ({ text: '' }) as any)

  await $.classic.StopFailure({ error: 'rate_limit' } as any)
  await $.classic.StopFailure({ error: 'rate_limit' } as any)
  await $.turn.complete({ reason: 'answer', text: 'done' } as any)

  const sends = seen.filter(s => s.url.endsWith('/send')).map(s => JSON.parse(s.init.body))
  expect(sends.map(b => b.kind)).toEqual(['out', 'back'])
  expect(sends[0].text).toContain('ran out of tokens')
  const polls = seen.filter(s => s.url.includes('/send'))
  expect(polls[0].init.headers['X-Crew-Activity']).toBe('out')
})

test('a teammate running out reaches the conversation with the pookie line', { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  const session = mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', async (_$: unknown, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', async (_$: unknown, e: any) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        ...POLL,
        leader: 'carol',
        messages: [{ id: 2, from: 'bob', to: 'all', kind: 'out', text: 'bob ran out of tokens. Their limit resets in about 1h 5m.', at: 0 }],
        cursor: 2,
      }),
    },
  }))

  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)

  const rows = session.appended().map(r => JSON.stringify(r.message.content))
  expect(rows.some(r => r.includes('Oh no our pookie has no more tokens!'))).toBe(true)
  expect(toasts.some(t => t.includes('bob has no more tokens'))).toBe(true)
})

const settle = (ms = 60) => new Promise(r => setTimeout(r, ms))

test('a new prompt makes this Clawd cheer', { options: OPTIONS }, async ($, on) => {
  const seen = fakeRelay(on)
  on('prompt.submit', async (_$: unknown, e: any) => e)
  await $.prompt.submit({ text: 'build the thing' } as any)
  await settle()
  expect(seen[seen.length - 1].init.headers['X-Crew-Activity']).toBe('cheer')
})

test('subagents show up as mini Clawds, and a finished turn dances', { options: OPTIONS }, async ($, on) => {
  const seen = fakeRelay(on)
  on('turn.start', async (_$: unknown, e: any) => ({ turnId: e.turnId ?? 't1' }) as any)
  on('turn.complete', async () => ({ text: '' }) as any)
  let during: any = {}
  on('tool.call', async () => {
    await settle(80)
    during = { ...seen[seen.length - 1].init.headers }
    return { result: 'ok' } as any
  })
  await $.turn.start({ turnId: 't1' } as any)
  await settle(750)
  await $.tool.call({ tool: 'Agent', prompt: 'look around', description: 'x' } as any)
  expect(during['X-Crew-Subagents']).toBe('1')
  await settle(750)
  await $.tool.call({ tool: 'Write', file_path: '/tmp/a.txt', content: 'hi' } as any)
  expect(during['X-Crew-Activity']).toBe('typing')
  await $.turn.complete({ reason: 'answer', text: 'done' } as any)
  await settle()
  expect(seen[seen.length - 1].init.headers['X-Crew-Activity']).toBe('done')
  expect(seen[seen.length - 1].init.headers['X-Crew-Subagents']).toBe('0')
})
test('/crew pops out the Clawds window, unless that is switched off', { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  const launched: string[][] = []
  on('process.run', async (_$: unknown, e: any) => {
    launched.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as any)
  await $.command.run({ command: 'crew', args: '' } as any)
  await settle()
  expect(launched.some(argv => argv.join(' ').includes('clawd_window.py'))).toBe(true)
})

test('with the Clawds window switched off, /crew opens only the pane', { options: { ...OPTIONS, clawdsWindow: 'no' } }, async ($, on) => {
  fakeRelay(on)
  const launched: string[][] = []
  on('process.run', async (_$: unknown, e: any) => {
    launched.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as any)
  await $.command.run({ command: 'crew', args: '' } as any)
  await settle()
  expect(launched.length).toBe(0)
})
test('Check for updates, then Install update downloads crew from GitHub and copies it over the plugin', { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  LATEST = '9.9.9'
  mock.env(on, { TEMP: 'C:\\Temp' })
  const ran: string[][] = []
  on('process.run', async (_$: unknown, e: any) => {
    ran.push([...e.argv])
    // not a git checkout; robocopy's 1 means "files copied"
    return { value: { exitCode: e.argv[0] === 'robocopy' ? 1 : 0, stdout: 'no', stderr: '' } }
  })
  on('fs.read', async (_$: unknown, e: any) =>
    String(e.path).includes('.git') ? ({ deny: 'ENOENT' } as any) : ({ value: '{"version":"9.9.9"}' } as any),
  )
  const logs: string[] = []
  on('fs.write', async (_$: unknown, e: any) => {
    logs.push(String(e.content ?? e.text ?? ''))
    return { value: undefined } as any
  })
  on('ui.toast', async () => ({ value: undefined }))
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'check-update' })
  await settle(100)
  expect(await ui.find({ key: 'install' })).toBeDefined()
  await ui.press({ key: 'install' })
  await settle(100)
  expect(await ui.find({ text: /Restart Claude/ } as any)).toBeDefined()
  await ui.unmount()
  const lines = ran.map(a => a.join(' '))
  expect(lines.some(l => l.startsWith('curl.exe') && l.endsWith('main.zip'))).toBe(true)
  expect(lines.some(l => l.startsWith('tar.exe -xf'))).toBe(true)
  const copy = lines.find(l => l.startsWith('robocopy')) ?? ''
  expect(copy).toContain('crew_key.txt') // the relay's key is never overwritten
  expect(lines.some(l => l.includes('plugin marketplace update'))).toBe(false) // no CLI needed
  // the temp folder is made without nesting double quotes inside one argument (cmd mangles those)
  expect(lines.some(l => l.startsWith('cmd') && l.includes('"'))).toBe(false)
  expect(logs.some(l => l.includes('> curl.exe'))).toBe(true) // every step lands in crew-update.log
  LATEST = '0.3.0'
})

// -- the crew session: joining, leaving, asking after a restart

function startSession(on: any, $: any) {
  mock.clock(on)
  on('tool.register', async () => ({ value: undefined }) as any)
  on('command.register', async () => ({ value: undefined }) as any)
  on('session.start', async (_$: unknown, e: any) => e)
  return $.session.start({ source: 'startup', cwd: '/tmp' } as any)
}

test('Leave session tells the relay at once; Join session brings us back', { options: OPTIONS }, async ($, on) => {
  const seen = fakeRelay(on)
  on('ui.toast', async () => ({ value: undefined }))
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'leave' })
  await ui.press({ key: 'leave-yes' }) // Leave… asks first
  await settle()
  expect(seen.some(s => s.url.endsWith('/leave'))).toBe(true)
  const r: any = await $.tool.call({ tool: 'mcp__crew__crew_send', text: 'hi' } as any)
  expect(String(r.result)).toContain('not in the crew session')
  expect(await ui.find({ key: 'join' })).toBeDefined()
  const before = seen.length
  await ui.press({ key: 'join' })
  await settle()
  expect(seen.slice(before).some(s => s.url.includes('/poll'))).toBe(true)
  await ui.unmount()
})

test('reopening Claude after being in a crew asks before rejoining', { options: OPTIONS }, async ($, on) => {
  const seen: { url: string; init: any }[] = []
  mock.store(on, { 'membership:http://relay.test:7777': 'joined' })
  on('http.fetch', async (_$: unknown, e: any) => {
    seen.push({ url: e.url, init: e.init })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(POLL) } }
  })
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  await startSession(on, $)
  await settle()
  expect(seen.some(s => s.url.includes('/poll'))).toBe(false) // not back in until they say so
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ key: 'rejoin' })).toBeDefined()
  await ui.press({ key: 'rejoin' })
  await settle()
  expect(seen.some(s => s.url.includes('/poll'))).toBe(true)
  expect(await ui.find({ key: 'rejoin' })).toBeUndefined()
  await ui.unmount()
})

test('closing Claude says goodbye to the crew straight away', { options: OPTIONS }, async ($, on) => {
  const seen = fakeRelay(on)
  on('session.end', async () => ({ sessionId: 's' }) as any)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's', resume: {} } as any)
  const leave = seen.find(s => s.url.endsWith('/leave'))
  expect(JSON.parse(leave?.init.body).why).toBe('closed their Claude')
})

test('a teammate leaving reaches the conversation, with what to do about their tasks', { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  const session = mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('http.fetch', async () => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        ...POLL,
        messages: [{ id: 5, from: 'bob', to: 'all', kind: 'leave', text: 'bob closed their Claude. They were working on: #3 Write login tests.', at: 0 }],
        cursor: 5,
      }),
    },
  }))
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const rows = session.appended().map(r => JSON.stringify(r.message.content))
  expect(rows.some(r => r.includes('bob closed their Claude') && r.includes('reassign'))).toBe(true)
})

test('images: crew_send_image uploads the file; an incoming one is saved for the Read tool', { options: OPTIONS }, async ($, on) => {
  const seen: { url: string; init: any }[] = []
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  const session = mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('fs.read', async () => ({ value: { base64: 'aGVsbG8=' } }) as any)
  const ran: string[][] = []
  on('process.run', async (_$: unknown, e: any) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  let pollCount = 0
  on('http.fetch', async (_$: unknown, e: any) => {
    seen.push({ url: e.url, init: e.init })
    if (e.url.endsWith('/files'))
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ id: 9, to: 'bob', name: 'shot.png', size: 5 }) } }
    pollCount += 1
    const incoming = { id: 6, from: 'bob', to: 'alice', kind: 'image', text: 'sent an image: ui.png', at: 0, file: 'abc123', name: 'ui.png', caption: 'new header' }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, messages: pollCount === 1 ? [incoming] : [], cursor: 6 }) } }
  })

  const r: any = await $.tool.call({ tool: 'mcp__crew__crew_send_image', path: 'C:\\shots\\shot.png', to: 'bob' } as any)
  expect(String(r.result)).toContain('Sent image')
  const upload = seen.find(s => s.url.endsWith('/files'))
  expect(JSON.parse(upload?.init.body)).toMatchObject({ name: 'shot.png', mime: 'image/png', data: 'aGVsbG8=', to: 'bob' })

  const curl = ran.find(a => a[0] === 'curl.exe')
  expect(curl?.join(' ')).toContain('/file?id=abc123')
  expect(curl?.join(' ')).toContain('C:\\Users\\t\\.claude\\crew-inbox\\6-ui.png')
  const rows = session.appended().map(row => JSON.stringify(row.message.content))
  expect(rows.some(row => row.includes('crew-inbox') && row.includes('Read tool'))).toBe(true)
})

test('Refresh reconnects right away, and explains a relay that is down', { options: OPTIONS }, async ($, on) => {
  let up = false
  const toasts: string[] = []
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async (_$: unknown, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.url.includes('raw.githubusercontent.com'))
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ version: '0.0.1' }) } }
    if (!up) return { deny: 'ECONNREFUSED: Unable to connect' } as any
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(POLL) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ text: /Is it running\?/ } as any)).toBeDefined()
  up = true
  await ui.press({ key: 'refresh' })
  await settle(100)
  expect(toasts.some(t => t.includes('connected'))).toBe(true)
  expect(await ui.find({ text: /Is it running\?/ } as any)).toBeUndefined()
  await ui.unmount()
})

test('Host a crew opens start-relay.bat, takes its key and joins the session', { options: { ...OPTIONS, relayUrl: '', key: '' } }, async ($, on) => {
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  on('clock.sleep', async () => ({ value: undefined }) as any)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('fs.read', async (_$: unknown, e: any) =>
    String(e.path).endsWith('crew_key.txt') ? ({ value: 'batkey123\n' } as any) : ({ deny: 'ENOENT' } as any),
  )
  let started = false
  const ran: string[][] = []
  on('process.run', async (_$: unknown, e: any) => {
    ran.push([...e.argv])
    if (e.argv.some((a: string) => a.includes('start-relay.bat'))) started = true
    const stdout = e.argv[0] === 'ipconfig' ? '   IPv4 Address. . . : 192.168.1.5\r\n   IPv4 Address. . . : 26.12.34.56\r\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.url.endsWith('/health')) {
      if (!started) return { deny: 'ECONNREFUSED: Unable to connect' } as any
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok": true, "version": "0.8.2"}' } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(POLL) } }
  })
  const sets: any[] = []
  on('config.set', async (_$: unknown, e: any) => {
    sets.push(e)
    return { value: e.value } as any
  })
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'host' })
  await settle(200)
  await ui.unmount()
  // opened detached through Start-Process, so Claude's process runner never waits on the relay window
  expect(ran.some(a => a[0] === 'powershell' && a.join(' ').includes("Start-Process -FilePath '") && a.join(' ').includes("start-relay.bat'"))).toBe(true)
  expect(sets.find(s => s.key === 'crew.key')?.value).toBe('batkey123')
  expect(sets.find(s => s.key === 'crew.relayUrl')?.value).toBe('http://127.0.0.1:7777')
})
test("a host whose relay is down sees it, and Start relay opens start-relay.bat", { options: { ...OPTIONS, relayUrl: 'http://127.0.0.1:7777' } }, async ($, on) => {
  mock.store(on)
  on('clock.sleep', async () => ({ value: undefined }) as any)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  let started = false
  on('process.run', async (_$: unknown, e: any) => {
    if (e.argv.some((a: string) => a.includes('start-relay.bat'))) started = true
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('http.fetch', async (_$: unknown, e: any) => {
    if (!started) return { deny: 'ECONNREFUSED: Unable to connect' } as any
    if (e.url.endsWith('/health')) return { value: { status: 200, ok: true, headers: {}, text: '{"ok": true, "version": "0.8.3"}' } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(POLL) } }
  })
  on('ui.open', async () => ({ value: undefined }) as any)
  await $.command.run({ command: 'crew', args: '' } as any) // relay down: Settings opens by itself
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'refresh' })
  await settle(100)
  expect(await ui.find({ text: /relay isn't running/ } as any)).toBeDefined()
  expect(await ui.find({ key: 'host-settings' })).toBeUndefined() // no "Hosting ✓" before it's actually up
  await ui.press({ key: 'start-relay-settings' })
  await settle(200)
  expect(started).toBe(true)
  expect(await ui.find({ text: /relay isn't running/ } as any)).toBeUndefined()
  expect((await ui.find({ key: 'host-settings' }))?.text).toContain('Hosting ✓')
  await ui.unmount()
})
test('one press of Stop hosting stops the relay and /crew shows it straight away', { options: { ...OPTIONS, relayUrl: 'http://127.0.0.1:7777' } }, async ($, on) => {
  mock.store(on)
  on('clock.sleep', async () => ({ value: undefined }) as any)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  let up = true
  let afterStop = 0 // like the real relay: it answers /shutdown first, and is gone a couple of checks later
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.url.endsWith('/shutdown')) {
      afterStop = 1
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok": true}' } }
    }
    if (afterStop && afterStop++ > 2) up = false
    if (!up) return { deny: 'ECONNREFUSED: Unable to connect' } as any
    if (e.url.endsWith('/health')) return { value: { status: 200, ok: true, headers: {}, text: '{"ok": true, "version": "0.8.8"}' } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(POLL) } }
  })
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'refresh' })
  await settle(100)
  await ui.press({ key: 'tab-crew' }) // the invite and Stop hosting live on the Crew tab while the relay runs
  expect(await ui.find({ key: 'stop-host' })).toBeDefined()
  await ui.press({ key: 'stop-host' })
  await settle(200)
  expect(await ui.find({ text: /relay isn't running/ } as any)).toBeDefined()
  expect(await ui.find({ key: 'stop-host' })).toBeUndefined()
  await ui.unmount()
})
test('a host still running an old relay gets Restart relay, which stops it and starts the new one', { options: { ...OPTIONS, relayUrl: 'http://127.0.0.1:7777' } }, async ($, on) => {
  mock.store(on)
  on('clock.sleep', async () => ({ value: undefined }) as any)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  let running: string | null = '0.0.1' // the old relay
  const posted: string[] = []
  on('process.run', async (_$: unknown, e: any) => {
    if (e.argv.some((a: string) => a.includes('start-relay.bat'))) running = '99.0.0'
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.init?.method === 'POST') {
      posted.push(e.url)
      if (e.url.endsWith('/shutdown')) running = null
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok": true}' } }
    }
    if (!running) return { deny: 'ECONNREFUSED: Unable to connect' } as any
    if (e.url.endsWith('/health')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, version: running }) } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, version: running }) } }
  })
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'refresh' })
  await settle(100)
  expect(await ui.find({ key: 'restart-relay' })).toBeDefined()
  await ui.press({ key: 'restart-relay' })
  await settle(300)
  expect(posted.some(u => u.endsWith('/shutdown'))).toBe(true)
  expect(running).toBe('99.0.0') // the new version's start-relay.bat ran
  expect(await ui.find({ key: 'restart-relay' })).toBeUndefined()
  await ui.unmount()
})
test('Reset chat warns first; Cancel does nothing, Yes clears the chat for everyone', { options: OPTIONS }, async ($, on) => {
  let epoch = 0
  const posted: string[] = []
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.init?.method === 'POST') {
      posted.push(e.url)
      if (e.url.endsWith('/reset')) epoch += 1
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok": true}' } }
    }
    const messages = epoch === 0 ? [{ id: 2, from: 'bob', to: 'all', kind: 'chat', text: 'old stuff', at: 0 }] : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, messages, chatEpoch: epoch, cursor: 2 }) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ text: /old stuff/ } as any)).toBeDefined()

  await ui.press({ key: 'reset-chat' })
  expect(await ui.find({ text: /Reset the chat for everyone\?/ } as any)).toBeDefined()
  await ui.press({ key: 'reset-no' })
  expect(posted.some(u => u.endsWith('/reset'))).toBe(false)
  expect(await ui.find({ key: 'reset-yes' })).toBeUndefined()

  await ui.press({ key: 'reset-chat' })
  await ui.press({ key: 'reset-yes' })
  await settle(100)
  expect(posted.some(u => u.endsWith('/reset'))).toBe(true)
  expect(await ui.find({ text: /old stuff/ } as any)).toBeUndefined()
  await ui.unmount()
})

test('Save chat writes the chat and task board to ~/.claude/crew-chats', { options: OPTIONS }, async ($, on) => {
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
  const written: { path: string; text: string }[] = []
  on('fs.write', async (_$: unknown, e: any) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined } as any
  })
  on('http.fetch', async () => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ ...POLL, messages: [{ id: 4, from: 'bob', to: 'all', kind: 'chat', text: 'sprint works!', at: 1791700000 }] }),
    },
  }))
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'save-chat' })
  await settle(100)
  await ui.unmount()
  const file = written.find(w => w.path.includes('crew-chats'))
  expect(file?.path).toMatch(/C:\\Users\\t\\\.claude\\crew-chats\\crew-chat-.*\.md$/)
  expect(file?.text).toContain('sprint works!')
  expect(file?.text).toContain('Write login tests')
})

test('rejoining a crew briefs your Claude: open tasks and recent messages', { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'membership:http://relay.test:7777': 'joined', 'cursor:http://relay.test:7777': 9 })
  const session = mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('http.fetch', async () => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ ...POLL, messages: [{ id: 8, from: 'bob', to: 'all', kind: 'chat', text: 'old news', at: 1791690000 }, { id: 10, from: 'bob', to: 'all', kind: 'chat', text: 'walk anim is in', at: 1791700000 }], cursor: 10 }),
    },
  }))
  await startSession(on, $)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'rejoin' })
  await settle(100)
  await ui.unmount()
  const rows = session.appended().map(r => JSON.stringify(r.message.content))
  const brief = rows.find(r => r.includes('crew-catchup')) ?? ''
  expect(brief).toContain('Write login tests')
  expect(brief).toContain('walk anim is in')
  expect(brief).not.toContain('old news') // only what's new since we were last here
  expect(brief).toContain('1 older message not shown')
  expect(brief).toContain('You are the crew leader')
})

test('a busy Claude never stalls the check-ins (the flickering-offline bug)', { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  // Claude is mid-turn: a queued prompt never gets to start during this test
  on('prompt.submit', () => new Promise(() => {}) as any)
  let polls = 0
  on('http.fetch', async () => {
    polls += 1
    const messages = polls === 1 ? [{ id: 2, from: 'alice', to: 'alice', kind: 'request', text: 'do the thing', at: 0 }] : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, leader: 'alice', messages, cursor: 2 }) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any) // delivers the request, which queues a prompt
  await settle()
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any) // must still check in, not hang
  expect(polls).toBeGreaterThanOrEqual(2)
})

test('when the download fails, Install update falls back to an npm-installed claude (claude.cmd), and shows failures', { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  LATEST = '9.9.9'
  mock.env(on, { TEMP: 'C:\\Temp' })
  const ran: string[][] = []
  let failSecond = false
  on('process.run', async (_$: unknown, e: any) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'curl.exe') return { value: { exitCode: 6, stdout: '', stderr: 'Could not resolve host' } }
    if (e.argv[0] === 'where') return { value: { exitCode: 0, stdout: 'C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n', stderr: '' } }
    if (failSecond && e.argv.includes('crew@claude-crew'))
      return { value: { exitCode: 1, stdout: '', stderr: 'Plugin "crew" not found in marketplace' } }
    return { value: { exitCode: 0, stdout: 'ok', stderr: '' } }
  })
  on('ui.toast', async () => ({ value: undefined }))
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'check-update' })
  await settle(100)
  await ui.press({ key: 'install' })
  await settle(100)
  const lines = ran.map(a => a.join(' '))
  expect(lines).toContain('cmd /c C:\\npm\\claude.cmd plugin marketplace update claude-crew')
  expect(lines).toContain('cmd /c C:\\npm\\claude.cmd plugin update crew@claude-crew')
  expect(await ui.find({ text: /Restart Claude/ } as any)).toBeDefined()

  failSecond = true
  await ui.press({ key: 'install' })
  await settle(100)
  expect(await ui.find({ text: /not found in marketplace/ } as any)).toBeDefined()
  // ...and the direct download's own reason isn't lost behind the CLI's
  expect(await ui.find({ text: /Direct download: download failed \(Could not resolve host\)/ } as any)).toBeDefined()
  await ui.unmount()
  LATEST = '0.3.0'
})

test('a request already answered with crew_send does not run a second time', { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const submitted: string[] = []
  on('prompt.submit', async (_$: unknown, e: any) => {
    submitted.push(e.text)
    return e
  })
  let polls = 0
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.init?.method === 'POST') return { value: { status: 200, ok: true, headers: {}, text: '{"id": 70, "to": "bob"}' } }
    polls += 1
    const messages = polls === 1 ? [{ id: 64, from: 'bob', to: 'alice', kind: 'request', text: 'run crew_status', at: 0 }] : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, leader: 'bob', messages, cursor: 64 }) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any) // the request arrives while we're idle: a prompt gets queued
  await settle()
  await $.tool.call({ tool: 'mcp__crew__crew_send', text: 'done!', to: 'bob' } as any) // Claude answers it meanwhile
  const later: any = await $.prompt.submit({ text: 'Crew request #64 from bob (crew leader):\n\nrun crew_status' } as any)
  expect(later.drop).toContain('already answered')
})

test("people's /crew chat stays out of Claude's context; a Claude's message and Ask a Claude reach it", { options: OPTIONS }, async ($, on) => {
  // alice leads (POLL), with Auto-run on "only from the leader"
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  const session = mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const submitted: string[] = []
  on('prompt.submit', async (_$: unknown, e: any) => {
    submitted.push(e.text)
    return e
  })
  let polls = 0
  on('http.fetch', async () => {
    polls += 1
    const messages =
      polls === 1
        ? [
            { id: 80, from: 'bob', to: 'all', kind: 'chat', text: 'brb pizza', at: 0, human: true },
            { id: 81, from: 'bob', to: 'all', kind: 'chat', text: 'auth tests pass', at: 0 },
            { id: 82, from: 'bob', to: 'alice', kind: 'request', text: 'what is left on the board?', at: 0, human: true },
          ]
        : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, messages, cursor: 82 }) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  const rows = session.appended().map(r => JSON.stringify(r.message.content))
  expect(rows.some(r => r.includes('brb pizza'))).toBe(false)
  expect(rows.some(r => r.includes('auth tests pass'))).toBe(true)
  expect(rows.some(r => r.includes('what is left') && r.includes('human=\\"yes\\"'))).toBe(true)
  // bob isn't the leader, but a person asking the leader's Claude starts work straight away
  expect(submitted.some(t => t.includes('Crew request #82 from bob, typed by them in /crew'))).toBe(true)
})

test('a follower runs the acting leader\'s requests, and the acting leader briefs the leader when they\'re back', { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  const session = mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const submitted: string[] = []
  on('prompt.submit', async (_$: unknown, e: any) => {
    submitted.push(e.text)
    return e
  })
  on('turn.complete', async () => ({ text: '' }) as any)
  let polls = 0
  on('http.fetch', async () => {
    polls += 1
    const messages =
      polls === 1
        ? [
            // ids no other test uses: "already answered" memory is module-wide in the test run
            { id: 9020, from: 'carol', to: 'alice', kind: 'request', text: 'fix the jump', at: 0 },
            { id: 9021, from: 'alice', to: 'all', kind: 'update', text: 'hands leadership back to bob', at: 0, handover: 'bob' },
          ]
        : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, leader: 'bob', acting: 'carol', messages, cursor: 9021 }) } }
  })
  // an earlier test's queued prompt can leave the plugin thinking Claude is mid-turn: finish that turn first
  await $.turn.complete({ reason: 'answer', text: 'done' } as any)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  expect(session.appended().length).toBeGreaterThan(0)
  const all = submitted.join(' || ')
  expect(all).toContain('Crew request #9020 from carol (acting leader while bob is away)')
  expect(all).toContain('bob is back, so you')
})

test("the chat's To: picker asks a teammate's Claude, flagged as typed by a person", { options: { ...OPTIONS, name: 'carol' } }, async ($, on) => {
  const seen = fakeRelay(on)
  on('ui.toast', async () => ({ value: undefined }))
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ key: 'ask' })).toBeUndefined() // To: starts on the people
  await ui.select({ key: 'ask-to', value: 'alice' })
  expect(await ui.find({ key: 'say' })).toBeUndefined()
  await ui.input({ key: 'ask', text: 'plan the next sprint' })
  await settle()
  await ui.unmount()
  const send = seen.find(s => s.url.endsWith('/send'))
  expect(JSON.parse(send?.init.body)).toEqual({ text: 'plan the next sprint', to: 'alice', kind: 'request', human: true })
})

test('the task manager in /crew finishes, removes, adds and clears tasks', { options: OPTIONS }, async ($, on) => {
  const posted: any[] = []
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const tasks = [
    { id: 3, title: 'Write login tests', note: '', status: 'open', owner: null, assignee: 'bob', by: 'alice', at: 0 },
    { id: 4, title: 'Old Roblox thing', note: '', status: 'open', owner: null, assignee: null, by: 'alice', at: 0 },
  ]
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.init?.method === 'POST') {
      posted.push(JSON.parse(e.init.body))
      return { value: { status: 200, ok: true, headers: {}, text: '{"id": 9}' } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, tasks }) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-tasks' })
  await ui.press({ key: 'task-done-3' })
  await ui.press({ key: 'task-rm-4' })
  await ui.input({ key: 'add-task', text: 'Fix the jump @bob', kind: 'change' } as any)
  await ui.input({ key: 'add-task', text: 'Fix the jump @bob' })
  await settle()
  expect(posted).toContainEqual({ action: 'done', id: 3 })
  expect(posted).toContainEqual({ action: 'remove', id: 4 })
  expect(posted).toContainEqual({ action: 'add', title: 'Fix the jump', assignee: 'bob' })
  await new Promise(r => setTimeout(r, 100))
  expect((await ui.find({ key: 'add-task' }) as any).props.value).toBe('') // the field empties after Enter
  await ui.press({ key: 'tab-chat' })
  await ui.input({ key: 'say', text: 'hi', kind: 'change' } as any)
  await ui.input({ key: 'say', text: 'hi' })
  await new Promise(r => setTimeout(r, 100))
  expect((await ui.find({ key: 'say' }) as any).props.value).toBe('')
  await ui.press({ key: 'tab-tasks' })

  posted.length = 0
  await ui.press({ key: 'clear-tasks' })
  expect(await ui.find({ text: /Remove all 2 open tasks/ } as any)).toBeDefined()
  await ui.press({ key: 'clear-no' })
  expect(posted.length).toBe(0)
  await ui.press({ key: 'clear-tasks' })
  await ui.press({ key: 'clear-yes' })
  await settle()
  expect(posted.filter(p => p.action === 'remove').map(p => p.id).sort()).toEqual([3, 4])
  await ui.unmount()
})

test('joining twice with nothing new briefs Claude only once', { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'cursor:http://relay.test:7777': 7 })
  const session = mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, messages: [{ id: 7, from: 'bob', to: 'all', kind: 'update', text: 'added task #3', at: 0 }] }) } }))
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'leave' })
  await ui.press({ key: 'leave-yes' })
  await settle()
  await ui.press({ key: 'join' })
  await settle()
  await ui.press({ key: 'leave' })
  await ui.press({ key: 'leave-yes' })
  await settle()
  await ui.press({ key: 'join' })
  await settle()
  await ui.unmount()
  const briefs = session.appended().filter(r => JSON.stringify(r.message.content).includes('crew-catchup'))
  expect(briefs.length).toBe(1)
})

test('with the leader offline, followers keep working instead of stalling', { options: OPTIONS }, async ($, on) => {
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  const peers = [
    { name: 'alice', online: true, lastSeen: 0, activity: 'idle', leader: false },
    { name: 'bob', online: false, lastSeen: 0, activity: 'idle', leader: true },
  ]
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, peers, leader: 'bob' }) } }))
  on('prompt.compose', async () => ({ sections: [] }) as any)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const composed: any = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
  const role = composed.sections.find((s: any) => s.id === 'crew:role')
  expect(role.text).toContain('bob leads the crew but is offline right now')
  expect(role.text).toContain("Don't stall")
})

test('while the leader is away, the acting leader is briefed as such and their requests run like the leader\'s', { options: OPTIONS }, async ($, on) => {
  // bob leads but is offline; alice (us) is acting leader; carol's requests aren't trusted, alice's role says acting
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const peers = [
    { name: 'alice', online: true, lastSeen: 0, activity: 'idle', leader: false, acting: true },
    { name: 'bob', online: false, lastSeen: 0, activity: 'idle', leader: true },
  ]
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, peers, leader: 'bob', acting: 'alice' }) } }))
  on('prompt.compose', async () => ({ sections: [] }) as any)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const composed: any = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
  expect(composed.sections.find((s: any) => s.id === 'crew:role').text).toContain('You are the ACTING crew leader')
  const r: any = await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  expect(String(r.result)).toContain('alice (acting leader)')
})

test('projects: switching moves this session, every request says which project, and crew_project lists them', { options: OPTIONS }, async ($, on) => {
  const seen: { url: string; init: any }[] = []
  mock.store(on)
  mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('http.fetch', async (_$: unknown, e: any) => {
    seen.push({ url: e.url, init: e.init })
    const body = e.url.endsWith('/projects')
      ? { projects: [{ name: 'main', leader: 'alice', openTasks: 1, docs: 0, here: ['alice'] }, { name: 'lava', leader: null, openTasks: 0, docs: 0, here: [] }] }
      : { ...POLL, project: 'x' }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  expect(seen[seen.length - 1].init.headers['X-Crew-Project']).toBe('main')
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-docs' }) // the Project tab
  expect(await ui.find({ key: 'new-project' })).toBeUndefined() // no fields until you ask
  await ui.press({ key: 'new-project-open' })
  await ui.input({ key: 'new-project', text: 'floor is lava!' })
  await settle()
  expect(seen[seen.length - 1].init.headers['X-Crew-Project']).toBe('floor is lava') // cleaned up
  expect(await ui.find({ text: /📂 floor is lava/ } as any)).toBeDefined()
  expect(await ui.find({ text: /Switching is just for you/ } as any)).toBeDefined()
  await ui.unmount()
  const listed: any = await $.tool.call({ tool: 'mcp__crew__crew_project' } as any)
  expect(String(listed.result)).toContain('lava: leader none, 0 open tasks')
  const back: any = await $.tool.call({ tool: 'mcp__crew__crew_project', name: 'main' } as any)
  expect(String(back.result)).toContain('now in crew project "main"')
})

test("the Project tab shows the project's folder, opens it, lists and makes subfolders", { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  on('ui.toast', async () => ({ value: undefined }))
  const ran: string[][] = []
  const opened: string[] = []
  on('process.run', async (_$: unknown, e: any) => {
    ran.push([...e.argv])
    if (e.argv.includes('-EncodedCommand')) opened.push(String(e.init?.env?.CREW_DIR ?? ''))
    const listing = e.argv[0] === 'powershell' && e.argv.join(' ').includes('Get-ChildItem')
    return { value: { exitCode: 0, stdout: listing ? 'art\r\nscripts\r\n' : '', stderr: '' } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-docs' })
  await ui.press({ key: 'folder-change-open' })
  await ui.input({ key: 'folder-set', text: '"C:\\Games\\Lava\\"' })
  await settle()
  expect(await ui.find({ text: /C:\\Games\\Lava/ } as any)).toBeDefined()
  expect(await ui.find({ key: 'dir-scripts' })).toBeDefined()
  await ui.press({ key: 'folder-open' })
  await ui.press({ key: 'folder-sub-open' })
  await ui.input({ key: 'folder-new', text: 'levels' })
  await settle()
  await ui.unmount()
  const lines = ran.map(a => a.join(' '))
  expect(opened).toContain('C:\\Games\\Lava') // brought to the front, or opened if it isn't yet
  expect(lines.some(l => l.includes("New-Item -ItemType Directory -Force -Path 'C:\\Games\\Lava\\levels'"))).toBe(true)
})

test('with a projects home set, a new project gets its own folder there', { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  mock.session(on)
  on('ui.toast', async () => ({ value: undefined }))
  const ran: string[] = []
  on('process.run', async (_$: unknown, e: any) => {
    ran.push(e.argv.join(' '))
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-docs' })
  await ui.press({ key: 'new-project-open' })
  // no projects home yet: it's offered right there, with "Choose…" for your own
  expect(await ui.find({ key: 'home-default' })).toBeDefined()
  await ui.press({ key: 'home-paste' }) // "Choose…" opens Windows' folder picker instead
  await ui.input({ key: 'projects-home', text: 'C:\\Crew' })
  await settle()
  await ui.input({ key: 'new-project', text: 'lava' })
  await settle()
  expect(ran.some(l => l.includes("-Path 'C:\\Crew\\lava'"))).toBe(true)
  expect(await ui.find({ text: /C:\\Crew\\lava/ } as any)).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'mcp__crew__crew_project', name: 'main' } as any) // leave the shared module state on main
})

test('the leader can remove someone after a confirm', { options: OPTIONS }, async ($, on) => {
  const seen = fakeRelay(on) // alice leads in POLL
  on('ui.toast', async () => ({ value: undefined }))
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-crew' })
  expect(await ui.find({ key: 'kick-alice' })).toBeUndefined() // not yourself
  await ui.press({ key: 'kick-bob' })
  expect(await ui.find({ text: /Remove bob from the crew session\?/ } as any)).toBeDefined()
  await ui.press({ key: 'kick-no' })
  expect(seen.some(s => s.url.endsWith('/kick'))).toBe(false)
  await ui.press({ key: 'kick-bob' })
  await ui.press({ key: 'kick-yes' })
  await settle()
  await ui.unmount()
  expect(JSON.parse(seen.find(s => s.url.endsWith('/kick'))?.init.body)).toEqual({ name: 'bob' })
})

test('a removed member drops out of the session and is told who removed them', { options: OPTIONS }, async ($, on) => {
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', async (_$: unknown, e: any) => {
    toasts.push(e.text ?? e.message ?? JSON.stringify(e))
    return { value: undefined }
  })
  on('http.fetch', async () => ({ value: { status: 403, ok: false, headers: {}, text: '{"error": "you were removed from the crew session by bob", "kicked": true}' } }))
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  expect(toasts.join(' ')).toContain('removed from the crew session by bob')
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ key: 'join' })).toBeDefined()
  await ui.unmount()
})

test("the leader's idle Claude is woken by a teammate's Claude's request", { options: OPTIONS }, async ($, on) => {
  // alice (us) leads in POLL; bob's Claude (not typed by a person) asks for the next task
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const submitted: string[] = []
  on('prompt.submit', async (_$: unknown, e: any) => {
    submitted.push(e.text)
    return e
  })
  on('turn.complete', async () => ({ text: '' }) as any)
  let polls = 0
  on('http.fetch', async () => {
    polls += 1
    const messages = polls === 1 ? [{ id: 9101, from: 'bob', to: 'alice', kind: 'request', text: 'T4 done. What next?', at: 0 }] : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, messages, cursor: 9101 }) } }
  })
  await $.turn.complete({ reason: 'answer', text: 'done' } as any) // idle
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  expect(submitted.join(' || ')).toContain('Crew request #9101 from bob:\n\nT4 done. What next?')
})

test('the Crew tab shows who is on which version, and nudges whoever is behind', { options: OPTIONS }, async ($, on) => {
  const seen: { url: string; init: any }[] = []
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const peers = [
    { name: 'alice', online: true, lastSeen: 0, activity: 'idle', leader: true, version: '9.9.9' },
    { name: 'bob', online: true, lastSeen: 0, activity: 'idle', leader: false, version: '0.1.0' },
  ]
  on('http.fetch', async (_$: unknown, e: any) => {
    seen.push({ url: e.url, init: e.init })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, peers }) } }
  })
  const r: any = await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  expect(String(r.result)).toContain('bob: idle · crew 0.1.0 ⬆ update')
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-crew' })
  expect(await ui.find({ text: /v0\.1\.0 ⬆ update/ } as any)).toBeDefined()
  expect(await ui.find({ text: /bob \(0\.1\.0\) is behind/ } as any)).toBeDefined()
  await ui.press({ key: 'nudge-bob' })
  await settle()
  await ui.unmount()
  const body = JSON.parse(seen.find(s => s.url.endsWith('/send'))?.init.body)
  expect(body).toMatchObject({ to: 'bob', kind: 'chat', human: true, notify: true })
})

test('an invite to another project shows a notice; Switch moves you there', { options: OPTIONS }, async ($, on) => {
  const seen: { url: string; init: any }[] = []
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  const session = mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  let polls = 0
  on('http.fetch', async (_$: unknown, e: any) => {
    seen.push({ url: e.url, init: e.init })
    polls += 1
    const messages = polls === 1 ? [{ id: 9201, from: 'bob', to: 'all', kind: 'invite', invite: 'lava', text: 'invites everyone to the project "lava"', at: 0 }] : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, messages, cursor: 9201 }) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  expect(session.appended().some(r => JSON.stringify(r.message.content).includes('invites everyone'))).toBe(false) // no tokens
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ text: /bob invites you to the project "lava"/ } as any)).toBeDefined()
  await ui.press({ key: 'invite-accept' })
  await settle()
  expect(seen[seen.length - 1].init.headers['X-Crew-Project']).toBe('lava')
  await ui.unmount()
  await $.tool.call({ tool: 'mcp__crew__crew_project', name: 'main' } as any) // leave the shared module state on main
})

test('Use a different folder… opens the Windows folder picker and uses what you choose', { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  on('ui.toast', async () => ({ value: undefined }))
  const ran: string[] = []
  on('process.run', async (_$: unknown, e: any) => {
    const line = e.argv.join(' ')
    ran.push(line)
    const picker = line.includes('FolderBrowserDialog')
    return { value: { exitCode: 0, stdout: picker ? 'D:\\Games\\Lava\r\n' : '', stderr: '' } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-docs' })
  await ui.press({ key: 'folder-browse' })
  await settle(200)
  expect(ran.some(l => l.includes('-STA') && l.includes('FolderBrowserDialog'))).toBe(true)
  expect(await ui.find({ text: /D:\\Games\\Lava/ } as any)).toBeDefined()
  await ui.unmount()
})

test('Delete project asks twice, then wipes it on the relay and bins only its own folder', { options: { ...OPTIONS, name: 'alice' } }, async ($, on) => {
  const seen: { url: string; init: any }[] = []
  mock.store(on)
  mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const ran: string[] = []
  on('process.run', async (_$: unknown, e: any) => {
    ran.push(e.argv.join(' '))
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('http.fetch', async (_$: unknown, e: any) => {
    seen.push({ url: e.url, init: e.init })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, leader: 'alice' }) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-docs' })
  expect(await ui.find({ key: 'proj-more-main' })).toBeUndefined() // never main
  await ui.press({ key: 'new-project-open' })
  await ui.press({ key: 'home-paste' })
  await ui.input({ key: 'projects-home', text: 'C:\\Crew' })
  await settle()
  await ui.input({ key: 'new-project', text: 'doomed' })
  await settle()
  expect(await ui.find({ text: /▸ doomed \(you\)/ } as any)).toBeDefined() // listed in Projects
  await ui.press({ key: 'proj-more-doomed' })
  await ui.press({ key: 'proj-delete-doomed' })
  expect(await ui.find({ text: /You sure\?/ } as any)).toBeDefined()
  await ui.press({ key: 'delete-sure' })
  expect(await ui.find({ text: /VERY sure\?\?/ } as any)).toBeDefined()
  expect(await ui.find({ text: /Crew\\doomed, with everything in it, goes to your Recycle Bin/ } as any)).toBeDefined()
  expect(seen.some(s => s.url.endsWith('/project/delete'))).toBe(false) // nothing happens before the second yes
  await ui.press({ key: 'delete-very-sure' })
  await settle(200)
  await ui.unmount()
  expect(JSON.parse(seen.find(s => s.url.endsWith('/project/delete'))?.init.body)).toEqual({ name: 'doomed' })
  expect(ran.some(l => l.includes("SendToRecycleBin") && l.includes("'C:\\Crew\\doomed'"))).toBe(true)
  expect(seen[seen.length - 1].init.headers['X-Crew-Project']).toBe('main') // and we're back in main
})

test('a shared doc can be deleted after a confirm, and the double-click tip goes away with Got it', { options: OPTIONS }, async ($, on) => {
  const seen: { url: string; init: any }[] = []
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('http.fetch', async (_$: unknown, e: any) => {
    seen.push({ url: e.url, init: e.init })
    const body = e.url.includes('/shared?name=')
      ? { name: 'old-plan', by: 'bob', at: 1000, content: 'stale' }
      : e.url.endsWith('/shared')
        ? { docs: [{ name: 'old-plan', by: 'bob', at: 1000, size: 5 }] }
        : e.init?.method === 'POST'
          ? { ok: true }
          : { ...POLL, shared: ['old-plan'] } // alice (us) leads
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ text: /needs a second click/ } as any)).toBeDefined()
  await ui.press({ key: 'tip-ok' })
  expect(await ui.find({ text: /needs a second click/ } as any)).toBeUndefined()
  await ui.press({ key: 'tab-docs' })
  await ui.press({ key: 'doc-old-plan' })
  await settle()
  await ui.press({ key: 'doc-delete' })
  expect(await ui.find({ text: /Delete "old-plan" for the whole project\?/ } as any)).toBeDefined()
  await ui.press({ key: 'doc-delete-yes' })
  await settle()
  await ui.unmount()
  expect(JSON.parse(seen.find(s => s.url.endsWith('/shared/delete'))?.init.body)).toEqual({ name: 'old-plan' })
})

test('tasks read as T-numbers, and a stale claim says anyone can take it', { options: OPTIONS }, async ($, on) => {
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  const tasks = [{ id: 2, title: 'Fix sprint', note: '', status: 'claimed', owner: 'bob', assignee: null, by: 'alice', at: 0, ownerAway: 14 }]
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, tasks }) } }))
  const r: any = await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  expect(String(r.result)).toContain('T2 [claimed · bob (offline 14 min: anyone can claim it)] Fix sprint')
})

test('/crewlog opens the crew log window', { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  const ran: string[][] = []
  on('process.run', async (_$: unknown, e: any) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  const r: any = await $.command.run({ command: 'crewlog', args: '' } as any)
  expect(ran.some(a => a.join(' ').endsWith('crew_log.py'))).toBe(true)
  expect(String(r.text)).toContain('crew log is open')
})

test('crew_wait waits on the relay and returns the reply', { options: OPTIONS }, async ($, on) => {
  const seen: { url: string; init: any }[] = []
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  on('http.fetch', async (_$: unknown, e: any) => {
    seen.push({ url: e.url, init: e.init })
    if (e.url.includes('/wait'))
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ messages: [{ id: 9, from: 'bob', to: 'alice', kind: 'chat', text: 'pong', at: 1791700000.25 }] }) } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(POLL) } }
  })
  const r: any = await $.tool.call({ tool: 'mcp__crew__crew_wait', from: 'bob', timeout_s: 30 } as any)
  // waits in rounds of at most 25s: a plugin's web request gives up at 30s
  expect(seen.some(s => s.url.includes('/wait?') && s.url.includes('from=bob') && s.url.includes('timeout=25'))).toBe(true)
  expect(String(r.result)).toContain('pong')
  expect(String(r.result)).toContain('UTC')
})

test('a message flagged for your human is pinned in /crew until dismissed', { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  let polls = 0
  on('http.fetch', async () => {
    polls += 1
    const messages = polls === 1 ? [{ id: 69, from: 'bob', to: 'alice', kind: 'chat', text: 'we have to finish Pumpkin Panic', at: 0, notify: true }] : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, messages, cursor: 69 }) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ text: /Pumpkin Panic/ } as any)).toBeDefined()
  await ui.press({ key: 'pin-69' })
  expect(await ui.find({ key: 'pin-69' })).toBeUndefined()
  await ui.unmount()
})

test('Leave… asks first, and only Yes leaves the crew session', { options: OPTIONS }, async ($, on) => {
  const seen = fakeRelay(on)
  on('ui.toast', async () => ({ value: undefined }))
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'leave' })
  expect(await ui.find({ key: 'leave-yes' })).toBeDefined()
  await ui.press({ key: 'leave-no' })
  await settle()
  expect(await ui.find({ key: 'leave-yes' })).toBeUndefined()
  expect(seen.some(s => s.url.endsWith('/leave'))).toBe(false)
  await ui.press({ key: 'leave' })
  await ui.press({ key: 'leave-yes' })
  await settle()
  expect(seen.some(s => s.url.endsWith('/leave'))).toBe(true)
  expect(await ui.find({ key: 'join' })).toBeDefined()
  await ui.unmount()
})

test('the chat groups messages into bubbles and folds runs of crew events', { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const messages = [
    { id: 2, from: 'bob', to: 'all', kind: 'chat', text: 'hello there', at: 1000, human: true },
    { id: 3, from: 'bob', to: 'all', kind: 'chat', text: 'second line', at: 1010, human: true },
    { id: 4, from: 'alice', to: 'all', kind: 'chat', text: 'hi bob', at: 1020, human: true },
    { id: 5, from: 'bob', to: 'alice', kind: 'request', text: 'review auth', at: 1030 },
    ...[6, 7, 8, 9, 10].map(id => ({ id, from: 'bob', to: 'all', kind: 'update', text: `added task #${id}`, at: 1040 })),
  ]
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, messages, cursor: 10 }) } }))
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'crew', surface, ...PANE })
    expect(await ui.find({ text: /hello there/ } as any)).toBeDefined()
    expect(await ui.find({ text: /second line/ } as any)).toBeDefined()
    expect(await ui.find({ text: /bob · \d\d:\d\d/ } as any)).toBeDefined() // one header for bob's two lines
    expect(await ui.find({ text: /bob's Claude · → you · request/ } as any)).toBeDefined()
    expect(await ui.find({ text: /3 more updates/ } as any)).toBeDefined()
    expect(await ui.find({ text: /bob added task #10/ } as any)).toBeDefined()
    expect(await ui.find({ text: /bob added task #6/ } as any)).toBeUndefined()
    await ui.unmount()
  }
})

test('shared docs show who shared them, and open a peek', { options: OPTIONS }, async ($, on) => {
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('http.fetch', async (_$: unknown, e: any) => {
    const body = e.url.includes('/shared?name=')
      ? { name: 'plan', by: 'bob', at: 1000, content: 'line one\nline two' }
      : e.url.endsWith('/shared')
        ? { docs: [{ name: 'plan', by: 'bob', at: 1000, size: 17 }] }
        : { ...POLL, shared: ['plan'] }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-docs' })
  expect(await ui.find({ key: 'doc-plan' })).toBeDefined()
  expect(await ui.find({ text: /bob · \d\d:\d\d · 17 chars/ } as any)).toBeDefined()
  await ui.press({ key: 'doc-plan' })
  await settle()
  expect(await ui.find({ text: /line two/ } as any)).toBeDefined()
  expect(await ui.find({ key: 'doc-copy' })).toBeDefined()
  await ui.press({ key: 'doc-close' })
  await settle()
  expect(await ui.find({ text: /line two/ } as any)).toBeUndefined()
  await ui.unmount()
})

// -- read receipts and crew_ping

function receiptRelay(on: any, reads: Record<string, number>) {
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const messages = [
    { id: 11, from: 'bob', to: 'all', kind: 'chat', text: 'morning', at: 1000, human: true },
    { id: 12, from: 'alice', to: 'all', kind: 'chat', text: 'walk script is in', at: 1010 },
  ]
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, messages, cursor: 12, reads }) } }))
}

test('your newest bubble and crew_status say who has read it', { options: OPTIONS }, async ($, on) => {
  receiptRelay(on, { alice: 12, bob: 12 })
  const r: any = await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  expect(String(r.result)).toContain('#12 alice: walk script is in  [read by bob]')
  expect(String(r.result)).not.toContain('morning  [') // only your own messages get receipts
  await settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'crew', surface, ...PANE })
    expect(await ui.find({ text: /✓ read by bob/ } as any)).toBeDefined()
    await ui.unmount()
  }
})

test('a message nobody has picked up yet says "not read yet"', { options: OPTIONS }, async ($, on) => {
  receiptRelay(on, { alice: 12, bob: 11 })
  const r: any = await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  expect(String(r.result)).toContain('walk script is in  [not read yet]')
  await settle()
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ text: /not read yet/ } as any)).toBeDefined()
  await ui.unmount()
})

test('a teammate\'s ping is echoed by the plugin, without reaching Claude', { options: OPTIONS }, async ($, on) => {
  const posted: { url: string; body: any }[] = []
  mock.store(on)
  const session = mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.init?.method === 'POST') posted.push({ url: e.url, body: JSON.parse(e.init.body ?? '{}') })
    const body = e.url.includes('/poll') ? { ...POLL, pings: ['p1'] } : { ok: true }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  expect(posted.some(p => p.url.endsWith('/pong') && p.body.id === 'p1')).toBe(true)
  expect(session.appended().some(r => JSON.stringify(r.message.content).includes('p1'))).toBe(false)
})

test('crew_ping times relay round trips and a teammate\'s echo', { options: OPTIONS }, async ($, on) => {
  const seen: string[] = []
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  on('http.fetch', async (_$: unknown, e: any) => {
    seen.push(`${e.init?.method ?? 'GET'} ${e.url}`)
    const body = e.url.endsWith('/health')
      ? { ok: true }
      : e.url.endsWith('/ping')
        ? { id: 'p9', at: 1000 }
        : e.url.includes('/pong?id=p9')
          ? { answered: true, sentAt: 1000, answeredAt: 1001.2, now: 1001.2 }
          : POLL
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  const r: any = await $.tool.call({ tool: 'mcp__crew__crew_ping', to: 'bob', count: 2 } as any)
  expect(seen.filter(s => s.endsWith('/health')).length).toBe(2)
  expect(seen.some(s => s.startsWith('POST') && s.endsWith('/ping'))).toBe(true)
  expect(String(r.result)).toContain('Relay round trip (2×)')
  expect(String(r.result)).toContain("bob's crew plugin echoed in")
})

// -- /crew's tabs

test('/crew shows one tab at a time; ⚙ Settings is a tab too, and picking another tab leaves it', { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  on('ui.toast', async () => ({ value: undefined }))
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'crew', surface, ...PANE })
    for (const k of ['tab-chat', 'tab-tasks', 'tab-docs', 'tab-crew', 'settings', 'leave', 'clawds', 'crew-log']) expect(await ui.find({ key: k })).toBeDefined()
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'opt-relayUrl' })).toBeDefined()
    expect(await ui.find({ key: 'check-update' })).toBeDefined()
    expect(await ui.find({ key: 'say' })).toBeUndefined()
    await ui.press({ key: 'tab-docs' })
    expect(await ui.find({ key: 'opt-relayUrl' })).toBeUndefined()
    expect(await ui.find({ text: /None yet/ } as any)).toBeDefined()
    await ui.press({ key: 'tab-chat' })
    expect(await ui.find({ key: 'say' })).toBeDefined()
    await ui.unmount()
  }
})

test("the chat's People view shows only what people typed; Everything shows the Claudes too", { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const messages = [
    { id: 2, from: 'bob', to: 'all', kind: 'chat', text: 'lunch at 1?', at: 1000, human: true },
    { id: 3, from: 'bob', to: 'alice', kind: 'request', text: 'review the relay patch', at: 1010 },
    { id: 4, from: 'bob', to: 'all', kind: 'update', text: 'added task T5: docs', at: 1020 },
  ]
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, messages, cursor: 4 }) } }))
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ text: /review the relay patch/ } as any)).toBeDefined() // Everything is the default
  await ui.press({ key: 'view-people' })
  expect(await ui.find({ text: /lunch at 1\?/ } as any)).toBeDefined()
  expect(await ui.find({ text: /review the relay patch/ } as any)).toBeUndefined()
  expect(await ui.find({ text: /added task T5/ } as any)).toBeUndefined()
  await ui.press({ key: 'view-all' })
  expect(await ui.find({ text: /added task T5/ } as any)).toBeDefined()
  await ui.unmount()
})

test("the leader plans around the crew's models, and every Claude gets the project's house rules", { options: OPTIONS }, async ($, on) => {
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  const peers = [
    { name: 'alice', online: true, lastSeen: 0, activity: 'idle', leader: true, model: 'claude-opus-5-5' },
    { name: 'bob', online: true, lastSeen: 0, activity: 'idle', leader: false, model: 'claude-sonnet-5-5' },
  ]
  const posts: any[] = []
  on('ui.toast', async () => ({ value: undefined }))
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.init?.method === 'POST') {
      posts.push(JSON.parse(e.init.body))
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok": true}' } }
    }
    const body = e.url.includes('/shared?name=crew-rules')
      ? { name: 'crew-rules', by: 'bob', at: 1, content: '- bob does the art' }
      : e.url.endsWith('/shared')
        ? { docs: [] }
        : { ...POLL, peers, shared: ['crew-rules'] } // alice (us) leads
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('prompt.compose', async () => ({ sections: [] }) as any)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  const composed: any = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
  const role = composed.sections.find((s: any) => s.id === 'crew:role').text
  expect(role).toContain("The crew's models right now: you (Opus 5.5), bob (Sonnet 5.5)")
  expect(role).toContain('Play to strengths')
  expect(role).toContain('House rules for this crew project')
  expect(role).toContain('- bob does the art')

  // anyone adds a rule from the Project tab: it's appended to the doc
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-docs' })
  expect(await ui.find({ text: /- bob does the art/ } as any)).toBeDefined()
  await ui.input({ key: 'add-rule', text: 'ask before touching main' })
  await settle()
  await ui.unmount()
  expect(posts).toContainEqual({ name: 'crew-rules', content: '- bob does the art\n- ask before touching main' })

  // and ✕ removes one again
  const ui2 = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui2.press({ key: 'tab-docs' })
  await ui2.press({ key: 'rule-rm-0' })
  await settle()
  await ui2.unmount()
  expect(posts.some(p => p.name === 'crew-rules' && !String(p.content ?? '').includes('bob does the art'))).toBe(true)
})

test('the loop brake stops Claudes waking each other forever, and the person typing resets it', { options: OPTIONS }, async ($, on) => {
  // alice (us) leads, so every teammate request would start a turn
  mock.store(on, { 'cursor:http://relay.test:7777': 1 })
  on('turn.complete', async () => ({ text: '' }) as any)
  const session = mock.session(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const submitted: string[] = []
  on('prompt.submit', async (_$: unknown, e: any) => {
    submitted.push(e.text)
    return e
  })
  const sent: any[] = []
  let polls = 0
  let resumed = false
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.init?.method === 'POST') {
      sent.push(JSON.parse(e.init.body))
      return { value: { status: 200, ok: true, headers: {}, text: '{"id": 999, "to": "bob"}' } }
    }
    if (e.url.includes('/poll')) polls += 1
    const messages = !e.url.includes('/poll')
      ? []
      : polls === 1
        ? Array.from({ length: 10 }, (_, i) => ({ id: 9500 + i, from: 'bob', to: 'alice', kind: 'request', text: `ping ${i}`, at: 0 }))
        : resumed
          ? [{ id: 9600, from: 'bob', to: 'alice', kind: 'request', text: 'ping again', at: 0 }]
          : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, messages, cursor: 9600 }) } }
  })
  await $.prompt.submit({ text: 'hi crew' } as any) // the person typed: a fresh start
  await $.turn.complete({ reason: 'answer', text: 'done' } as any)
  submitted.length = 0
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  expect(submitted.filter(t => t.startsWith('Crew request #')).length).toBe(8)
  expect(sent.some(b => b.to === 'bob' && b.kind === 'update' && b.text.includes('loop brake'))).toBe(true)
  await $.prompt.submit({ text: 'ok, carry on' } as any) // the person is back
  await settle()
  await $.turn.complete({ reason: 'answer', text: 'done' } as any)
  resumed = true
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  expect(submitted.some(t => t.startsWith('Crew request #9600'))).toBe(true)
  await $.prompt.submit({ text: 'reset for the next test' } as any)
})

test("a file a teammate's Claude just edited is locked once: the edit is stopped with who, and the second try goes through", { options: OPTIONS }, async ($, on) => {
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('tool.register', async () => ({ value: undefined }) as any)
  on('command.register', async () => ({ value: undefined }) as any)
  on('ui.invalidate', async () => ({ value: undefined }) as any)
  on('session.start', async (_$: unknown, e: any) => e)
  const touched: string[] = []
  const now = Date.now() / 1000
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.url.endsWith('/touch')) {
      touched.push(JSON.parse(e.init.body).path)
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok": true}' } }
    }
    const editing = [{ path: 'src/Player.lua', name: 'bob', at: now - 60 }]
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, editing }) } }
  })
  on('tool.call', { tool: 'Edit' }, async () => ({ result: 'edited' }) as any)
  await $.session.start({ source: 'startup', cwd: 'C:\\Games\\Lava' } as any)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const first: any = await $.tool.call({ tool: 'Edit', file_path: 'C:\\Games\\Lava\\src\\player.lua' } as any)
  expect(first.deny).toContain("bob's Claude edited src/player.lua")
  const second: any = await $.tool.call({ tool: 'Edit', file_path: 'C:\\Games\\Lava\\src\\player.lua' } as any)
  expect(second.deny).toBeUndefined()
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\Games\\Lava\\src\\other.lua' } as any)
  await $.tool.call({ tool: 'Edit', file_path: 'D:\\elsewhere\\notes.txt' } as any) // outside the project: not reported
  await settle()
  expect(touched).toEqual(['src/player.lua', 'src/other.lua'])
})

test("teammates' usage shows in the Crew tab, and the leader's Claude hands big tasks to whoever has room", { options: OPTIONS }, async ($, on) => {
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  const peers = [
    { name: 'alice', online: true, lastSeen: 0, activity: 'idle', leader: true, model: 'claude-opus-5-5', usage: 30 },
    { name: 'bob', online: true, lastSeen: 0, activity: 'idle', leader: false, model: 'claude-sonnet-5-5', usage: 91, mcp: 'Roblox Studio' },
  ]
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, peers }) } }))
  on('prompt.compose', async () => ({ sections: [] }) as any)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const composed: any = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
  const role = composed.sections.find((s: any) => s.id === 'crew:role').text
  expect(role).toContain('anyone past 80% gets only small ones')
  expect(role).toContain('bob (Sonnet 5.5, 91% of usage limit used, connected to Roblox Studio)')
  expect(role).toContain('goes to whoever has it connected')
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-crew' })
  expect(await ui.find({ text: /91% used ⚠/ } as any)).toBeDefined()
  expect(await ui.find({ text: /🔌 Roblox Studio/ } as any)).toBeDefined()
  await ui.unmount()
})

test("shared folders: a teammate's folder is mirrored by the plugin on Get it, and Claude hears where it is", { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'folder:http://relay.test:7777:main': 'C:\\Games\\Lava' })
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const runs: { argv: string[]; init: any }[] = []
  on('process.run', async (_$: unknown, e: any) => {
    runs.push({ argv: [...e.argv], init: e.init })
    const encoded = e.argv.includes('-EncodedCommand')
    return { value: { exitCode: 0, stdout: encoded ? '::done 2 0 0 0' : '', stderr: '' } }
  })
  const folders = [{ name: 'source', by: 'bob', at: 50, files: 2, bytes: 2500000, ready: true }]
  const manifest = { name: 'source', by: 'bob', at: 50, files: [
    { path: 'main.lua', size: 12, hash: 'a'.repeat(64) },
    { path: 'AI/enemy.lua', size: 9, hash: 'b'.repeat(64) },
  ] }
  on('http.fetch', async (_$: unknown, e: any) => {
    const body = e.url.includes('/folder?name=source') ? manifest : e.url.endsWith('/shared') ? { docs: [] } : { ...POLL, folders }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('prompt.compose', async () => ({ sections: [] }) as any)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-docs' })
  await settle()
  expect(await ui.find({ text: /source/ } as any)).toBeDefined()
  await ui.press({ key: 'folder-get-source' })
  await settle()
  await ui.unmount()
  const job = runs.find(r => r.argv.includes('-EncodedCommand'))
  expect(job?.init.env.CREW_DIR).toBe('C:\\Games\\Lava\\source')
  expect(job?.init.env.CREW_KEY).toBe('k') // the key travels in the environment, never on the command line
  expect(job?.argv.join(' ')).not.toContain('X-Crew-Key')
  expect(job?.init.stdin).toContain(`${'b'.repeat(64)}\t9\tAI/enemy.lua`)
  const composed: any = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
  const role = composed.sections.find((s: any) => s.id === 'crew:role').text
  expect(role).toContain('source/ from bob (2 files, 2.5 MB) at C:\\Games\\Lava\\source')
  expect(role).toContain('crew_share a map doc ("source-map")') // alice leads
})

test("Crewshared: your drop folder is sent when it changes, and teammates' arrive without Get it", { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'folder:http://relay.test:7777:main': 'C:\\Games\\Lava' })
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const jobs: { dir: string; stdin: string }[] = []
  on('process.run', async (_$: unknown, e: any) => {
    const dir = String(e.init?.env?.CREW_DIR ?? '')
    if (dir) jobs.push({ dir, stdin: String(e.init?.stdin ?? '') })
    let stdout = ''
    if (dir.endsWith('Crewshared\\alice') && !e.init.stdin) stdout = jobs.filter(j => j.dir === dir).length === 1 ? `logo.png|5|111\n` : `logo.png\t5\t${'c'.repeat(64)}\n`
    else if (dir.endsWith('Crewshared\\alice')) stdout = '::done 1'
    else if (dir) stdout = '::done 1 0 0 0'
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  const posts: { url: string; body: any }[] = []
  const folders = [{ name: 'Crewshared/bob', by: 'bob', at: 70, files: 1, bytes: 9, ready: true }]
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.init?.method === 'POST') {
      posts.push({ url: e.url, body: JSON.parse(e.init.body) })
      const missing = e.url.endsWith('/folder/manifest') && posts.filter(p => p.url.endsWith('/folder/manifest')).length === 1 ? ['c'.repeat(64)] : []
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, missing }) } }
    }
    const body = e.url.includes('/folder?name=') ? { name: 'Crewshared/bob', by: 'bob', at: 70, files: [{ path: 'map.txt', size: 9, hash: 'd'.repeat(64) }] } : e.url.endsWith('/shared') ? { docs: [] } : { ...POLL, folders }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-docs' }) // loads the project folder
  await settle()
  await ui.unmount()
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  await new Promise(r => setTimeout(r, 200))
  expect(jobs.some(j => j.dir === 'C:\\Games\\Lava\\Crewshared\\bob' && j.stdin.includes('map.txt'))).toBe(true) // no Get it needed
  expect(posts.some(p => p.url.endsWith('/folder/manifest') && p.body.name === 'Crewshared/alice')).toBe(true)
  expect(posts.some(p => p.url.endsWith('/folder/commit') && p.body.name === 'Crewshared/alice')).toBe(true)
})

test('a members-only project shows its members, and + adds a teammate (who gets an invite)', { options: OPTIONS }, async ($, on) => {
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const posts: { url: string; body: any }[] = []
  const projects = [{ name: 'main', leader: 'alice', openTasks: 0, docs: 0, here: [] }, { name: 'secret', leader: 'alice', openTasks: 0, docs: 0, here: ['alice'], private: true, members: ['alice'] }]
  const peers = [
    { name: 'alice', online: true, lastSeen: 0, activity: 'idle', leader: true },
    { name: 'bob', online: true, lastSeen: 0, activity: 'idle', leader: false },
  ]
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.init?.method === 'POST') {
      posts.push({ url: e.url, body: JSON.parse(e.init.body) })
      return { value: { status: 200, ok: true, headers: {}, text: '{"members": ["alice", "bob"]}' } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, peers, projects, project: 'secret' }) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_project', name: 'secret' } as any)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-docs' })
  await settle()
  expect(await ui.find({ text: /Members only: alice/ } as any)).toBeDefined()
  expect(await ui.find({ key: 'invite-here' })).toBeUndefined() // no invite-everyone in a private project
  await ui.press({ key: 'member-add-bob' })
  await settle()
  await ui.unmount()
  expect(posts.find(p => p.url.endsWith('/project/members'))?.body).toEqual({ add: ['bob'] })
  await $.tool.call({ tool: 'mcp__crew__crew_project', name: 'main' } as any)
})

test("Crewleader: the leader's Claude learns to sort raw material, and edits there stay private", { options: OPTIONS }, async ($, on) => {
  mock.store(on, { 'folder:http://relay.test:7777:main': 'C:\\Games\\Lava' })
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const touched: string[] = []
  on('http.fetch', async (_$: unknown, e: any) => {
    if (e.url.endsWith('/touch')) touched.push(JSON.parse(e.init.body).path)
    const body = e.url.endsWith('/shared') ? { docs: [] } : e.init?.method === 'POST' ? { ok: true } : POLL // alice (us) leads
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('prompt.compose', async () => ({ sections: [] }) as any)
  on('tool.call', { tool: 'Write' }, async () => ({ result: 'written' }) as any)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-docs' }) // loads the project folder
  await settle()
  expect(await ui.find({ key: 'crewleader-open' })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  const composed: any = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
  const role = composed.sections.find((s: any) => s.id === 'crew:role').text
  expect(role).toContain('C:\\Games\\Lava\\Crewleader is your private raw-material folder')
  expect(role).toContain('never by reading everything')
  expect(role).toContain('ask your user where they are (suggest dropping them in Crewleader)')
  await $.tool.call({ tool: 'Write', file_path: 'C:\\Games\\Lava\\Crewleader\\raw\\boss.lua', content: 'x' } as any)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\Games\\Lava\\src\\boss.lua', content: 'x' } as any)
  await settle()
  expect(touched).toEqual(['src/boss.lua']) // Crewleader edits never go out
})

test('a personal key handed over by the host is saved and used from then on', { options: OPTIONS }, async ($, on) => {
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  const saved: any[] = []
  on('config.set', async (_$: unknown, e: any) => {
    saved.push(e)
    return { value: e.value } as any
  })
  const keys: string[] = []
  on('http.fetch', async (_$: unknown, e: any) => {
    keys.push(e.init?.headers?.['X-Crew-Key'])
    const handOver = keys.length === 1 ? { yourKey: 'personal-key-123' } : {}
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...POLL, ...handOver }) } }
  })
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)
  await settle()
  expect(saved).toContainEqual({ key: 'crew.key', value: 'personal-key-123' })
  expect(keys[keys.length - 1]).toBe('personal-key-123')
})
