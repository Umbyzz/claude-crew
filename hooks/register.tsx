import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CrewMessage, CrewSnapshot, CrewTask } from '../types'

const PANE = 'crew'
// Kept in step with plugin.json and server/relay.py by scripts/release.ps1.
const VERSION = '0.9.8'
const LATEST_URL = 'https://raw.githubusercontent.com/Umbyzz/claude-crew/main/.claude-plugin/plugin.json'
const UPDATE_COMMANDS =
  'claude plugin marketplace update claude-crew\nclaude plugin update crew@claude-crew\n# then restart Claude'
const SIX_HOURS = 6 * 60 * 60 * 1000

const EMPTY: CrewSnapshot = {
  connected: false,
  error: '',
  cursor: 0,
  leader: null,
  latest: null,
  relayVersion: null,
  feed: [],
  peers: [],
  tasks: [],
  shared: [],
}
const snapshot = atom({ plugin: 'crew', key: 'snapshot' } as const, EMPTY)
const settingsOpen = atom({ plugin: 'crew', key: 'settingsOpen' } as const, false)
// Are we in the crew session? 'joined', 'left', or 'ask' (reopened Claude: rejoin or not?). Kept across
// reloads of this session; a brand-new Claude session starts empty and asks if you were in one before.
const membership = atom({ plugin: 'crew', key: 'membership' } as const, '' as Membership)
type Membership = '' | 'joined' | 'left' | 'ask'
let joined = true // mirrors membership === 'joined' for the hot paths; session.start sets it properly
// Hosting from inside Claude: the relay runs in the background on this PC, reached locally on HOST_URL.
const HOST_URL = 'http://127.0.0.1:7777'
const hostInfo = atom({ plugin: 'crew', key: 'host' } as const, { ip: '', key: '' })
const confirmReset = atom({ plugin: 'crew', key: 'confirmReset' } as const, false) // the "are you sure?" box
// What the last update check or install said, shown in /crew (not just a toast that's gone in seconds).
type UpdateNote = { state: '' | 'busy' | 'ok' | 'error'; text: string }
const updateNote = atom({ plugin: 'crew', key: 'updateNote' } as const, { state: '', text: '' } as UpdateNote)
const hostNote = atom({ plugin: 'crew', key: 'hostNote' } as const, '') // what Host a crew is doing, or what went wrong
// Messages a teammate flagged "for your human", pinned at the top of /crew until dismissed.
type Pin = { id: number; from: string; text: string; at: number }
const pins = atom({ plugin: 'crew', key: 'pins' } as const, [] as Pin[])
const pendingLeader = atom({ plugin: 'crew', key: 'pendingLeader' } as const, '') // "make X the leader?" awaiting a yes
const joinMode = atom({ plugin: 'crew', key: 'joinMode' } as const, false) // first-run setup: joining a friend's crew
const askTo = atom({ plugin: 'crew', key: 'askTo' } as const, '') // whose Claude "Ask a Claude" goes to ('' = the leader)
const briefed = atom({ plugin: 'crew', key: 'briefed' } as const, 0) // newest message id (+1) this session's Claude was caught up to
const confirmClear = atom({ plugin: 'crew', key: 'confirmClear' } as const, false) // "remove every open task?" awaiting a yes
const confirmLeave = atom({ plugin: 'crew', key: 'confirmLeave' } as const, false) // "leave the crew session?" awaiting a yes
// Shared docs for /crew: who shared each and when (the poll only carries names), and the one opened for a peek.
type DocMeta = { name: string; by: string; at: number; size: number }
const docList = atom({ plugin: 'crew', key: 'docList' } as const, { names: '', docs: [] as DocMeta[] })
type DocPeek = { name: string; head: string[]; more: number; error: string }
const docOpen = atom({ plugin: 'crew', key: 'docOpen' } as const, { name: '', head: [], more: 0, error: '' } as DocPeek)

// Relay time (seconds) as "HH:MM:SS.mmm UTC", for the sent/delivered stamps on crew messages.
function stamp(at: number) {
  return `${new Date(at * 1000).toISOString().slice(11, 23)} UTC`
}
let lastTalk = 0 // when a crew message last came or went: we check in faster for a while after
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

type Config = {
  base: string
  me: string
  key: string
  autoRun: 'off' | 'leader' | 'anyone'
  toasts: 'all' | 'direct' | 'off'
  pollMs: number
  configured: boolean
}
let cfg: Config = { base: '', me: '', key: '', autoRun: 'leader', toasts: 'all', pollMs: 3000, configured: false }
let inflight: Promise<void> | null = null
let delivering: Promise<void> = Promise.resolve() // crew messages being handed to Claude, one batch after another
let skipDelivery = false // while (re)joining: the backlog goes into one catch-up instead of one message each
// Requests that queued a "start work" prompt, and which of those Claude has already answered with crew_send:
// an answered one's queued prompt is dropped instead of running the request a second time.
const queuedRequests = new Map<number, string>() // request id -> who sent it
const answeredRequests = new Set<number>()
let working = false
let failures = 0
let skip = 0
// This session hit its usage limit; teammates are told so and see it in the crew list.
let outOfTokens = false
let limits: { kind: string; percentUsed: number; resetsAt?: string }[] = []
// What this session's Claude is up to, for the Clawds: the turn's phase plus short-lived moments.
let phase: 'idle' | 'thinking' | 'typing' | 'working' = 'idle'
let doneUntil = 0
let cheerUntil = 0
let chatUntil = 0
let chatTo = ''
let subagents = 0
let lastBump = 0
const TYPING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function activityNow() {
  const now = Date.now()
  if (outOfTokens) return 'out'
  if (chatUntil > now) return 'chatting'
  if (cheerUntil > now) return 'cheer'
  if (phase !== 'idle') return phase
  if (doneUntil > now) return 'done'
  return 'idle'
}

// Tell the relay soon after the activity changes (polls are cheap and never touch the model).
function bump($: EngineInterface) {
  const now = Date.now()
  if (now - lastBump < 700) return
  lastBump = now
  poll($).catch(() => {})
}

async function relay($: EngineInterface, method: 'GET' | 'POST', path: string, body?: unknown) {
  if (!cfg.configured) throw new Error('crew is not set up: open /crew and fill in Settings')
  const res = await $.http.fetch(cfg.base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Crew-Key': cfg.key,
      'X-Crew-Name': cfg.me,
      'X-Crew-Activity': activityNow(),
      'X-Crew-Subagents': String(subagents),
      'X-Crew-Chat-To': chatUntil > Date.now() ? chatTo : '',
      'X-Crew-Version': VERSION,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data: any
  try {
    data = JSON.parse(res.text)
  } catch {
    data = { error: res.text.slice(0, 200) }
  }
  if (!res.ok) throw new Error(`relay ${res.status}: ${data?.error ?? 'error'}`)
  return data
}

function line(m: CrewMessage) {
  if (m.kind === 'join' || m.kind === 'leave') return `· ${m.text}`
  const tag =
    m.kind === 'request' ? ' [request]' : m.kind === 'out' ? ' [out of tokens]' : m.kind === 'back' ? ' [back]' : m.kind === 'image' ? ' [image]' : ''
  return `${m.from}${m.to !== 'all' ? ` -> ${m.to}` : ''}${tag}: ${m.text}`
}

// -- the crew session: joining, leaving, and asking after a restart

let joining = false // a second Join (double press, or Start relay joining too) waits out the first instead of re-briefing

async function joinSession($: EngineInterface) {
  if (joining) return
  joining = true
  try {
    await joinOnce($)
  } finally {
    joining = false
  }
}

async function joinOnce($: EngineInterface) {
  await update($, membership, () => 'joined' as Membership)
  await $.store.set(`membership:${cfg.base}`, 'joined')
  joined = true
  lastTalk = Date.now()
  const lastSeen = Number((await $.store.get(`cursor:${cfg.base}`)) ?? 0)
  // The first check-in tells the relay (the crew sees us arrive). What we missed meanwhile goes into
  // one catch-up below rather than being replayed message by message.
  skipDelivery = true
  try {
    await poll($)
  } finally {
    skipDelivery = false
  }
  await catchUp($, lastSeen).catch(() => {}) // and our Claude learns where the crew is at
  $.ui.toast('crew: you joined the crew session', { timeoutMs: 4000 })
}

async function leaveSession($: EngineInterface, why = 'left the crew session') {
  if (joined && cfg.configured) {
    try {
      await relay($, 'POST', '/leave', { why })
    } catch {
      // the relay notices on its own within seconds anyway
    }
  }
  joined = false
  await update($, membership, () => 'left' as Membership)
  await $.store.set(`membership:${cfg.base}`, 'left')
  await update($, snapshot, s => ({ ...s, connected: false, error: '' }))
  $.ui.status('crew: not in the crew session (/crew to join)')
}

function joinPress($: EngineInterface) {
  void joinSession($).catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`))
}

function leavePress($: EngineInterface) {
  void leaveSession($).then(() => $.ui.toast('crew: you left the crew session', { timeoutMs: 4000 }))
}

// Leave crew… asks first: it sat next to Join and Settings, and people pressed it just to close the pane.
function askLeave($: EngineInterface, show: boolean) {
  void update($, confirmLeave, () => show)
}

function leaveYesPress($: EngineInterface) {
  void update($, confirmLeave, () => false).then(() => leavePress($))
}

// -- images: sent through the relay, saved into ~/.claude/crew-inbox for Claude's Read tool to open

async function sendImage($: EngineInterface, path: string, to: string, caption: string) {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  const mime = IMAGE_TYPES[ext]
  if (!mime) throw new Error(`not an image I can send (${Object.keys(IMAGE_TYPES).join(', ')})`)
  const { base64 } = (await $.fs.read(path, { as: 'bytes' })) as { base64: string }
  const name = path.split(/[\\/]/).pop() ?? `image.${ext}`
  lastTalk = Date.now()
  return relay($, 'POST', '/files', { name, mime, data: base64, to, caption })
}

async function receiveImage($: EngineInterface, m: CrewMessage): Promise<string | null> {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
  const dir = `${home}\\.claude\\crew-inbox`
  const safe = String(m.name ?? 'image.png').replace(/[^\w.-]/g, '_')
  const path = `${dir}\\${m.id}-${safe}`
  try {
    const r = await $.process.run(
      ['curl.exe', '-s', '-f', '--create-dirs', '-o', path, '-H', `X-Crew-Key: ${cfg.key}`, `${cfg.base}/file?id=${m.file}`],
      { timeoutMs: 60000 },
    )
    return r.exitCode === 0 ? path : null
  } catch {
    return null
  }
}

// When the fullest usage window resets, as words ("in about 2h 15m") and its timestamp.
function resetHint() {
  const w = [...limits].filter(l => l.resetsAt).sort((a, b) => b.percentUsed - a.percentUsed)[0]
  if (!w?.resetsAt) return 'at an unknown time'
  const ms = Date.parse(w.resetsAt) - Date.now()
  if (!(ms > 0)) return `at ${w.resetsAt}`
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  return `in about ${h ? `${h}h ` : ''}${m}m (${w.resetsAt})`
}

async function markOut($: EngineInterface, why: string) {
  if (outOfTokens || !cfg.configured) return
  outOfTokens = true
  const when = resetHint()
  $.ui.status(`crew: ${cfg.me} · out of tokens, resets ${when}`)
  try {
    await relay($, 'POST', '/send', {
      kind: 'out',
      to: 'all',
      text: `${cfg.me} ran out of tokens (${why}). Their limit resets ${when}.`,
    })
  } catch {
    // The relay is unreachable too; the crew list still shows it on the next good poll.
  }
}

async function markBack($: EngineInterface) {
  if (!outOfTokens) return
  outOfTokens = false
  try {
    await relay($, 'POST', '/send', { kind: 'back', to: 'all', text: `${cfg.me} has tokens again and is back.` })
  } catch {
    // Same as above: the activity flag catches up on the next poll.
  }
}

function crewNote(m: CrewMessage, leader: string | null) {
  if (m.kind === 'out')
    return (
      `A teammate's Claude session just ran out of tokens. Before you continue with anything else, ` +
      `say exactly this to your user: "Oh no our pookie has no more tokens!" ` +
      `Then run crew_status and look at the tasks ${m.from} had claimed or was assigned. Decide how to cover them: ` +
      `wait for the reset if it's soon or the work only makes sense for them, or take them over ` +
      `(release/claim with crew_task) and fill in whatever they left unfinished. ` +
      (leader === cfg.me ? `You are the leader, so re-plan and reassign as needed. ` : '') +
      `Tell the crew what you're doing with crew_send.`
    )
  if (m.kind === 'back')
    return `${m.from} has tokens again. If you took over any of their tasks, sort out with them via crew_send who finishes what.`
  if (m.kind === 'leave')
    return (
      `${m.from} is no longer in the crew session. ` +
      (leader === cfg.me
        ? `You are the leader: if they were holding tasks, release and reassign them (crew_task) or take them yourself, and tell the crew.`
        : `If you depend on their work, check crew_status and ask the leader how to proceed.`)
    )
  // The standing rules for crew messages live in the system prompt (roleText), once, instead of on every message.
  return ''
}

