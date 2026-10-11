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
    expect(await ui.find({ text: /bob \(working\)/ } as any)).toBeDefined()
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
  await ui.unmount()

  const call = seen.find(s => s.url.endsWith('/leader'))
  expect(JSON.parse(call?.init.body).name).toBe('bob')
})

test('without settings the pane opens on the settings block', async ($, on) => {
  fakeRelay(on)
  const ui = await $.ui.mount({ plugin: 'crew', surface: 'desktop', ...PANE })
  expect(await ui.find({ key: 'opt-key' })).toBeDefined()
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
