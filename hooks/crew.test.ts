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
})

test('the pane draws leader, crew, tasks and settings on terminal and desktop', { options: OPTIONS }, async ($, on) => {
  fakeRelay(on)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'crew', surface, ...PANE })
    expect(await ui.find({ key: 'leader' })).toBeDefined()
    expect(await ui.find({ text: /bob.*working/ } as any)).toBeDefined()
    expect(await ui.find({ text: /for bob/ } as any)).toBeDefined()
    expect(await ui.find({ key: 'opt-relayUrl' })).toBeUndefined()
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'opt-relayUrl' })).toBeDefined()
    expect(await ui.find({ key: 'opt-autoRun' })).toBeDefined()
    await ui.press({ key: 'settings' })
    await ui.unmount()
  }
})

test('picking a leader in the pane tells the relay', { options: OPTIONS }, async ($, on) => {
  const seen = fakeRelay(on)
  await $.tool.call({ tool: 'mcp__crew__crew_status' } as any)

  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
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
  on('fs.read', async () => ({ value: '{"version":"9.9.9"}' }) as any)
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
    if (e.argv.some((a: string) => a.endsWith('start-relay.bat'))) started = true
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
  expect(ran.some(a => a.join(' ').includes('start "Crew relay"') && a.join(' ').endsWith('start-relay.bat'))).toBe(true)
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
    if (e.argv.some((a: string) => a.endsWith('start-relay.bat'))) started = true
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('http.fetch', async (_$: unknown, e: any) => {
    if (!started) return { deny: 'ECONNREFUSED: Unable to connect' } as any
    if (e.url.endsWith('/health')) return { value: { status: 200, ok: true, headers: {}, text: '{"ok": true, "version": "0.8.3"}' } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(POLL) } }
  })
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  await ui.press({ key: 'refresh' })
  await settle(100)
  expect(await ui.find({ text: /relay isn't running/ } as any)).toBeDefined()
  await ui.press({ key: 'start-relay' })
  await settle(200)
  expect(started).toBe(true)
  expect(await ui.find({ text: /relay isn't running/ } as any)).toBeUndefined()
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
  expect(seen.some(s => s.url.includes('/wait?') && s.url.includes('from=bob') && s.url.includes('timeout=30'))).toBe(true)
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