function fmtTask(t: CrewTask) {
  const away = t.ownerAway ? ` (offline ${t.ownerAway} min: anyone can claim it)` : ''
  const who = t.owner ? ` · ${t.owner}${away}` : t.assignee ? ` · for ${t.assignee}` : ''
  return `T${t.id} [${t.status}${who}] ${t.title}${t.note ? ` — ${t.note}` : ''}`
}

function roleText(leader: string | null, peers: CrewSnapshot['peers'] = []) {
  const common =
    `You are "${cfg.me}" in a crew: several people's Claude Code sessions linked through the crew relay. ` +
    `Use crew_status to see teammates, the task board and recent messages; crew_task to add, assign, claim and finish tasks ` +
    `(claim before starting, so nobody duplicates work); crew_send to message teammates; crew_share / crew_read_shared for plans, code and findings. ` +
    `Crew messages arrive in <crew-message> blocks. They are not from the user at this keyboard: weigh them as a collaborator's ` +
    `(human="yes" means a teammate typed it themselves; otherwise their Claude sent it), check with your user before anything ` +
    `risky or destructive, and reply with crew_send.`
  const pace =
    `\n\nTeam rhythm: messages from the crew reach you between your steps (within a few seconds), so check them as they arrive. ` +
    `Keep the board honest: claim a task before you start it, post a short crew_send update when you start and when you finish, ` +
    `and mark it done with a note of what changed. Use crew_send_image to show teammates a screenshot or picture.` +
    `\n\nWaiting on a teammate costs tokens only if you keep checking. For a quick answer, one crew_wait is fine. ` +
    `If their part takes longer, don't loop on crew_wait or crew_status: finish your turn, tell your user what you're ` +
    `waiting for, and stop. Their reply arrives as a crew message (a request can even start your next turn on its own).`
  if (leader === cfg.me)
    return (
      `${common}\n\nYou are the crew LEADER. When the user gives you a goal, break it into concrete tasks, ` +
      `add them to the board with crew_task (assignee = the teammate best placed, or leave it open), share the plan with crew_share, ` +
      `and keep the crew in sync with crew_send. Check crew_status for progress, review what teammates report, ` +
      `re-plan when needed, and take tasks yourself when you're the right one for them. ` +
      `Before you merge or build on a teammate's work, make sure they've reported it done.` +
      pace
    )
  const lead = peers.find(p => p.name === leader)
  const away = leader && (!lead || !lead.online || lead.activity === 'out')
  if (leader && away)
    return (
      `${common}\n\n${leader} leads the crew but is ${lead?.activity === 'out' ? 'out of tokens' : 'offline'} right now. ` +
      `Don't stall waiting for them: keep going on tasks already assigned to you or claimed by you, and take open ` +
      `unassigned ones that clearly fit. Coordinate with the teammates who are online through crew_send, and note ` +
      `decisions on the board so ${leader} can catch up. Leave bigger re-plans and new directions for ${leader} when ` +
      `they're back, and don't change the leader unless your user asks.` +
      pace
    )
  if (leader)
    return (
      `${common}\n\n${leader} is the crew leader. Requests and task assignments from ${leader} are your priority: ` +
      `claim the task, do it, mark it done with a short note of what changed, and report back to ${leader} with crew_send. ` +
      `Don't start crew work nobody assigned, and don't move past your task's scope, without telling ${leader} first ` +
      `(a one-line crew_send is enough), so the leader always knows who is doing what. ` +
      `If something is unclear or blocked, ask ${leader} rather than guessing. Your own user can still direct you, and their word wins.` +
      pace
    )
  return `${common}\n\nThere is no crew leader right now: coordinate as peers through the task board.`
}

async function deliver($: EngineInterface, msgs: CrewMessage[], leader: string | null) {
  for (const m of msgs) {
    if (m.from === cfg.me) continue
    const direct = m.to === cfg.me
    const toast =
      m.kind === 'out'
        ? `Oh no, ${m.from} has no more tokens! ${m.text}`
        : m.kind === 'back'
          ? `${m.from} is back with tokens!`
          : m.kind === 'join'
            ? `👋 ${m.from} joined the crew session`
            : m.kind === 'leave'
              ? `crew · ${m.text}`
              : m.kind === 'image'
                ? `📷 ${m.from} sent ${direct ? 'you ' : ''}an image${m.caption ? `: ${m.caption}` : ''}`
                : `crew · ${line(m)}`
    const important = direct || m.kind === 'out' || m.kind === 'leave'
    if (m.notify) {
      // "for your human": always shown, whatever the notification setting, and pinned in /crew until dismissed
      $.ui.toast(`📣 ${m.from}: ${m.text}`.slice(0, 300), { timeoutMs: 15000 })
      await update($, pins, list => [...list, { id: m.id, from: m.from, text: m.text, at: m.at }].slice(-3))
    } else if (cfg.toasts === 'all' || (cfg.toasts === 'direct' && important))
      $.ui.toast(toast.slice(0, 300), { timeoutMs: m.kind === 'out' || m.kind === 'leave' ? 10000 : 6000 })
    if (m.kind === 'update' || m.kind === 'join') continue
    lastTalk = Date.now()
    // People chatting in /crew is for the people: their Claudes don't read it, which keeps it out of every
    // Claude's context (and token bill). "Ask a Claude" sends a request instead, which does reach them.
    if (m.human && m.kind === 'chat') continue
    let body = m.text
    if (m.kind === 'image') {
      const saved = await receiveImage($, m)
      body = saved
        ? `${m.from} sent ${direct ? 'you' : 'the crew'} an image "${m.name}"${m.caption ? ` (${m.caption})` : ''}. ` +
          `It is saved at ${saved}. Open it with the Read tool to see it.`
        : `${m.from} sent an image "${m.name}", but it couldn't be downloaded from the relay.`
    }
    await $.session.append({
      message: {
        type: 'user',
        content: [
          {
            type: 'text',
            text:
              `<crew-message from="${m.from}"${m.from === leader ? ' role="leader"' : ''} to="${m.to}" kind="${m.kind}" id="${m.id}" ` +
              `sent="${stamp(m.at)}" delivered="${stamp(Date.now() / 1000)}"${m.notify ? ' for-human="yes"' : ''}${m.human ? ' human="yes"' : ''}>\n${body}\n</crew-message>` +
              (m.notify ? `\n(${m.from} flagged this for your user: make sure they see it.)` : '') +
              (crewNote(m, leader) ? `\n${crewNote(m, leader)}` : ''),
          },
        ],
      },
    })
    // On "only from the leader", the leader's own Claude also takes requests that teammates typed in Ask a Claude:
    // the leader's Claude is the crew's coordinator, and a person asking it is the point of having one.
    const trusted =
      cfg.autoRun === 'anyone' ||
      (cfg.autoRun === 'leader' && (m.from === leader || (m.human === true && leader === cfg.me)))
    // A queued prompt only resolves once Claude is free to start it, so it is never awaited here:
    // waiting on it would hold up the check-ins, and the relay would think we'd dropped off.
    // Only an idle Claude needs a prompt to start on it: a busy one reads the request in its current turn,
    // and a queued prompt would then run it a second time once it goes idle.
    if (direct && m.kind === 'request' && trusted && !working) {
      queuedRequests.set(m.id, m.from)
      void $.prompt
        .submit({
          text: `Crew request #${m.id} from ${m.from}${m.from === leader ? ' (crew leader)' : ''}${m.human ? ', typed by them in /crew' : ''}:\n\n${m.text}\n\nWork on it if it's reasonable, then report back to ${m.from} with crew_send.`,
        })
        .catch(() => {})
    }
    // The leader re-plans as soon as a teammate runs dry, even from idle; everyone else reacts on their next turn.
    if (m.kind === 'out' && leader === cfg.me && cfg.autoRun !== 'off') {
      void $.prompt
        .submit({
          text: `${m.from} just ran out of tokens: ${m.text}\n\nFollow the crew note above: say the line, then re-plan their tasks for the crew.`,
        })
        .catch(() => {})
    }
  }
}

// One poll at a time: a caller that arrives mid-poll waits for that poll instead of reading stale state.
function poll($: EngineInterface): Promise<void> {
  if (!cfg.configured || !joined) return Promise.resolve()
  if (!inflight) inflight = pollOnce($).finally(() => (inflight = null))
  return inflight
}

async function pollOnce($: EngineInterface) {
  try {
    const prev = await read($, snapshot)
    const stored = Number((await $.store.get(`cursor:${cfg.base}`)) ?? -1)
    const since = prev.cursor || Math.max(stored, 0)
    const data = await relay($, 'GET', `/poll?since=${since}`)
    const msgs: CrewMessage[] = data.messages ?? []
    const leader: string | null = data.leader ?? null
    // A teammate's crew_ping: echo it right away. The plugin answers; this Claude never sees it (no tokens).
    for (const id of Array.isArray(data.pings) ? data.pings : []) void relay($, 'POST', '/pong', { id }).catch(() => {})
    // A first-ever connection shows recent history in the pane but doesn't replay it into the conversation.
    // Delivery runs on its own track (in order), so a slow image download never delays the next check-in.
    if (!skipDelivery && (stored >= 0 || prev.cursor > 0))
      delivering = delivering.then(() => deliver($, msgs, leader)).catch(() => {})
    const cursor = Math.max(since, Number(data.cursor) || 0)
    await $.store.set(`cursor:${cfg.base}`, cursor)
    const epoch = Number(data.chatEpoch ?? 0)
    await update($, snapshot, s => ({
      connected: true,
      error: '',
      cursor,
      leader,
      latest: s.latest ?? null,
      relayVersion: data.version ?? null,
      chatEpoch: epoch,
      // someone pressed Reset chat (the relay's chat epoch moved on): start this chat over too
      feed: (s.chatEpoch === epoch ? [...s.feed, ...msgs.filter(m => !s.feed.some(f => f.id === m.id))] : msgs).slice(-100),
      peers: data.peers ?? [],
      tasks: data.tasks ?? [],
      shared: data.shared ?? [],
      reads: data.reads && typeof data.reads === 'object' ? data.reads : undefined, // absent from an older relay
    }))
    // a doc shared again under the same name keeps the list the same, but who/when/size change
    syncDocs($, data.shared ?? [], msgs.some(m => m.kind === 'update' && m.text.startsWith('shared doc ')))
    failures = 0
    const online = (data.peers ?? []).filter((p: any) => p.online && p.name !== cfg.me).length
    const role = leader === cfg.me ? ' (leader)' : ''
    $.ui.status(`crew: ${cfg.me}${role} · ${online} teammate${online === 1 ? '' : 's'} online`)
  } catch (err) {
    const msg = explain(err instanceof Error ? err.message : String(err))
    failures += 1
    // Back off while the relay is unreachable: skip 1, 2, 4 ... up to 10 ticks between tries.
    skip = Math.min(10, 2 ** Math.min(failures - 1, 4))
    await update($, snapshot, s => ({ ...s, connected: false, error: msg }))
    $.ui.status(`crew: offline (${msg.slice(0, 60)})`)
  }
}

function tick($: EngineInterface) {
  if (skip > 0) {
    skip -= 1
    return
  }
  poll($).catch(() => {})
}

// Every second, while this Claude is mid-turn or the crew has been talking in the last 30s, check in
// right away: a teammate's message then lands within about a second instead of the usual few.
function fastTick($: EngineInterface) {
  if (!joined || skip > 0) return
  if (working || Date.now() - lastTalk < 30000) poll($).catch(() => {})
}

function say($: EngineInterface, value: string) {
  const text = value.trim()
  if (!text) return
  if (!joined) {
    $.ui.toast('crew: join the crew session first (Join session, top right)', { timeoutMs: 5000 })
    return
  }
  const dm = text.match(/^@(\S+)\s+([\s\S]+)$/)
  chatUntil = lastTalk = Date.now() + 8000
  chatTo = dm ? dm[1] : ''
  // Chat typed here is between the humans: it shows in everyone's /crew, but no Claude reads it (saves their tokens).
  void relay($, 'POST', '/send', { text: dm ? dm[2] : text, to: dm ? dm[1] : 'all', kind: 'chat', human: true })
    .then(() => poll($))
    .catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`))
}

// "Ask a Claude": a person talks straight to a teammate's Claude (the leader's by default). It arrives as a
// request, so it starts work right away when that Claude's Auto-run setting allows it.
function ask($: EngineInterface, target: string, value: string) {
  const text = value.trim()
  if (!text) return
  if (!joined) {
    $.ui.toast('crew: join the crew session first (Join session, top right)', { timeoutMs: 5000 })
    return
  }
  if (!target) {
    $.ui.toast('crew: there is no leader yet: pick whose Claude to ask', { timeoutMs: 5000 })
    return
  }
  chatUntil = lastTalk = Date.now() + 8000
  chatTo = target
  void relay($, 'POST', '/send', { text, to: target, kind: 'request', human: true })
    .then(() => poll($))
    .then(() => $.ui.toast(`crew: asked ${target}'s Claude`, { timeoutMs: 4000 }))
    .catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`))
}

// -- shared docs in /crew: the names come with every check-in; who shared each and when, only when that changes

let docsKey: string | null = null // the doc names we last fetched details for (null: not yet, or after a reload)
const docText = new Map<string, string>() // docs opened for a peek, so Copy needs no second fetch

function syncDocs($: EngineInterface, names: string[], reshared = false) {
  const key = names.join('\n')
  if (key === docsKey && !reshared) return
  docsKey = key
  docText.clear()
  if (!key) {
    void update($, docList, () => ({ names: '', docs: [] as DocMeta[] }))
    return
  }
  void relay($, 'GET', '/shared')
    .then(data => update($, docList, () => ({ names: key, docs: Array.isArray(data.docs) ? (data.docs as DocMeta[]) : [] })))
    .catch(() => (docsKey = null)) // try again on the next check-in
}

async function openDoc($: EngineInterface, name: string) {
  if ((await read($, docOpen)).name === name) {
    await update($, docOpen, () => ({ name: '', head: [], more: 0, error: '' }))
    return
  }
  await update($, docOpen, () => ({ name, head: [], more: 0, error: '' }))
  try {
    const doc = await relay($, 'GET', `/shared?name=${encodeURIComponent(name)}`)
    const content = String(doc.content ?? '')
    docText.set(name, content)
    const lines = content.split(/\r?\n/)
    const head = lines.slice(0, 8).map(l => (l.length > 160 ? `${l.slice(0, 159)}…` : l))
    await update($, docOpen, d => (d.name === name ? { name, head, more: Math.max(0, lines.length - 8), error: '' } : d))
  } catch (err) {
    const error = explain(err instanceof Error ? err.message : String(err))
    await update($, docOpen, d => (d.name === name ? { ...d, error } : d))
  }
}

function openDocPress($: EngineInterface, name: string) {
  void openDoc($, name)
}

function copyDoc($: EngineInterface, surface: any, name: string) {
  const copy = (text: string) =>
    $.ui
      .copy({ text, surface })
      .then(r => $.ui.toast(r.isCopied ? `crew: copied "${name}" (${text.length} chars)` : `crew: couldn't copy it; your Claude can read it with crew_read_shared`, { timeoutMs: 5000 }))
  const cached = docText.get(name)
  if (cached !== undefined) {
    void copy(cached)
    return
  }
  void relay($, 'GET', `/shared?name=${encodeURIComponent(name)}`)
    .then(doc => copy(String(doc.content ?? '')))
    .catch(err => $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 }))
}

// -- the chat, drawn like a messenger: your bubbles right, everyone else's left, crew events as dim centred lines

// Read receipts for your own messages: who it went to, and whose plugin has picked it up (the relay's "reads").
// '' when there's nothing to say: nobody else in the crew, or a relay too old to report reads.
function receipt(m: CrewMessage, s: CrewSnapshot, me: string) {
  if (!s.reads) return ''
  const reads = s.reads
  const to = s.peers.filter(p => p.name !== me && (m.to === 'all' || m.to === p.name)).map(p => p.name)
  if (!to.length) return ''
  const readers = to.filter(n => (reads[n] ?? 0) >= m.id)
  if (!readers.length) return 'not read yet'
  if (readers.length === to.length) return to.length > 1 ? 'read by everyone' : `read by ${readers[0]}`
  return `read by ${readers.join(', ')} (${to.length - readers.length} not yet)`
}

const SYSTEM_KINDS = new Set<CrewMessage['kind']>(['join', 'leave', 'update', 'out', 'back'])
const GROUP_GAP = 5 * 60 // seconds: a pause this long starts a new bubble, even from the same sender

type ChatItem =
  | { type: 'event'; id: number; text: string; at: number }
  | { type: 'more'; id: number; count: number }
  | { type: 'group'; id: number; mine: boolean; from: string; human: boolean; to: string; request: boolean; msgs: CrewMessage[] }

function hhmm(at: number) {
  const d = new Date(at * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function eventText(m: CrewMessage) {
  return m.kind === 'update' ? `${m.from} ${m.text}` : m.text // joins, leaves and out/back already name who
}

function bubbleText(m: CrewMessage) {
  const body = m.kind === 'image' ? `🖼 ${m.name ?? 'image'}${m.caption ? `: ${m.caption}` : ''}` : m.text
  return m.notify ? `📣 ${body}` : body
}

// Back-to-back messages from one sender to the same place share a bubble; more than three crew events in a
// row fold into "N more updates" plus the last two.
function chatItems(feed: CrewMessage[], me: string): ChatItem[] {
  const items: ChatItem[] = []
  for (const m of feed) {
    if (SYSTEM_KINDS.has(m.kind)) {
      items.push({ type: 'event', id: m.id, text: eventText(m), at: m.at })
      continue
    }
    const human = !!m.human
    const request = m.kind === 'request'
    const last = items[items.length - 1]
    if (
      last?.type === 'group' &&
      last.from === m.from &&
      last.human === human &&
      last.to === m.to &&
      last.request === request &&
      m.at - last.msgs[last.msgs.length - 1].at < GROUP_GAP
    )
      last.msgs.push(m)
    else items.push({ type: 'group', id: m.id, mine: m.from === me, from: m.from, human, to: m.to, request, msgs: [m] })
  }
  const folded: ChatItem[] = []
  for (let i = 0; i < items.length; ) {
    let j = i
    while (j < items.length && items[j].type === 'event') j++
    if (j - i > 3) {
      folded.push({ type: 'more', id: items[i].id, count: j - i - 2 }, items[j - 2], items[j - 1])
      i = j
    } else folded.push(items[i++])
  }
  return folded
}

// The line above a bubble: who (a person, or their Claude), where it went, and when.
function groupHeader(g: Extract<ChatItem, { type: 'group' }>, me: string) {
  const who = g.mine ? (g.human ? '' : 'your Claude') : g.human ? g.from : `${g.from}'s Claude`
  const to = g.to === 'all' ? '' : `→ ${g.to === me ? 'you' : g.to}`
  return [who, to, g.request ? 'request' : '', hhmm(g.msgs[g.msgs.length - 1].at)].filter(Boolean).join(' · ')
}

// Roughly how many rows an item takes at this bubble width, so the newest messages that fit are the ones drawn.
function itemRows(item: ChatItem, bubbleCols: number) {
  if (item.type !== 'group') return 1
  const inner = Math.max(10, bubbleCols - 4)
  return 3 + item.msgs.reduce((n, m) => n + Math.max(1, Math.ceil(bubbleText(m).length / inner)), 0)
}

function fitChat(items: ChatItem[], rows: number, bubbleCols: number) {
  let used = 0
  let start = items.length
  while (start > 0) {
    const need = itemRows(items[start - 1], bubbleCols)
    if (used + need > rows && start < items.length) break
    used += need
    start--
  }
  return items.slice(start)
}

// The pane's two building blocks, made once per surface's Box/Text (see the ui.render hook).
const blockCache = new Map<any, { Section: any; Callout: any }>()
function blocksFor(Box: any, Text: any) {
  let made = blockCache.get(Box)
  if (!made) blockCache.set(Box, (made = makeBlocks(Box, Text)))
  return made
}
function makeBlocks(Box: any, Text: any) {
  // A titled block: one bold heading, then its content, with a blank line above.
  const Section = ({ title, right, children }: any) => (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>{title}</Text>
        {right}
      </Box>
      {children}
    </Box>
  )
  // A notice that wants attention: framed, with its buttons underneath.
  const Callout = ({ children }: any) => (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
      {children}
    </Box>
  )
  return { Section, Callout }
}

// -- the task manager in /crew: the same board the Claudes use through crew_task

function taskAction($: EngineInterface, body: Record<string, unknown>, done?: string) {
  if (!joined) {
    $.ui.toast('crew: join the crew session first (Join session, top right)', { timeoutMs: 5000 })
    return
  }
  void relay($, 'POST', '/tasks', body)
    .then(() => poll($))
    .then(() => done && $.ui.toast(`crew: ${done}`, { timeoutMs: 3000 }))
    .catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`))
}

function addTask($: EngineInterface, value: string) {
  // "title @name" assigns it straight away
  const m = value.trim().match(/^([\s\S]*?)(?:\s+@(\S+))?$/)
  const title = (m?.[1] ?? '').trim()
  if (!title) return
  taskAction($, { action: 'add', title, assignee: m?.[2] }, 'task added')
}

function askClear($: EngineInterface, on: boolean) {
  void update($, confirmClear, () => on)
}

async function clearTasks($: EngineInterface) {
  await update($, confirmClear, () => false)
  const s = await read($, snapshot)
  const ids = s.tasks.filter(t => t.status !== 'done').map(t => t.id)
  for (const id of ids) await relay($, 'POST', '/tasks', { action: 'remove', id }).catch(() => {})
  await poll($).catch(() => {})
  $.ui.toast(`crew: removed ${ids.length} task${ids.length === 1 ? '' : 's'}`, { timeoutMs: 4000 })
}

function setAskTo($: EngineInterface, name: string) {
  void update($, askTo, () => name)
}

function setLeader($: EngineInterface, name: string) {
  if (!joined) {
    $.ui.toast('crew: join the crew session first (Join session, top right)', { timeoutMs: 5000 })
    return
  }
  void relay($, 'POST', '/leader', { name })
    .then(() => poll($))
    .catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`))
}

function setOption($: EngineInterface, field: string, value: string) {
  // Still setting up: Settings comes up open once you're in, so you can check it all before closing it.
  if (!cfg.configured) void update($, settingsOpen, () => true)
  void $.config
    .set({ key: `crew.${field}`, value: value.trim() })
    .then(r => $.ui.toast(r.deny ? `crew: ${r.deny}` : `crew: saved ${field}`))
}

function testConnection($: EngineInterface, base: string) {
  if (!base) {
    $.ui.toast('crew: type the relay URL above and press Enter to save it first', { timeoutMs: 6000 })
    return
  }
  void $.http
    .fetch(`${base}/health`)
    .then(r => $.ui.toast(r.ok ? `crew: relay reachable (${r.text.slice(0, 60)})` : `crew: relay answered ${r.status}`))
    .catch(err => $.ui.toast(`crew: can't reach ${base}: ${err instanceof Error ? err.message : err}`))
}

// True when version a is newer than b (plain x.y.z).
function newer(a: string | null | undefined, b: string) {
  if (!a) return false
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  }
  return false
}

// Which version GitHub has. The API answers fresh; the raw file can lag ~5 minutes behind a push, so it's the fallback.
const LATEST_API = 'https://api.github.com/repos/Umbyzz/claude-crew/contents/.claude-plugin/plugin.json?ref=main'

async function fetchLatest($: EngineInterface): Promise<string | null> {
  const tries: [string, Record<string, string>][] = [
    [LATEST_API, { Accept: 'application/vnd.github.raw', 'User-Agent': 'claude-crew' }],
    [`${LATEST_URL}?t=${Date.now()}`, {}],
  ]
  for (const [url, headers] of tries) {
    try {
      const res = await $.http.fetch(url, { headers })
      if (res.ok) {
        const v = String(JSON.parse(res.text).version ?? '')
        if (/^\d+\.\d+\.\d+$/.test(v)) return v
      }
    } catch {
      // try the next source
    }
  }
  return null
}

// Asks GitHub which version is out. Returns it, or null when GitHub can't be reached.
async function checkUpdate($: EngineInterface): Promise<string | null> {
  const latest = await fetchLatest($)
  if (latest === null) return null
  const before = await read($, snapshot)
  await update($, snapshot, s => ({ ...s, latest }))
  if (newer(latest, VERSION) && before.latest !== latest)
    $.ui.toast(`crew ${latest} is out (you have ${VERSION}). Open /crew to update.`, { timeoutMs: 10000 })
  return latest
}

function setUpdateNote($: EngineInterface, state: UpdateNote['state'], text: string) {
  void update($, updateNote, () => ({ state, text }))
}

function checkNow($: EngineInterface) {
  setUpdateNote($, 'busy', 'Checking GitHub…')
  void checkUpdate($).then(latest =>
    setUpdateNote(
      $,
      latest === null ? 'error' : 'ok',
      latest === null
        ? "Couldn't reach GitHub. Check your internet and try again."
        : newer(latest, VERSION)
          ? `crew ${latest} is out. Press Install update.`
          : `You're up to date (${VERSION}).`,
    ),
  )
}

// The claude CLI, as a command to run: claude.exe on PATH, else npm's claude.cmd (through cmd),
// else the newest copy the desktop app keeps under %APPDATA%\Claude\claude-code.
async function findClaude($: EngineInterface): Promise<string[] | null> {
  try {
    const r = await $.process.run(['where', 'claude'], { timeoutMs: 20000 })
    const found = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    const exe = found.find(l => l.toLowerCase().endsWith('.exe'))
    if (exe) return [exe]
    const cmd = found.find(l => l.toLowerCase().endsWith('.cmd'))
    if (cmd) return ['cmd', '/c', cmd]
  } catch {
    // not on PATH
  }
  try {
    // where /r takes the folder as its own argument, so there are no nested quotes for cmd to mangle
    const appData = (await $.env.get('APPDATA')) || `${(await $.env.get('USERPROFILE')) || ''}\\AppData\\Roaming`
    const r = await $.process.run(['where', '/r', `${appData}\\Claude\\claude-code`, 'claude.exe'], { timeoutMs: 20000 })
    const versionOf = (p: string) => p.match(/claude-code\\(\d+\.\d+\.\d+)/)?.[1] ?? '0.0.0'
    const found = r.stdout
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.toLowerCase().endsWith('claude.exe'))
      .sort((a, b) => (newer(versionOf(a), versionOf(b)) ? -1 : newer(versionOf(b), versionOf(a)) ? 1 : 0))
    if (found.length) return [found[0]]
  } catch {
    // no desktop-app copy either
  }
  return null
}

const ZIP_URL = 'https://github.com/Umbyzz/claude-crew/archive/refs/heads/main.zip'

// Every step of an update, for %TEMP%\crew-update.log: when one fails on a friend's PC, the log says which and why.
let updateLog: string[] = []

async function ran($: EngineInterface, argv: string[], timeoutMs = 60000) {
  try {
    const r = await $.process.run(argv, { timeoutMs })
    const out = `${r.stdout}\n${r.stderr}`.trim()
    updateLog.push(`> ${argv.join(' ')}\n  exit ${r.exitCode}${out ? `\n  ${out.slice(0, 600).replace(/\n/g, '\n  ')}` : ''}`)
    return { ok: r.exitCode === 0, code: r.exitCode, out }
  } catch (err) {
    const out = err instanceof Error ? err.message : String(err)
    updateLog.push(`> ${argv.join(' ')}\n  failed to run: ${out}`)
    return { ok: false, code: -1, out }
  }
}

// A path as a PowerShell literal. Never put double quotes inside one argument for cmd: Windows escapes them
// on the way in (\"), and cmd then sees a mangled path ("The filename, directory name ... is incorrect").
const psPath = (p: string) => `'${p.replace(/'/g, "''")}'`

async function makeDir($: EngineInterface, dir: string) {
  return ran($, ['powershell', '-NoProfile', '-Command', `New-Item -ItemType Directory -Force -Path ${psPath(dir)} | Out-Null`], 20000)
}

async function removeDir($: EngineInterface, dir: string) {
  return ran($, ['powershell', '-NoProfile', '-Command', `Remove-Item -LiteralPath ${psPath(dir)} -Recurse -Force -ErrorAction SilentlyContinue`], 30000)
}

// The plugin updates its own files: download the latest from GitHub and copy it over this plugin's folder.
// That works however crew was installed (marketplace, desktop-app upload, a copied folder) and needs no
// claude CLI. The relay's key and data are never touched. Returns null when it worked, else what went wrong.
async function selfUpdate($: EngineInterface): Promise<string | null> {
  // no trailing backslash: robocopy would read `"C:\x\"` as an escaped quote
  const root = $.plugin.root.replace(/\//g, '\\').replace(/\\+$/, '')
  const temp = (await $.env.get('TEMP')) || (await $.env.get('TMP')) || `${root}\\..`
  const dir = `${temp}\\crew-update-${Date.now()}`
  const src = `${dir}\\claude-crew-main`
  updateLog.push(`plugin root: ${root}\ntemp: ${temp}`)
  try {
    setUpdateNote($, 'busy', 'Downloading the latest crew from GitHub…')
    const made = await makeDir($, dir)
    if (!made.ok) return `couldn't make a temp folder (${made.out.slice(0, 160) || `exit ${made.code}`})`
    const dl = await ran($, ['curl.exe', '-sSfL', '-o', `${dir}\\crew.zip`, ZIP_URL], 120000)
    if (!dl.ok) return `download failed (${dl.out.slice(0, 160) || `curl exit ${dl.code}`})`
    setUpdateNote($, 'busy', 'Unpacking…')
    const unzip = await ran($, ['tar.exe', '-xf', `${dir}\\crew.zip`, '-C', dir])
    if (!unzip.ok) return `unpacking failed (${unzip.out.slice(0, 160) || `tar exit ${unzip.code}`})`
    const want = String(JSON.parse(String(await $.fs.read(`${src}\\.claude-plugin\\plugin.json`))).version ?? '')
    setUpdateNote($, 'busy', `Installing crew ${want}…`)
    // robocopy: exit codes below 8 mean success. Never copy over the relay's key or saved chat.
    const copy = await ran($, ['robocopy', src, root, '/E', '/XD', '.git', '/XF', 'crew_key.txt', 'crew_state.json',
      '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], 120000)
    if (copy.code >= 8) return `copying the files failed (${copy.out.slice(0, 160) || `robocopy exit ${copy.code}`})`
    const now = String(JSON.parse(String(await $.fs.read(`${root}\\.claude-plugin\\plugin.json`))).version ?? '')
    if (now !== want) return `the files didn't take (still ${now}): is the plugin folder read-only?`
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  } finally {
    void removeDir($, dir)
  }
}

async function isGitCheckout($: EngineInterface) {
  try {
    await $.fs.read(`${$.plugin.root}\\.git\\HEAD`)
    return true
  } catch {
    return false
  }
}

// Installed through the desktop app's plugin upload: there's no claude-crew marketplace for the CLI to update.
function isDesktopUpload($: EngineInterface) {
  return /local-desktop-app-uploads/i.test($.plugin.root)
}

async function writeUpdateLog($: EngineInterface) {
  try {
    const temp = (await $.env.get('TEMP')) || (await $.env.get('TMP'))
    if (!temp) return ''
    const path = `${temp}\\crew-update.log`
    await $.fs.write(path, `crew ${VERSION} update, ${new Date().toISOString()}\n\n${updateLog.join('\n\n')}\n`)
    return path
  } catch {
    return ''
  }
}

// Install update: the plugin updates its own files from GitHub; the claude CLI is only the fallback.
// Every step shows up in /crew, so if it fails you can see exactly where and why.
async function installUpdate($: EngineInterface) {
  if (await isGitCheckout($)) {
    setUpdateNote($, 'error', "This copy runs from a git checkout (you're developing crew): pull the latest in GitHub Desktop, then restart Claude.")
    return
  }
  updateLog = []
  const failure = await selfUpdate($)
  const log = await writeUpdateLog($)
  const seeLog = log ? ` Every step is in ${log}.` : ''
  if (failure === null) {
    setUpdateNote($, 'ok', 'Updated! Restart Claude to load the new version.')
    $.ui.toast('crew: updated! Restart Claude to load the new version.', { timeoutMs: 15000 })
    return
  }
  // The direct download's reason stays in every message from here on: it's the one that matters.
  if (isDesktopUpload($)) {
    setUpdateNote($, 'error', `Direct update failed: ${failure}. This copy was uploaded through the desktop app, so there's no CLI route: reinstall from the GitHub zip.${seeLog}`)
    return
  }
  setUpdateNote($, 'busy', `Direct update failed (${failure}). Trying the claude CLI…`)
  const claude = await findClaude($)
  if (!claude) {
    setUpdateNote($, 'error', `Update failed. Direct download: ${failure}. CLI fallback: no claude CLI found. Reinstall from the GitHub zip.${seeLog}`)
    return
  }
  const steps: [string, string[]][] = [
    ['Refreshing the crew marketplace from GitHub…', ['plugin', 'marketplace', 'update', 'claude-crew']],
    ['Installing the new version…', ['plugin', 'update', 'crew@claude-crew']],
  ]
  for (const [label, args] of steps) {
    setUpdateNote($, 'busy', label)
    try {
      const r = await $.process.run([...claude, ...args], { timeoutMs: 120000 })
      if (r.exitCode !== 0) {
        const why = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300)
        setUpdateNote($, 'error', `Update failed. Direct download: ${failure}. CLI fallback: ${why || `exit code ${r.exitCode}`}. Try Copy commands.${seeLog}`)
        return
      }
    } catch (err) {
      setUpdateNote($, 'error', `Update failed. Direct download: ${failure}. CLI fallback: ${err instanceof Error ? err.message : err}. Try Copy commands.${seeLog}`)
      return
    }
  }
  setUpdateNote($, 'ok', 'Updated! Restart Claude to load the new version.')
  $.ui.toast('crew: updated! Restart Claude to load the new version.', { timeoutMs: 15000 })
}

function installPress($: EngineInterface) {
  void installUpdate($)
}

function copyUpdate($: EngineInterface, surface: any) {
  void $.ui
    .copy({ text: UPDATE_COMMANDS, surface })
    .then(r => $.ui.toast(r.isCopied ? 'crew: update commands copied; run them in a terminal' : `crew: run these in a terminal:\n${UPDATE_COMMANDS}`, { timeoutMs: 12000 }))
}

// The desktop window: its own little Python program, detached, reading the relay. No tokens.
// Only one ever runs: launching it again just brings the open one to the front.
async function popOut($: EngineInterface) {
  return launchWindow($, 'clawd_window.py', py => `The Clawds window is out (${py}). Drag it anywhere; right-click it for options.`)
}

// The crew log: every crew message live in its own window, Claude↔Claude traffic included. No tokens either.
async function crewLogOut($: EngineInterface) {
  return launchWindow($, 'crew_log.py', () => 'The crew log is open: Everything / Claudes / People at the top, and "On top" to pin it.')
}

async function launchWindow($: EngineInterface, file: string, done: (py: string) => string) {
  const script = `${$.plugin.root}/window/${file}`
  for (const py of ['pythonw', 'pyw', 'python']) {
    try {
      const r = await $.process.run(['cmd', '/c', 'start', '""', py, script], { timeoutMs: 10000 })
      if (r.exitCode === 0) return done(py)
    } catch {
      // try the next Python launcher
    }
  }
  return `Couldn't start Python. Run it yourself: pythonw "${script}"`
}

function popOutPress($: EngineInterface) {
  void popOut($).then(text => $.ui.toast(`crew: ${text}`, { timeoutMs: 8000 }))
}

// -- hosting from /crew: no server window to open, the relay runs in the background on this PC

function isHosting() {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(cfg.base)
}

async function crewDir($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
  return `${home}\\.claude\\crew-relay`
}

// The address friends use: the Radmin (26.x) or Tailscale (100.x) one if there is one, else the LAN one.
async function lanAddress($: EngineInterface) {
  try {
    const r = await $.process.run(['ipconfig'], { timeoutMs: 15000 })
    const ips = [...r.stdout.matchAll(/IPv4[^:]*:\s*([\d.]+)/g)].map(m => m[1])
    return ips.find(ip => ip.startsWith('26.')) || ips.find(ip => ip.startsWith('100.')) || ips.find(ip => !ip.startsWith('127.')) || ''
  } catch {
    return ''
  }
}

async function relayVersionAt($: EngineInterface, url: string): Promise<string | null> {
  try {
    const r = await $.http.fetch(`${url}/health`)
    return r.ok ? String(JSON.parse(r.text).version ?? '?') : null
  } catch {
    return null
  }
}

function newKey() {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

async function readKey($: EngineInterface, path: string) {
  try {
    return String(await $.fs.read(path)).trim()
  } catch {
    return ''
  }
}

// Starts the relay on this PC by opening start-relay.bat in its own window. The .bat keeps its key
// (crew_key.txt) and data (crew_state.json) next to it, so it's the same relay with the same chat and tasks
// every time. Returns true once the relay answers.
async function startRelay($: EngineInterface): Promise<boolean> {
  setHostNote($, 'Starting your relay (a "Crew relay" window opens: keep it open while you host)…') // feedback first
  if (await relayVersionAt($, HOST_URL)) {
    setHostNote($, '')
    return true
  }
  // Start-Process opens the .bat in its own console, fully detached, and returns at once. (cmd's `start`
  // lets the window inherit our output pipes, so the run never finishes and its timeout kills the relay.)
  const server = `${$.plugin.root.replace(/\//g, '\\')}\\server`
  try {
    const r = await $.process.run(
      ['powershell', '-NoProfile', '-Command', `Start-Process -FilePath '${server}\\start-relay.bat' -WorkingDirectory '${server}'`],
      { timeoutMs: 20000 },
    )
    if (r.exitCode !== 0) {
      setHostNote($, `Couldn't open start-relay.bat: ${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.exitCode}`}`)
      return false
    }
  } catch (err) {
    setHostNote($, `Couldn't open start-relay.bat: ${err instanceof Error ? err.message : err}`)
    return false
  }
  for (let i = 0; i < 20; i++) {
    await $.clock.sleep(500)
    if (await relayVersionAt($, HOST_URL)) {
      setHostNote($, '')
      return true
    }
  }
  setHostNote($, "The relay didn't start. Is Python installed (python.org)? The Crew relay window shows the error.")
  return false
}

// Start relay = host and be in it: once the relay answers, join the session too (if you weren't already).
function startRelayPress($: EngineInterface) {
  void startRelay($).then(async up => {
    if (!up) return
    if (!joined && isHosting()) await joinSession($).catch(() => {})
    else await refresh($).catch(() => {})
  })
}

async function hostCrew($: EngineInterface) {
  if (!cfg.me) {
    $.ui.toast('crew: save Your name first (type it and press Enter), then press Host a crew', { timeoutMs: 8000 })
    return
  }
  if (!(await startRelay($))) return
  // A relay is up here: use its key (where start-relay.bat keeps it, then older versions' spots), or the one already saved.
  const dir = await crewDir($)
  const key =
    (await readKey($, `${dir}\\crew_key.txt`)) ||
    (await readKey($, `${$.plugin.root}\\server\\crew_key.txt`)) ||
    (await readKey($, `${dir}\\key.txt`)) ||
    cfg.key
  if (!key) {
    setHostNote($, "A relay is running on this PC, but I can't find its key. Paste it into Crew key below.")
    return
  }
  const ip = await lanAddress($)
  await update($, hostInfo, () => ({ ip, key }))
  setHostNote($, '')
  await update($, settingsOpen, () => true) // shown once you're in; close it when you've had a look
  // Straight into the session: mark us joined, then point the plugin at its own relay.
  await update($, membership, () => 'joined' as Membership)
  await $.store.set(`membership:${HOST_URL}`, 'joined')
  $.ui.toast("crew: you're hosting and in the session! Press Copy invite and send it to your friends.", { timeoutMs: 8000 })
  if (cfg.key === key && cfg.base === HOST_URL) {
    await joinSession($) // nothing to save, so no reload: join right here
    return
  }
  // Each saved setting reloads the plugin; the reload connects and joins on its own.
  if (cfg.key !== key) await $.config.set({ key: 'crew.key', value: key })
  if (cfg.base !== HOST_URL) await $.config.set({ key: 'crew.relayUrl', value: HOST_URL })
}

function setHostNote($: EngineInterface, text: string) {
  void update($, hostNote, () => text)
}

function setJoinMode($: EngineInterface, on: boolean) {
  void update($, joinMode, () => on)
}

function unpin($: EngineInterface, id: number) {
  void update($, pins, list => list.filter(p => p.id !== id))
}

// Changing the leader asks first (no more accidental tug-of-war); '__none' means "clear the leader".
function proposeLeader($: EngineInterface, name: string) {
  void update($, pendingLeader, () => name)
}

function confirmLeader($: EngineInterface, name: string) {
  void update($, pendingLeader, () => '')
  setLeader($, name === '__none' ? '' : name)
}

// Hosting already (say after a restart): find the address to put in the invite.
async function refreshHostInfo($: EngineInterface) {
  const ip = await lanAddress($)
  await update($, hostInfo, h => ({ ip, key: h.key || cfg.key }))
}

function hostPress($: EngineInterface) {
  void hostCrew($).catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`, { timeoutMs: 8000 }))
}

async function stopHosting($: EngineInterface) {
  setHostNote($, 'Stopping your relay…') // shown at once, so one click visibly does something
  try {
    await $.http.fetch(`${HOST_URL}/shutdown`, {
      method: 'POST',
      headers: { 'X-Crew-Key': cfg.key, 'Content-Type': 'application/json' },
      body: '{}',
    })
    // The relay answers before it stops: wait until it's really gone, so /crew flips to "not running" right away.
    for (let i = 0; i < 10 && (await relayVersionAt($, HOST_URL)); i++) await $.clock.sleep(300)
    $.ui.toast('crew: the relay is stopped. Everyone is disconnected until someone hosts again.', { timeoutMs: 8000 })
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
  setHostNote($, '')
  await poll($).catch(() => {})
}

function stopHostingPress($: EngineInterface) {
  void stopHosting($)
}

// After an update the old relay keeps running (Start relay sees it answering and leaves it be):
// stop it, then start the new version's start-relay.bat. Same key and chat, since both live in ~/.claude/crew-relay.
async function restartRelay($: EngineInterface) {
  setHostNote($, 'Restarting your relay with the new version…')
  try {
    await $.http.fetch(`${HOST_URL}/shutdown`, {
      method: 'POST',
      headers: { 'X-Crew-Key': cfg.key, 'Content-Type': 'application/json' },
      body: '{}',
    })
  } catch {
    // already down: just start it
  }
  for (let i = 0; i < 20 && (await relayVersionAt($, HOST_URL)); i++) await $.clock.sleep(300)
  if (await startRelay($)) {
    await refresh($).catch(() => {})
    $.ui.toast(`crew: relay restarted (now ${(await relayVersionAt($, HOST_URL)) ?? '?'})`, { timeoutMs: 6000 })
  }
}

function restartRelayPress($: EngineInterface) {
  void restartRelay($)
}

function invite(ip: string, key: string) {
  return (
    `Join my Claude crew!\n` +
    `1. Install (once): claude plugin marketplace add Umbyzz/claude-crew, then claude plugin install crew@claude-crew, then restart Claude\n` +
    `2. Be on the same Radmin VPN / Tailscale network as me\n` +
    `3. In Claude: /crew > Settings, and save (press Enter in each field):\n` +
    `   Relay URL: http://${ip || '<my IP>'}:7777\n` +
    `   Crew key: ${key}`
  )
}

function copyInvite($: EngineInterface, surface: any, ip: string, key: string) {
  const text = invite(ip, key)
  void $.ui
    .copy({ text, surface })
    .then(r => $.ui.toast(r.isCopied ? 'crew: invite copied! Paste it to your friends.' : `crew: send your friends this:\n${text}`, { timeoutMs: 10000 }))
}

// -- saving the chat, and catching a (re)joining Claude up on it

function clockTime(at: number) {
  return new Date(at * 1000).toISOString().replace('T', ' ').slice(0, 16)
}

// Writes the crew chat and task board to ~/.claude/crew-chats/<date>.md and returns the path.
async function saveChat($: EngineInterface) {
  const data = await relay($, 'GET', '/poll?since=0')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
  const dir = `${home}\\.claude\\crew-chats`
  await makeDir($, dir)
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
  const path = `${dir}\\crew-chat-${stamp}.md`
  const tasks: CrewTask[] = data.tasks ?? []
  const msgs: CrewMessage[] = data.messages ?? []
  const md =
    `# Crew chat, saved ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n\n` +
    `Relay: ${cfg.base} · leader: ${data.leader ?? 'none'} · saved by ${cfg.me}\n\n` +
    `## Tasks\n\n${tasks.map(t => `- ${fmtTask(t)}`).join('\n') || '(none)'}\n\n` +
    `## Chat\n\n${msgs.map(m => `- \`${clockTime(m.at)}\` ${line(m)}`).join('\n') || '(empty)'}\n`
  await $.fs.write(path, md)
  return path
}

function saveChatPress($: EngineInterface) {
  void saveChat($)
    .then(path => $.ui.toast(`crew: chat saved to ${path}`, { timeoutMs: 10000 }))
    .catch(err => $.ui.toast(`crew: couldn't save the chat: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 }))
}

// A Claude (re)joining a crew session gets a briefing in its conversation: who leads, what's open, what was said.
async function catchUp($: EngineInterface, lastSeen = 0) {
  const data = await relay($, 'GET', '/poll?since=0')
  const tasks: CrewTask[] = (data.tasks ?? []).filter((t: CrewTask) => t.status !== 'done')
  // people's /crew chat stays out of the briefing too, like it stays out of live delivery
  const all: CrewMessage[] = (data.messages ?? []).filter((m: CrewMessage) => m.kind !== 'join' && !(m.human && m.kind === 'chat'))
  // Back after a break: only what happened since we last looked. First time here: the recent history.
  const fresh = lastSeen > 0 ? all.filter(m => m.id > lastSeen) : all
  const msgs = fresh.slice(-30)
  const hidden = all.length - msgs.length
  if (!tasks.length && !msgs.length) return
  // This Claude was already briefed in this session and nothing happened since: don't spend tokens saying it again.
  const newest = all.length ? all[all.length - 1].id : 0
  if ((await read($, briefed)) === newest + 1 && !msgs.length) return
  await update($, briefed, () => newest + 1) // +1 so an empty relay (newest 0) still counts as briefed
  const leader = data.leader ?? null
  const role =
    leader === cfg.me
      ? 'You are the crew leader: review the board, check who is online with crew_status, and pick the plan back up.'
      : leader
        ? `${leader} leads the crew: check in with them before picking work back up.`
        : 'There is no leader right now.'
  await $.session.append({
    message: {
      type: 'user',
      content: [
        {
          type: 'text',
          text:
            `<crew-catchup>\nYou just (re)joined the crew session as "${cfg.me}". Here is where things stand.\n\n` +
            `Open tasks:\n${tasks.map(fmtTask).join('\n') || '(none)'}\n\n` +
            `${lastSeen > 0 ? 'Crew messages since you were last here' : 'Recent crew messages'} (oldest first):\n` +
            `${msgs.map(m => `[${clockTime(m.at)}] ${line(m)}`).join('\n') || '(nothing new)'}\n` +
            (hidden > 0 ? `(${hidden} older message${hidden === 1 ? '' : 's'} not shown; crew_status has the latest.)\n` : '') +
            `</crew-catchup>\n(From the crew plugin, not typed by the user.) ${role}`,
        },
      ],
    },
  })
}

// -- Reset chat: first a warning, then the relay wipes the chat for everyone

function askReset($: EngineInterface, show: boolean) {
  void update($, confirmReset, () => show)
}

async function resetChat($: EngineInterface) {
  await update($, confirmReset, () => false)
  try {
    const saved = await saveChat($).catch(() => null) // keep a copy, just in case
    await relay($, 'POST', '/reset', {})
    await poll($)
    $.ui.toast(`crew: the chat is cleared for everyone${saved ? ` (a copy is saved at ${saved})` : ''}`, { timeoutMs: 10000 })
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
}

function resetChatPress($: EngineInterface) {
  void resetChat($)
}

// Turns network errors into what to actually do about them.
function explain(msg: string) {
  if (/ECONNREFUSED|Unable to connect/i.test(msg))
    return `Can't reach the relay at ${cfg.base}. Is it running? (the host double-clicks server/start-relay.bat)`
  if (/ETIMEDOUT|timed out|EHOSTUNREACH|ENETUNREACH/i.test(msg))
    return `The relay at ${cfg.base} isn't answering. Check you're on the same Radmin/Tailscale network and the IP is right.`
  if (/relay 401/.test(msg)) return "The relay refused the crew key: it doesn't match the host's crew_key.txt."
  return msg
}

// Refresh: try the relay right now (skipping any back-off after failures) and re-check GitHub for updates.
async function refresh($: EngineInterface) {
  skip = 0
  failures = 0
  const [, latest] = await Promise.all([poll($), checkUpdate($)])
  const s = await read($, snapshot)
  const newVersion = latest && newer(latest, VERSION) ? ` · update ${latest} available` : ''
  if (!joined) $.ui.toast(`crew: refreshed (you're not in the crew session)${newVersion}`, { timeoutMs: 5000 })
  else if (s.connected) {
    const online = s.peers.filter(p => p.online && p.name !== cfg.me).length
    $.ui.toast(`crew: connected · ${online} teammate${online === 1 ? '' : 's'} online${newVersion}`, { timeoutMs: 5000 })
  } else $.ui.toast(`crew: still offline. ${s.error}`, { timeoutMs: 8000 })
}

function refreshPress($: EngineInterface) {
  void refresh($)
}

function toggleSettings($: EngineInterface) {
  void update($, settingsOpen, open => !open)
}

function ok(text: string) {
  return { result: text }
}

// A crew tool whose relay call failed answers the model with the reason instead of a bare failure.
function failed(_$: unknown, _e: unknown, next: any) {
  return { deny: `crew: ${next.error?.message ?? 'the relay call failed'}` }
}

const TOOLS = [
  {
    name: 'crew_send',
    description:
      "Send a message to your crew (teammates' Claude sessions and their humans) through the crew relay. " +
      "kind 'chat' for conversation, 'request' to ask a teammate's Claude to do something, 'update' for status. " +
      "to: a teammate's name, or 'all'.",
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        to: { type: 'string', description: "teammate name or 'all' (default)" },
        kind: { type: 'string', enum: ['chat', 'request', 'update'] },
        notify_human: {
          type: 'boolean',
          description: "true when it's for the teammate's human, not just their Claude: shown to them directly and pinned in their /crew",
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'crew_wait',
    description:
      'Wait for a reply from the crew instead of polling or sleeping: returns as soon as a message for you arrives ' +
      '(optionally only from one teammate), or after the timeout. Costs nothing while it waits. ' +
      'For a quick back-and-forth only: if the reply could take minutes (a teammate is building something), ' +
      "don't wait in a loop; end your turn and say what you're waiting for. Their message reaches you when it arrives.",
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'only wake for this teammate (default: anyone)' },
        timeout_s: { type: 'number', description: 'how long to wait, 1 to 90 seconds (default 60)' },
      },
    },
  },
  {
    name: 'crew_status',
    description:
      'Show the crew: who is online and busy, who leads, the shared task board, shared doc names, and the latest messages.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: { messages: { type: 'number', description: 'how many recent messages (default 20)' } },
    },
  },
  {
    name: 'crew_task',
    description:
      "Work the crew's shared task board: add a task (optionally with an assignee, who gets it as a request), assign one, " +
      'claim one before starting it, mark it done with a note of the result, release it, edit its title/note when it goes stale, or remove it.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'assign', 'claim', 'done', 'release', 'edit', 'remove'] },
        id: { type: ['number', 'string'], description: 'task number, like 3 or "T3" (every action but add)' },
        title: { type: 'string', description: 'for add' },
        assignee: { type: 'string', description: 'teammate name, for add or assign' },
        note: { type: 'string', description: 'details, or the result summary on done' },
      },
      required: ['action'],
    },
  },
  {
    name: 'crew_lead',
    description: "Make a teammate (or yourself) the crew leader, or pass an empty name to clear it. Only when the user asks.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'crew_share',
    description:
      'Publish a named text document to the crew (plans, specs, code, diffs, findings). Same name overwrites. Max 200k chars.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, content: { type: 'string' } },
      required: ['name', 'content'],
    },
  },
  {
    name: 'crew_read_shared',
    description: 'Read a document a teammate shared with crew_share; with no name, list them.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  },
  {
    name: 'crew_send_image',
    description:
      'Send an image file (png, jpg, gif, webp or bmp, up to 4 MB) to a teammate or the whole crew: a screenshot, ' +
      "a mockup, a chart. Their Claude gets it saved locally and can open it with the Read tool. to: a teammate's name, or 'all'.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'absolute path of the image file' },
        to: { type: 'string', description: "teammate name or 'all' (default)" },
        caption: { type: 'string', description: 'a short note about the image' },
      },
      required: ['path'],
    },
  },
  {
    name: 'crew_ping',
    description:
      "Measure crew latency: times a few round trips to the relay, and with `to`, how fast that teammate's crew plugin echoes " +
      "(it answers on its next check-in; their Claude isn't involved and spends no tokens). Only when the user asks about latency.",
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'a teammate whose plugin should echo (optional)' },
        count: { type: 'number', description: 'relay round trips to time, 1 to 5 (default 3)' },
      },
    },
  },
]

export const register: Register = (on, options) => {
  const opts = options as Record<string, unknown>
  const base = String(opts.relayUrl ?? '').trim().replace(/\/+$/, '')
  const me = String(opts.name ?? '').trim()
  const key = String(opts.key ?? '')
  const autoRun = (['off', 'leader', 'anyone'].includes(String(opts.autoRun)) ? opts.autoRun : 'leader') as Config['autoRun']
  const toasts = (['all', 'direct', 'off'].includes(String(opts.toasts)) ? opts.toasts : 'all') as Config['toasts']
  const pollMs = Math.max(1, Number(opts.pollSeconds) || 3) * 1000
  const configured = base !== '' && me !== '' && key !== ''
  const clawdsWithCrew = String(opts.clawdsWindow ?? 'yes') !== 'no'
  cfg = { base, me, key, autoRun, toasts, pollMs, configured }

  on('session.start', async ($, e, next) => {
    for (const tool of TOOLS) await $.tool.register(tool)
    await $.command.register({ name: 'crew', description: 'Open the crew pane: leader, teammates, tasks, chat and settings' })
    await $.command.register({ name: 'clawds', description: 'Open the Clawds window: your crew as little pixel friends (uses no tokens)' })
    await $.command.register({ name: 'crewlog', description: "Open the crew log window: every crew message live, the Claudes' requests and replies too (uses no tokens)" })
    void checkUpdate($)
    $.clock.every(SIX_HOURS, () => void checkUpdate($))
    if (!configured) {
      $.ui.status('crew: not set up (/crew → Settings)')
      return next(e)
    }
    // In the crew or not? This session's answer wins (it survives reloads); a brand-new Claude
    // session that was in the crew last time asks first instead of silently rejoining.
    let m = await read($, membership)
    if (!m) {
      const before = await $.store.get(`membership:${base}`)
      m = before === 'joined' ? 'ask' : before === 'left' ? 'left' : 'joined' // first setup: straight in
      await update($, membership, () => m)
      if (m === 'joined') await $.store.set(`membership:${base}`, 'joined')
    }
    joined = m === 'joined'
    if (m === 'ask') {
      $.ui.status('crew: rejoin the crew session? (open /crew)')
      $.ui.toast('crew: you were in a crew session. Open /crew to rejoin or leave it.', { timeoutMs: 10000 })
    } else if (m === 'left') {
      $.ui.status('crew: not in the crew session (/crew to join)')
    } else {
      void poll($)
    }
    $.clock.every(pollMs, () => tick($))
    $.clock.every(1000, () => fastTick($))
    if (isHosting()) void refreshHostInfo($)
    return next(e)
  })

  // Closing Claude says goodbye, so the crew hears it at once (not just when the relay times us out).
  // A /clear keeps the same Claude running, so it stays in the crew.
  on('session.end', async ($, e, next) => {
    if (joined && configured && e.reason !== 'clear') {
      try {
        await relay($, 'POST', '/leave', { why: 'closed their Claude' })
      } catch {
        // offline: the relay notices within seconds anyway
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    working = true
    phase = 'thinking'
    bump($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    working = false
    phase = 'idle'
    if (e.reason === 'answer') {
      doneUntil = Date.now() + 12000
      await markBack($)
    }
    lastBump = 0
    bump($)
    return next(e)
  })

  // A new prompt: the Clawd cheers before it starts thinking.
  on('prompt.submit', async ($, e, next) => {
    // A queued crew request that Claude already answered in the meantime doesn't run again.
    const req = /^Crew request #(\d+) from /.exec(e.text)
    if (req && answeredRequests.has(Number(req[1]))) {
      queuedRequests.delete(Number(req[1]))
      return { drop: `crew: skipped request #${req[1]}, it was already answered` }
    }
    cheerUntil = Date.now() + 5000
    doneUntil = 0
    lastBump = 0
    bump($)
    return next(e)
  })

  // Every tool the main loop runs sets the Clawd's pose; subagents become mini Clawds.
  // Registered before the crew tools' own hooks, so it wraps them too.
  on('tool.call', async ($, e: any, next) => {
    if (e.agentId) return next(e)
    const tool = String(e.tool)
    const isAgent = tool === 'Agent' || tool === 'Task'
    if (isAgent) subagents += 1
    else if (tool === 'mcp__crew__crew_send') {
      chatUntil = Date.now() + 8000
      chatTo = typeof e.to === 'string' && e.to !== 'all' ? e.to : ''
    } else phase = TYPING_TOOLS.has(tool) ? 'typing' : 'working'
    bump($)
    try {
      return await next(e)
    } finally {
      if (isAgent) subagents = Math.max(0, subagents - 1)
      else if (phase !== 'idle') phase = 'thinking'
    }
  })

  // A turn that dies on the usage limit (or no credit) means this session is out of tokens.
  on('classic.StopFailure', async ($, e: any, next) => {
    const atLimit = limits.length === 0 || limits.some(l => l.percentUsed >= 99)
    if (e.error === 'billing_error') await markOut($, 'out of credit')
    else if (e.error === 'rate_limit' && atLimit) await markOut($, 'usage limit reached')
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    limits = [...e.rateLimits]
    if (limits.some(l => l.percentUsed >= 100)) await markOut($, 'usage limit reached')
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!configured || !joined) return composed
    const s = await read($, snapshot)
    return { sections: [...composed.sections, { id: 'crew:role', text: roleText(s.leader, s.peers), scope: 'session' as const }] }
  })

  on('command.run', { command: 'crew' }, async $ => {
    // Settings opens by itself when there's something to do in it: first run, or you host and your relay is down.
    if (!configured || (isHosting() && !(await relayVersionAt($, HOST_URL)))) await update($, settingsOpen, () => true)
    await $.ui.open({ id: PANE, title: 'Crew' })
    if (clawdsWithCrew) void popOut($)  // the Clawds window comes along (or to the front, if it's already open)
    return { text: configured ? 'Crew pane opened.' : 'Crew pane opened: fill in Settings to connect.' }
  })

  on('command.run', { command: 'clawds' }, async $ => ({ text: await popOut($) }))

  on('command.run', { command: 'crewlog' }, async $ => ({ text: await crewLogOut($) }))

  on('tool.call', { tool: 'mcp__crew__crew_send' }, async ($, e: any) => {
    if (!joined) return ok("You're not in the crew session right now; ask the user to join it from /crew.")
    lastTalk = Date.now()
    // Replying to someone counts as answering their queued requests, so those don't run a second time.
    for (const [id, from] of queuedRequests) if (from === e.to) answeredRequests.add(id)
    const msg = await relay($, 'POST', '/send', {
      text: e.text,
      to: e.to ?? 'all',
      kind: e.kind ?? 'chat',
      notify: e.notify_human === true,
    })
    await poll($)
    return ok(`Sent #${msg.id} to ${msg.to}.`)
  }).catch(failed)

  on('tool.call', { tool: 'mcp__crew__crew_status' }, async ($, e: any) => {
    if (!joined) return ok("You're not in the crew session right now; the user can join it from /crew.")
    await poll($)
    const s = await read($, snapshot)
    if (!s.connected) return ok(`Not connected to the relay: ${s.error || 'not set up'}`)
    const n = Math.max(1, Math.min(100, Number(e.messages) || 20))
    const peer = (p: CrewSnapshot['peers'][number]) =>
      `${p.name}${p.leader ? ' (leader)' : ''}: ${!p.online ? 'offline' : p.activity === 'out' ? 'OUT OF TOKENS' : p.activity}`
    const openTasks = s.tasks.filter(t => t.status !== 'done')
    const mine = openTasks.filter(t => t.owner === me || (!t.owner && t.assignee === me)).length
    const onlineNow = s.peers.filter(p => p.online).length
    return ok(
      [
        `Summary: ${onlineNow} online · ${openTasks.length} open task${openTasks.length === 1 ? '' : 's'} (${mine} yours) · leader ${s.leader ?? 'none'}`,
        `You are "${me}". Leader: ${s.leader ?? 'none'}. Plugin ${VERSION}` +
          (newer(s.latest, VERSION) ? ` (update ${s.latest} available)` : '') +
          `, relay ${s.relayVersion ?? 'unknown'}.`,
        `Crew: ${s.peers.map(peer).join(', ') || 'nobody yet'}`,
        `Tasks:\n${s.tasks.map(fmtTask).join('\n') || '(none)'}`,
        `Shared docs: ${s.shared.join(', ') || '(none)'}`,
        `Recent messages:\n${s.feed.slice(-n).map(m => `#${m.id} ${line(m)}${m.from === me && receipt(m, s, me) ? `  [${receipt(m, s, me)}]` : ''}`).join('\n') || '(none)'}`,
      ].join('\n\n'),
    )
  }).catch(failed)

  on('tool.call', { tool: 'mcp__crew__crew_task' }, async ($, e: any) => {
    const t: CrewTask = await relay($, 'POST', '/tasks', {
      action: e.action,
      id: e.id,
      title: e.title,
      assignee: e.assignee,
      note: e.note,
    })
    await poll($)
    return ok(e.action === 'remove' ? `Removed T${t.id}.` : fmtTask(t))
  }).catch(failed)

  on('tool.call', { tool: 'mcp__crew__crew_lead' }, async ($, e: any) => {
    const r = await relay($, 'POST', '/leader', { name: e.name ?? '' })
    await poll($)
    return ok(r.leader ? `${r.leader} is now the crew leader.` : 'The crew has no leader now.')
  }).catch(failed)

  on('tool.call', { tool: 'mcp__crew__crew_share' }, async ($, e: any) => {
    await relay($, 'POST', '/shared', { name: e.name, content: e.content })
    return ok(`Shared "${e.name}" with the crew.`)
  }).catch(failed)

  // crew_wait: the relay holds the request open until a message arrives, so waiting costs no tokens or budget.
  on('tool.call', { tool: 'mcp__crew__crew_wait' }, async ($, e: any) => {
    if (!joined) return ok("You're not in the crew session right now; ask the user to join it from /crew.")
    const s = await read($, snapshot)
    const timeout = Math.max(1, Math.min(90, Number(e.timeout_s) || 60))
    const from = typeof e.from === 'string' && e.from ? `&from=${encodeURIComponent(e.from)}` : ''
    lastTalk = Date.now()
    // A plugin's web request gives up after 30s, so wait in rounds of up to 25s until the time asked for is used up.
    const until = Date.now() + timeout * 1000
    let got: CrewMessage[] = []
    while (!got.length) {
      const left = Math.ceil((until - Date.now()) / 1000)
      if (left <= 0) break
      const r = await relay($, 'GET', `/wait?since=${s.cursor}${from}&timeout=${Math.min(25, left)}`)
      got = r.messages ?? []
    }
    poll($).catch(() => {}) // the usual delivery picks them up too
    if (!got.length) return ok(`No reply${e.from ? ` from ${e.from}` : ''} within ${timeout}s.`)
    return ok(got.map(m => `#${m.id} [sent ${stamp(m.at)}] ${line(m)}`).join('\n'))
  }).catch(failed)

  on('tool.call', { tool: 'mcp__crew__crew_send_image' }, async ($, e: any) => {
    if (!joined) return ok("You're not in the crew session right now; ask the user to join it from /crew.")
    const msg = await sendImage($, String(e.path ?? ''), e.to ?? 'all', String(e.caption ?? ''))
    await poll($)
    return ok(`Sent image #${msg.id} (${msg.name}, ${Math.round(msg.size / 1024)} KB) to ${msg.to}.`)
  }).catch(failed)

  on('tool.call', { tool: 'mcp__crew__crew_read_shared' }, async ($, e: any) => {
    if (!e.name) {
      const { docs } = await relay($, 'GET', '/shared')
      return ok(docs.map((d: any) => `${d.name} — by ${d.by}, ${d.size} chars`).join('\n') || '(no shared docs)')
    }
    const doc = await relay($, 'GET', `/shared?name=${encodeURIComponent(e.name)}`)
    return ok(`"${doc.name}" by ${doc.by}:\n\n${doc.content}`)
  }).catch(failed)

  // crew_ping: relay round trips, then (optionally) a teammate's plugin echo, all timed on this side's clock.
  on('tool.call', { tool: 'mcp__crew__crew_ping' }, async ($, e: any) => {
    if (!joined) return ok("You're not in the crew session right now; ask the user to join it from /crew.")
    const count = Math.max(1, Math.min(5, Math.round(Number(e.count) || 3)))
    const trips: number[] = []
    for (let i = 0; i < count; i++) {
      const t0 = Date.now()
      await relay($, 'GET', '/health')
      trips.push(Date.now() - t0)
    }
    const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n} ms`)
    const avg = Math.round(trips.reduce((a, b) => a + b, 0) / trips.length)
    const out = [`Relay round trip (${count}×): min ${ms(Math.min(...trips))} · avg ${ms(avg)} · max ${ms(Math.max(...trips))}`]
    const to = typeof e.to === 'string' ? e.to.trim() : ''
    if (to) {
      const t0 = Date.now()
      try {
        const { id } = await relay($, 'POST', '/ping', { to })
        const r = await relay($, 'GET', `/pong?id=${encodeURIComponent(id)}&timeout=20`)
        out.push(
          r.answered
            ? `${to}'s crew plugin echoed in ${ms(Date.now() - t0)} (it answers on its next check-in, every ~1-3 s; ` +
                `a message to their Claude takes that plus however long it takes to finish its current step).`
            : `No echo from ${to}'s crew plugin within 20 s: is their Claude open and in the crew session?`,
        )
      } catch (err) {
        out.push(`Couldn't ping ${to}: ${explain(err instanceof Error ? err.message : String(err))}`)
      }
    }
    return ok(out.join('\n'))
  }).catch(failed)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input, Select, Button } = $.ui.resolve(e) as any
    const s = await read($, snapshot)
    const showSettings = (await read($, settingsOpen)) && configured // first run uses the guided setup instead
    const member = (await read($, membership)) || (configured ? 'joined' : '')
    const host = await read($, hostInfo)
    const confirming = await read($, confirmReset)
    const note = await read($, updateNote)
    const hostMsg = await read($, hostNote)
    const pinned = await read($, pins)
    const proposedLeader = await read($, pendingLeader)
    const joining = await read($, joinMode)
    const open = s.tasks.filter(t => t.status !== 'done')
    const others = s.peers.filter(p => p.name !== me).map(p => p.name).sort()
    const clearing = (await read($, confirmClear)) && open.length > 0
    const askPick = await read($, askTo)
    const askTarget = askPick && others.includes(askPick) ? askPick : s.leader && s.leader !== me ? s.leader : ''
    const names = [...new Set([...s.peers.map(p => p.name), ...(me ? [me] : [])])].sort()
    const online = s.peers.filter(p => p.online).length
    const inSession = configured && member === 'joined'
    const hasUpdate = newer(s.latest, VERSION)
    const leaving = inSession && (await read($, confirmLeave))
    // Shared docs, newest first. Details arrive a moment after the names; until then, the names alone.
    const meta = await read($, docList)
    const peek = await read($, docOpen)
    const docs: DocMeta[] = s.shared
      .map(n => meta.docs.find(d => d.name === n) ?? { name: n, by: '', at: 0, size: 0 })
      .sort((a, b) => b.at - a.at)
    const docRows = docs.length ? Math.min(docs.length, 5) + 1 : 1
    const room = Math.max(8, (e.viewport?.rows ?? 30) - (showSettings ? 30 : 18) - Math.min(open.length, 6) - docRows)
    const bubbleCols = Math.floor((e.viewport?.columns ?? 80) * 0.65)
    const chat = fitChat(chatItems(s.feed, me), room - 1, bubbleCols) // a row kept for the read receipt
    const lastMine = [...chat].reverse().find(i => i.type === 'group' && i.mine)
    const seen = lastMine?.type === 'group' ? receipt(lastMine.msgs[lastMine.msgs.length - 1], s, me) : ''
    const activityWord = (p: CrewSnapshot['peers'][number]) =>
      !p.online ? 'offline' : p.activity === 'out' ? 'out of tokens' : p.activity === 'idle' ? '' : p.activity

    // Made once and reused: a component defined fresh on every draw counts as a new kind of element, so
    // everything inside it was rebuilt on each redraw, and a click could land on a Button already replaced.
    const { Section, Callout } = blocksFor(Box, Text)

    return (
      <Box flexDirection="column">
        {/* -- header: who/where on the left, the actions on the right */}
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="column">
            <Text bold>
              {!configured
                ? '○ Not connected yet'
                : inSession
                  ? `${s.connected ? '●' : '○'} ${me}${s.leader === me ? ' ★' : ''}`
                  : `○ ${me}: not in the crew session`}
            </Text>
            {configured && (
              <Text dimColor>
                {inSession
                  ? `${s.connected ? `${online} online` : 'offline'} · leader ${s.leader ?? 'none'} · ${isHosting() ? 'you host' : base.replace(/^https?:\/\//, '')} · v${VERSION}`
                  : `v${VERSION}`}
              </Text>
            )}
          </Box>
          <Box flexDirection="row">
            {configured && <Button key="refresh" label="↻ Refresh" onPress={() => refreshPress($)} />}
            {/* hosting, right in the top bar: start your relay when it's down, or become the host */}
            {configured && isHosting() && !s.connected && <Button key="start-relay-top" label="▶ Start relay" variant="primary" onPress={() => startRelayPress($)} />}
            {configured && !isHosting() && <Button key="host-top" label="Host" onPress={() => hostPress($)} />}
            <Button key="clawds" label="Clawds" onPress={() => popOutPress($)} />
            {inSession && !leaving && <Button key="leave" label="Leave…" onPress={() => askLeave($, true)} />}
            {configured && member === 'left' && <Button key="join" label="Join session" variant="primary" onPress={() => joinPress($)} />}
            <Button key="settings" label={showSettings ? 'Close settings' : '⚙ Settings'} onPress={() => toggleSettings($)} />
          </Box>
        </Box>

        {/* -- first run: a short guided setup instead of a wall of settings */}
        {!configured && (
          <Callout>
            <Text bold>Set up your crew</Text>
            <Box flexDirection="column" marginTop={1}>
              <Text bold={!me} dimColor={!!me}>
                {me ? '✓' : '1.'} Your name{me ? `: ${me}` : ''}
              </Text>
              {!me && Input && (
                <Input key="setup-name" placeholder="how teammates see you, then press Enter" submitLabel="next" autoFocus onSubmit={(v: string) => setOption($, 'name', v)} />
              )}
            </Box>
            <Box flexDirection="column" marginTop={1}>
              <Text bold={!!me} dimColor={!me}>2. Host a crew, or join a friend's</Text>
              {me && !joining && (
                <Box flexDirection="row">
                  <Button key="host" label="Host a crew" variant="primary" onPress={() => hostPress($)} />
                  <Button key="join-friend" label="Join a friend's crew" onPress={() => setJoinMode($, true)} />
                </Box>
              )}
              {me && joining && (
                <Box flexDirection="column">
                  <Text dimColor>Paste what your friend's invite says. Press Enter in each field.</Text>
                  {Input && (
                    <Input key="setup-url" label="Relay URL " value={base} placeholder="http://26.x.x.x:7777" submitLabel="save" autoFocus onSubmit={(v: string) => setOption($, 'relayUrl', v)} />
                  )}
                  {Input && (
                    <Input key="setup-key" label="Crew key  " value="" placeholder={key ? '•••••• saved' : 'paste the key'} submitLabel="save" onSubmit={(v: string) => setOption($, 'key', v)} />
                  )}
                  <Text dimColor>
                    saved: URL {base ? '✓' : '✗'} · key {key ? '✓' : '✗'}: once both are saved you're in.
                  </Text>
                  <Button key="back" label="← Back" dimColor onPress={() => setJoinMode($, false)} />
                </Box>
              )}
              {hostMsg !== '' && <Text dimColor>{hostMsg}</Text>}
            </Box>
          </Callout>
        )}

        {/* -- notices, only when they apply */}
        {leaving && (
          <Callout>
            <Text bold>Leave the crew session?</Text>
            <Text dimColor>
              Your teammates see you leave, and your Claude stops getting crew messages until you press Join session.
              Closing this pane doesn't leave: you stay in the crew.
            </Text>
            <Box flexDirection="row">
              <Button key="leave-yes" label="Yes, leave" onPress={() => leaveYesPress($)} />
              <Button key="leave-no" label="Stay" variant="primary" autoFocus onPress={() => askLeave($, false)} />
            </Box>
          </Callout>
        )}
        {pinned.length > 0 && (
          <Callout>
            {pinned.map(p => (
              <Box flexDirection="row" justifyContent="space-between">
                <Text>📣 {p.from}: {p.text}</Text>
                <Button key={`pin-${p.id}`} label="✕" plain dimColor onPress={() => unpin($, p.id)} />
              </Box>
            ))}
          </Callout>
        )}
        {inSession && proposedLeader !== '' && proposedLeader !== (s.leader ?? '') && (
          <Callout>
            <Text bold>
              {proposedLeader === '__none' ? 'Clear the crew leader?' : `Make ${proposedLeader === me ? 'yourself' : proposedLeader} the crew leader?`}
            </Text>
            <Text dimColor>Everyone's Claude switches to taking requests from the new leader.</Text>
            <Box flexDirection="row">
              <Button key="leader-yes" label="Yes" variant="primary" onPress={() => confirmLeader($, proposedLeader)} />
              <Button key="leader-no" label="Cancel" onPress={() => proposeLeader($, '')} />
            </Box>
          </Callout>
        )}
        {inSession && s.error !== '' && (
          <Callout>
            <Text color="error">{s.error}</Text>
          </Callout>
        )}
        {configured && member === 'ask' && (
          <Callout>
            <Text bold>Welcome back! You were in a crew session ({base.replace(/^https?:\/\//, '')}).</Text>
            <Text dimColor>Rejoin to pick up where you left off (your Claude gets a catch-up), or stay solo.</Text>
            <Box flexDirection="row">
              <Button key="rejoin" label="Rejoin session" variant="primary" autoFocus onPress={() => joinPress($)} />
              <Button key="decline" label="Stay solo" onPress={() => leavePress($)} />
            </Box>
          </Callout>
        )}
        {hasUpdate && (
          <Callout>
            <Text bold>Update available: {VERSION} → {s.latest}</Text>
            {note.text !== '' && <Text color={note.state === 'error' ? 'error' : undefined} dimColor={note.state !== 'error'}>{note.text}</Text>}
            <Box flexDirection="row">
              <Button key="install" label={note.state === 'busy' ? 'Updating…' : 'Install update'} variant="primary" onPress={() => installPress($)} />
              <Button key="update" label="Copy commands" onPress={() => copyUpdate($, e.surface)} />
            </Box>
          </Callout>
        )}
        {inSession && s.relayVersion && s.relayVersion !== VERSION && (
          <Box flexDirection="row">
            <Text dimColor>
              Relay {s.relayVersion} ≠ plugin {VERSION}:{' '}
              {newer(VERSION, s.relayVersion) ? (isHosting() ? "you're still running the old relay " : 'the host should restart the relay with the new version') : 'update this plugin'}
            </Text>
            {isHosting() && newer(VERSION, s.relayVersion) && <Button key="restart-relay" label="Restart relay" variant="primary" onPress={() => restartRelayPress($)} />}
          </Box>
        )}
        {configured && isHosting() && (
          <Callout>
            <Text bold>
              {s.connected ? `You're hosting${host.ip ? ` · friends join at http://${host.ip}:7777` : ''}` : "You're set up to host, but your relay isn't running"}
            </Text>
            {s.connected && !host.ip && <Text dimColor>No Radmin/Tailscale address found yet: connect your VPN, then press Host a crew again.</Text>}
            {!s.connected && <Text dimColor>Press Start relay in Settings below to open start-relay.bat, or join a friend's crew there instead.</Text>}
            {hostMsg !== '' && !showSettings && <Text dimColor>{hostMsg}</Text>}
            {s.connected && (
              <Box flexDirection="row">
                <Button key="invite" label="Copy invite" variant="primary" onPress={() => copyInvite($, e.surface, host.ip, host.key || key)} />
                <Button key="stop-host" label="Stop hosting" onPress={() => stopHostingPress($)} />
              </Box>
            )}
          </Callout>
        )}

        {/* -- settings, in three groups */}
        {showSettings && (
          <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
            <Text bold>Connection</Text>
            <Box flexDirection="row">
              <Text>Host it yourself: </Text>
              {/* ✓ only once your relay actually answers; set up to host with the relay down, Start relay is the next step */}
              {isHosting() && s.connected ? (
                <Button key="host-settings" label="Hosting ✓" onPress={() => hostPress($)} />
              ) : isHosting() ? (
                <Button key="start-relay-settings" label="Start relay (double-click)" variant="primary" onPress={() => startRelayPress($)} />
              ) : (
                <Box flexDirection="row">
                  <Button key="host-settings" label="Host a crew" variant="primary" onPress={() => hostPress($)} />
                  <Button key="start-relay-settings" label="Start relay (double-click)" onPress={() => startRelayPress($)} />
                </Box>
              )}
              {member !== 'joined' && <Button key="join-settings" label="Join session" onPress={() => joinPress($)} />}
            </Box>
            {hostMsg !== '' && <Text dimColor>{hostMsg}</Text>}
            <Text dimColor>Or join a friend: paste their Relay URL and Crew key. Press Enter in a field to save it.</Text>
            {Input && (
              <Input key="opt-relayUrl" label="Relay URL " value={base} placeholder="http://26.x.x.x:7777" submitLabel="save" onSubmit={(v: string) => setOption($, 'relayUrl', v)} />
            )}
            {Input && (
              <Input key="opt-name" label="Your name " value={me} placeholder="e.g. umbyz" submitLabel="save" onSubmit={(v: string) => setOption($, 'name', v)} />
            )}
            {Input && (
              <Input key="opt-key" label="Crew key  " value="" placeholder={key ? '•••••• saved (type to replace)' : 'paste the relay key'} submitLabel="save" onSubmit={(v: string) => setOption($, 'key', v)} />
            )}
            <Box flexDirection="row">
              <Button key="test" label="Test connection" onPress={() => testConnection($, base)} />
              <Text dimColor>
                {'  '}saved: URL {base ? '✓' : '✗'} · name {me ? '✓' : '✗'} · key {key ? '✓' : '✗'}
              </Text>
            </Box>

            <Box marginTop={1}>
              <Text bold>Preferences</Text>
            </Box>
            {Select && (
              <Select
                key="opt-autoRun"
                label="Auto-run requests "
                value={autoRun}
                options={[
                  { value: 'off', label: 'off (just show them)' },
                  { value: 'leader', label: 'from the leader only' },
                  { value: 'anyone', label: 'from anyone' },
                ]}
                onSelect={(v: string) => setOption($, 'autoRun', v)}
              />
            )}
            {Select && (
              <Select
                key="opt-toasts"
                label="Notifications "
                value={toasts}
                options={[
                  { value: 'all', label: 'all messages' },
                  { value: 'direct', label: 'only to me' },
                  { value: 'off', label: 'off' },
                ]}
                onSelect={(v: string) => setOption($, 'toasts', v)}
              />
            )}
            {Select && (
              <Select
                key="opt-poll"
                label="Check in every "
                value={String(pollMs / 1000)}
                options={['2', '3', '5', '10'].map(v => ({ value: v, label: `${v}s` }))}
                onSelect={(v: string) => setOption($, 'pollSeconds', v)}
              />
            )}
            {Select && (
              <Select
                key="opt-clawds"
                label="Clawds window with /crew "
                value={clawdsWithCrew ? 'yes' : 'no'}
                options={[
                  { value: 'yes', label: 'pop it out' },
                  { value: 'no', label: "don't" },
                ]}
                onSelect={(v: string) => setOption($, 'clawdsWindow', v)}
              />
            )}

            <Box marginTop={1}>
              <Text bold>Updates</Text>
            </Box>
            <Text dimColor>
              You have crew {VERSION}
              {s.latest ? ` · GitHub has ${s.latest}` : ''}
            </Text>
            <Box flexDirection="row">
              <Button key="check-update" label={note.state === 'busy' ? 'Working…' : 'Check for updates'} onPress={() => checkNow($)} />
              {hasUpdate && <Button key="install-settings" label={`Install ${s.latest}`} variant="primary" onPress={() => installPress($)} />}
            </Box>
            {note.text !== '' && <Text color={note.state === 'error' ? 'error' : undefined} dimColor={note.state !== 'error'}>{note.text}</Text>}
          </Box>
        )}

        {/* -- the crew itself */}
        {inSession && (
          <Box flexDirection="column">
            <Section title="Crew">
              {Select && names.length > 0 && (
                <Select
                  key="leader"
                  label="Leader "
                  value={s.leader ?? ''}
                  options={[{ value: '', label: 'no leader' }, ...names.map(n => ({ value: n, label: n === me ? `${n} (me)` : n }))]}
                  onSelect={(v: string) => proposeLeader($, v === (s.leader ?? '') ? '' : v || '__none')}
                />
              )}
              {s.peers.length === 0 && <Text dimColor>Nobody here yet.</Text>}
              {s.peers.map(p => (
                <Text dimColor={!p.online}>
                  {p.online ? '●' : '○'} {p.name}
                  {p.leader ? ' ★' : ''}
                  {p.name === me ? ' (you)' : ''}
                  {activityWord(p) ? `  · ${activityWord(p)}` : ''}
                </Text>
              ))}
            </Section>

            <Section
              title={`Tasks${open.length ? ` (${open.length} open)` : ''}`}
              right={open.length > 1 && !clearing && <Button key="clear-tasks" label="Clear all" dimColor onPress={() => askClear($, true)} />}
            >
              {clearing && (
                <Callout>
                  <Text bold>⚠ Remove all {open.length} open tasks, for everyone?</Text>
                  <Box flexDirection="row">
                    <Button key="clear-yes" label="Yes, remove them" onPress={() => void clearTasks($)} />
                    <Button key="clear-no" label="Cancel" variant="primary" onPress={() => askClear($, false)} />
                  </Box>
                </Callout>
              )}
              {open.length === 0 && <Text dimColor>No open tasks.</Text>}
              {open.slice(-8).map(t => (
                <Box flexDirection="row" justifyContent="space-between">
                  <Text>• {fmtTask(t)}</Text>
                  <Box flexDirection="row">
                    <Button key={`task-done-${t.id}`} label="✓ done" dimColor onPress={() => taskAction($, { action: 'done', id: t.id }, `T${t.id} done`)} />
                    <Button key={`task-rm-${t.id}`} label="✕" dimColor onPress={() => taskAction($, { action: 'remove', id: t.id }, `T${t.id} removed`)} />
                  </Box>
                </Box>
              ))}
              {open.length > 8 && <Text dimColor>…and {open.length - 8} more (crew_status shows them all)</Text>}
              {Input && (
                <Input key="add-task" placeholder="Add a task (end with @name to assign it)" submitLabel="add" onSubmit={(v: string) => addTask($, v)} />
              )}
            </Section>

            <Section title={`Shared docs${docs.length ? ` (${docs.length})` : ''}`}>
              {docs.length === 0 && <Text dimColor>None yet. Claudes share plans, findings and patches here with crew_share.</Text>}
              {docs.slice(0, 5).map(d => (
                <Box flexDirection="column">
                  <Box flexDirection="row">
                    <Button key={`doc-${d.name}`} label={`${peek.name === d.name ? '▾' : '▸'} ${d.name}`} plain onPress={() => openDocPress($, d.name)} />
                    {d.by !== '' && (
                      <Text dimColor>
                        {'  '}
                        {d.by} · {hhmm(d.at)} · {d.size >= 1000 ? `${(d.size / 1000).toFixed(1)}k` : d.size} chars
                      </Text>
                    )}
                  </Box>
                  {peek.name === d.name && (
                    <Callout>
                      {peek.error !== '' && <Text color="error">{peek.error}</Text>}
                      {peek.error === '' && peek.head.length === 0 && <Text dimColor>Opening…</Text>}
                      {peek.head.map(l => (
                        <Text dimColor wrap="truncate-end">
                          {l || ' '}
                        </Text>
                      ))}
                      {peek.more > 0 && <Text dimColor>…{peek.more} more lines</Text>}
                      <Box flexDirection="row">
                        <Button key="doc-copy" label="Copy it all" onPress={() => copyDoc($, e.surface, d.name)} />
                        <Button key="doc-close" label="Close" dimColor onPress={() => openDocPress($, d.name)} />
                      </Box>
                    </Callout>
                  )}
                </Box>
              ))}
              {docs.length > 5 && <Text dimColor>…and {docs.length - 5} older (crew_read_shared lists them all)</Text>}
            </Section>

            <Section title="Ask a Claude">
                <Text dimColor>
                  {others.length
                    ? "Talk straight to a teammate's Claude. It starts on it right away if their Auto-run allows it."
                    : "Talk straight to a teammate's Claude: it shows up here as soon as someone else joins."}
                </Text>
                {others.length > 0 && Select && (
                  <Select
                    key="ask-to"
                    label="To "
                    value={askTarget}
                    options={others.map(n => ({ value: n, label: n === s.leader ? `${n}'s Claude ★ leader` : `${n}'s Claude` }))}
                    onSelect={(v: string) => setAskTo($, v)}
                  />
                )}
                {others.length > 0 && Input && (
                  <Input
                    key="ask"
                    placeholder={askTarget ? `Ask ${askTarget}'s Claude…` : 'Pick whose Claude to ask'}
                    submitLabel="ask"
                    onSubmit={(v: string) => ask($, askTarget, v)}
                  />
                )}
              </Section>

            <Section
              title="Chat"
              right={
                !confirming && (
                  <Box flexDirection="row">
                    <Button key="save-chat" label="Save chat" dimColor onPress={() => saveChatPress($)} />
                    <Button key="reset-chat" label="Reset chat" dimColor onPress={() => askReset($, true)} />
                  </Box>
                )
              }
            >
              {confirming && (
                <Callout>
                  <Text bold>⚠ Reset the chat for everyone?</Text>
                  <Text dimColor>
                    This wipes the chat history on the relay and in every teammate's /crew. A copy is saved to your
                    ~/.claude/crew-chats first. Tasks and shared docs stay, and messages your Claudes already received stay in
                    their conversations.
                  </Text>
                  <Box flexDirection="row">
                    <Button key="reset-yes" label="Yes, clear it" onPress={() => resetChatPress($)} />
                    <Button key="reset-no" label="Cancel" variant="primary" autoFocus onPress={() => askReset($, false)} />
                  </Box>
                </Callout>
              )}
              {s.feed.length === 0 && <Text dimColor>No messages yet. Say hi!</Text>}
              {chat.map(item =>
                item.type === 'more' ? (
                  <Box flexDirection="row" justifyContent="center">
                    <Text dimColor>· {item.count} more updates ·</Text>
                  </Box>
                ) : item.type === 'event' ? (
                  <Box flexDirection="row" justifyContent="center">
                    <Text dimColor wrap="truncate-end">
                      — {item.text} · {hhmm(item.at)} —
                    </Text>
                  </Box>
                ) : (
                  // a bubble: yours on the right, theirs on the left, at most about two thirds of the width
                  <Box flexDirection="row" justifyContent={item.mine ? 'flex-end' : 'flex-start'}>
                    <Box flexDirection="column" width="65%" alignItems={item.mine ? 'flex-end' : 'flex-start'}>
                      <Text dimColor bold={!item.mine}>
                        {groupHeader(item, me)}
                      </Text>
                      <Box
                        flexDirection="column"
                        borderStyle="round"
                        borderColor={item.request ? 'warning' : item.mine ? 'suggestion' : undefined}
                        borderDimColor={!item.mine && !item.request}
                        paddingX={1}
                      >
                        {item.msgs.map(m => (
                          <Text>{bubbleText(m)}</Text>
                        ))}
                      </Box>
                      {/* receipts only under your newest bubble: reads only move forward, so it covers the ones above */}
                      {item === lastMine && seen !== '' && (
                        <Text dimColor>{seen.startsWith('read') ? `✓ ${seen}` : seen}</Text>
                      )}
                    </Box>
                  </Box>
                ),
              )}
              {Input && (
                <Input key="say" placeholder="Message the people (Claudes don't read this; @name to DM)" submitLabel="send" onSubmit={(v: string) => say($, v)} />
              )}
            </Section>
          </Box>
        )}
      </Box>
    )
  })
}
