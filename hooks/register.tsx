import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CrewMessage, CrewSnapshot, CrewTask } from '../types'

const PANE = 'crew'
// Kept in step with plugin.json and server/relay.py by scripts/release.ps1.
const VERSION = '1.16.2'
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
// Which crew project this Claude Code session works in: its own chat, tasks, docs and leader on the relay.
// Kept per session (so each conversation stays in its project across reloads), and remembered per folder.
const projectAtom = atom({ plugin: 'crew', key: 'project' } as const, '')
let projectName = 'main'
let sessionCwd = ''
const askTo = atom({ plugin: 'crew', key: 'askTo' } as const, '') // the chat's "To:": '' = the people, a name = that teammate's Claude
// /crew's tabs: one card at a time instead of everything stacked. Settings is the ⚙ tab (settingsOpen).
type Tab = 'chat' | 'tasks' | 'docs' | 'crew'
const tab = atom({ plugin: 'crew', key: 'tab' } as const, 'chat' as Tab)
// The Chat tab's views: 'all' is every crew message, 'people' only what humans typed, 'claudes' only the Claudes' talk.
type ChatView = 'all' | 'people' | 'claudes'
const chatView = atom({ plugin: 'crew', key: 'chatView' } as const, 'all' as ChatView)
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
let modelName = '' // this session's model, as /model shows it: the leader's Claude splits work by the crew's models
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

// The crew key this plugin last knew to work, per relay, in its own store. Saving a setting can be refused (or land
// where the next load doesn't read it), and a key that then quietly reverts locks you out: a new crew key, or a
// friend's personal key, must survive restarts whatever happens to the settings write.
let keyLoadedFor = ''

async function storedKey($: EngineInterface) {
  if (keyLoadedFor === cfg.base) return
  keyLoadedFor = cfg.base
  const k = await $.store.get(`keyFor:${cfg.base}`).catch(() => undefined)
  if (typeof k === 'string' && k) cfg.key = k
}

async function rememberKey($: EngineInterface, key: string) {
  cfg.key = key
  keyLoadedFor = cfg.base
  await $.store.set(`keyFor:${cfg.base}`, key).catch(() => {})
  const r = await $.config.set({ key: 'crew.key', value: key }).catch(err => ({ deny: String(err) }))
  return r && 'deny' in r && r.deny ? String(r.deny) : ''
}

// The host's own relay refused the key: the right one is in crew_key.txt on this very PC, so take it from there.
async function healHostKey($: EngineInterface) {
  if (!isHosting()) return false
  const r = await ran($, ['powershell', '-NoProfile', '-Command', `Get-Content -Raw -LiteralPath ${psPath(`${await crewDir($)}\\crew_key.txt`)}`], 15000)
  const fileKey = r.ok ? r.out.trim() : ''
  if (!fileKey || fileKey === cfg.key) return false
  await rememberKey($, fileKey)
  $.ui.toast("crew: your relay's key had changed; picked up the right one from crew_key.txt.", { timeoutMs: 8000 })
  return true
}

async function relay($: EngineInterface, method: 'GET' | 'POST', path: string, body?: unknown) {
  if (!cfg.configured) throw new Error('crew is not set up: open /crew and fill in Settings')
  await syncProject($)
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
      'X-Crew-Model': modelName,
      'X-Crew-Usage': usageNow(),
      'X-Crew-Usage-Detail': usageDetail(),
      'X-Crew-Mcp': [...mcpServers].slice(0, 8).map(mcpLabel).join(', '),
      'X-Crew-Project': projectName,
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

// A reload of the plugin starts fresh in memory, but the session's project is kept in its state.
async function syncProject($: EngineInterface) {
  projectName = (await read($, projectAtom)) || projectName
}

// Where this session read up to, per project (main keeps its old key, so nothing is replayed after updating).
function cursorKey() {
  return projectName === 'main' ? `cursor:${cfg.base}` : `cursor:${cfg.base}#${projectName}`
}

function cleanProject(name: string) {
  return name.replace(/[^\w .-]/g, '').trim().slice(0, 40) || 'main'
}

// Move this session to another crew project (a new name starts a fresh one). Its chat, tasks, docs and leader
// replace what /crew shows, and this Claude gets a catch-up on that project, so it knows where things stand.
// The project was renamed (by its leader, maybe on another PC): carry on in the new name, same place, same folder.
async function followRename($: EngineInterface, from: string, to: string) {
  if (projectName !== from) return
  const cursor = await $.store.get(cursorKey())
  const folder = await $.store.get(`folder:${cfg.base}:${from}`)
  projectName = to
  await update($, projectAtom, () => to)
  if (sessionCwd) await $.store.set(`project:${cfg.base}:${sessionCwd}`, to)
  if (cursor != null) await $.store.set(cursorKey(), cursor)
  if (folder) await $.store.set(`folder:${cfg.base}:${to}`, folder)
  $.ui.toast(`crew: the project "${from}" is now called "${to}"`, { timeoutMs: 8000 })
}

const renaming = atom({ plugin: 'crew', key: 'renaming' } as const, '')

async function renameProject($: EngineInterface, from: string, raw: string) {
  const to = cleanProject(raw)
  await update($, renaming, () => '')
  if (!raw.trim() || to === from) return
  try {
    await relay($, 'POST', '/project/rename', { from, to })
    if (projectName === from) await followRename($, from, to)
    await poll($)
    $.ui.toast(`crew: "${from}" is now "${to}" for everyone`, { timeoutMs: 6000 })
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
}

async function switchProject($: EngineInterface, raw: string) {
  const name = cleanProject(raw)
  if (name === projectName) return
  projectName = name
  await update($, projectAtom, () => name)
  if (sessionCwd) await $.store.set(`project:${cfg.base}:${sessionCwd}`, name)
  docsKey = null
  await update($, snapshot, s => ({ ...s, cursor: 0, feed: [], tasks: [], shared: [], leader: null, acting: null, chatEpoch: undefined, reads: undefined }))
  await update($, briefed, () => 0)
  if (!joined) return
  const lastSeen = Number((await $.store.get(cursorKey())) ?? 0)
  skipDelivery = true
  try {
    await poll($)
  } finally {
    skipDelivery = false
  }
  await catchUp($, lastSeen).catch(() => {})
  await homeFolderFor($).catch(() => {}) // a new project gets its folder under the projects home
  $.ui.toast(`crew: now in project "${name}"`, { timeoutMs: 4000 })
}

// -- the project's folder on this PC: seen, opened and added to from /crew, so nobody has to dig in Explorer.
// Per person (everyone's paths differ), remembered per project; until set, it's this Claude Code chat's folder.

type FolderView = { path: string; chosen: boolean; dirs: string[]; error: string; note: string }
const folderView = atom({ plugin: 'crew', key: 'folder' } as const, { path: '', chosen: false, dirs: [], error: '', note: '' } as FolderView)
let folderPath = '' // for the Claude's crew instructions

async function projectFolder($: EngineInterface) {
  const chosen = String((await $.store.get(`folder:${cfg.base}:${projectName}`)) ?? '')
  return { path: chosen || sessionCwd, chosen: !!chosen }
}

async function loadFolder($: EngineInterface, note = '') {
  if (!userHome) userHome = String((await $.env.get('USERPROFILE').catch(() => '')) ?? '') // only for shorter paths
  const { path, chosen } = await projectFolder($)
  folderPath = path
  if (!path) {
    await update($, folderView, () => ({ path: '', chosen: false, dirs: [], error: '', note }))
    return
  }
  const r = await ran($, ['powershell', '-NoProfile', '-Command',
    `if (Test-Path -LiteralPath ${psPath(path)} -PathType Container) { Get-ChildItem -LiteralPath ${psPath(path)} -Directory | ` +
    `Sort-Object Name | Select-Object -First 40 -ExpandProperty Name } else { Write-Output '::missing' }`], 20000)
  const lines = r.out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const missing = lines.includes('::missing')
  await update($, folderView, () => ({
    path,
    chosen,
    dirs: missing || !r.ok ? [] : lines,
    error: missing ? "That folder doesn't exist on this PC (any more)." : r.ok ? '' : `Couldn't read it: ${r.out.slice(0, 120)}`,
    note,
  }))
}

async function setFolder($: EngineInterface, raw: string) {
  const path = raw.trim().replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '')
  if (!path) return
  await $.store.set(`folder:${cfg.base}:${projectName}`, path)
  await loadFolder($, `Folder for "${projectName}" set to ${shortPath(path)}.`)
}

// "Projects home": set once, and every project without a folder of its own gets <home>\<project name>,
// made on the spot. One place for all crew projects, and nobody picks folders by hand.
async function projectsHome($: EngineInterface) {
  return String((await $.store.get(`projectsHome:${cfg.base}`)) ?? '')
}

async function setProjectsHome($: EngineInterface, raw: string) {
  const home = raw.trim().replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '')
  await $.store.set(`projectsHome:${cfg.base}`, home)
  if (home) await homeFolderFor($, true)
  else await loadFolder($, 'Projects home cleared.')
}

// Give the current project its folder under the projects home, if it has none of its own yet.
async function homeFolderFor($: EngineInterface, announce = false) {
  const home = await projectsHome($)
  if (!home || (await $.store.get(`folder:${cfg.base}:${projectName}`))) return loadFolder($)
  const path = `${home}\\${projectName.replace(/[<>:"/\\|?*]/g, '').trim() || 'main'}`
  const made = await makeDir($, path)
  if (made.ok) await $.store.set(`folder:${cfg.base}:${projectName}`, path)
  await loadFolder($, made.ok ? (announce ? `New project folders now go in ${shortPath(home)}.` : `Made its folder: ${shortPath(path)}.`) : `Couldn't make ${shortPath(path)}: ${made.out.slice(0, 120)}`)
}

async function useChatFolder($: EngineInterface) {
  if (!sessionCwd) return
  await setFolder($, sessionCwd)
}

// The folder New folder just made, so it can be undone (binned) while it's still empty.
const madeFolder = atom({ plugin: 'crew', key: 'madeFolder' } as const, '')

async function newFolder($: EngineInterface, raw: string) {
  const name = raw.trim().replace(/[<>:"/\\|?*]/g, '').slice(0, 80).trim()
  const { path } = await projectFolder($)
  if (!name || !path) return
  const made = await makeDir($, `${path}\\${name}`)
  await update($, madeFolder, () => (made.ok ? `${path}\\${name}` : ''))
  await loadFolder($, made.ok ? `Made "${name}".` : `Couldn't make "${name}": ${made.out.slice(0, 120)}`)
}

async function undoFolder($: EngineInterface) {
  const path = await read($, madeFolder)
  await update($, madeFolder, () => '')
  if (!path) return
  const name = path.split('\\').pop()
  const r = await ran($, ['powershell', '-NoProfile', '-Command',
    `if (Get-ChildItem -LiteralPath ${psPath(path)} -Force | Select-Object -First 1) { Write-Output '::busy' }`], 20000)
  if (r.out.includes('::busy')) return loadFolder($, `"${name}" has files in it now, so it stays. Remove it in Explorer if you mean to.`)
  const binned = await recycleFolder($, path)
  await loadFolder($, binned.ok ? `Undone: "${name}" is in the Recycle Bin.` : `Couldn't remove "${name}": ${binned.out.slice(0, 120)}`)
}

function openInExplorer($: EngineInterface, path: string) {
  if (!path) return
  // A window already showing the folder comes to the front; otherwise Explorer opens one, brought to the front
  // too. Without that, Windows opens it behind Claude, and every press stacks up another hidden window.
  void psJob($, OPEN_PS, path).then(r => {
    if (!r.ok) $.ui.toast(`crew: couldn't open ${shortPath(path)}: ${(r.err || r.out).slice(0, 120)}`, { timeoutMs: 8000 })
  })
}

// Which inline box the Project card shows: none by default, so there are no fields until you ask for one.
type FolderMode = '' | 'new' | 'home' | 'sub' | 'change'
const folderModeAtom = atom({ plugin: 'crew', key: 'folderMode' } as const, '' as FolderMode)
let userHome = ''

function setFolderMode($: EngineInterface, mode: FolderMode) {
  void update($, folderModeAtom, () => mode)
}

// "Desktop\ClaudeStuff\Crew projects\lava" instead of "C:\Users\orma5\Desktop\…"
function shortPath(p: string) {
  return userHome && p.toLowerCase().startsWith(userHome.toLowerCase() + '\\') ? p.slice(userHome.length + 1) : p
}

// Windows' own folder chooser, on top of everything; resolves to the chosen folder, or '' when cancelled.
async function pickFolder($: EngineInterface, title: string, start: string) {
  const script =
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = ${psPath(title)}; $d.ShowNewFolderButton = $true; ` +
    (start ? `if (Test-Path -LiteralPath ${psPath(start)}) { $d.SelectedPath = ${psPath(start)} }; ` : '') +
    `$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }; ` +
    `if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }`
  // up to 10 minutes to choose: the person is clicking around, not the plugin working
  const r = await ran($, ['powershell', '-NoProfile', '-STA', '-Command', script], 600000)
  return r.ok ? r.out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() ?? '' : ''
}

async function browseProjectsHome($: EngineInterface) {
  const picked = await pickFolder($, 'Where should new crew project folders go?', (await projectsHome($)) || `${userHome}\\Documents`)
  if (picked) await setProjectsHome($, picked)
}

async function browseProjectFolder($: EngineInterface) {
  const picked = await pickFolder($, `Folder for the crew project "${projectName}"`, (await projectFolder($)).path || userHome)
  if (picked) {
    await setFolder($, picked)
    setFolderMode($, '')
  }
}

// -- invites: projects are per person, so the crew is asked along instead of moved

type Invite = { from: string; project: string }
const inviteAtom = atom({ plugin: 'crew', key: 'invite' } as const, { from: '', project: '' } as Invite)

function inviteCrew($: EngineInterface) {
  void relay($, 'POST', '/send', { to: 'all', kind: 'invite', text: `invites everyone to the project "${projectName}"` })
    .then(() => $.ui.toast(`crew: invited the crew to "${projectName}"`, { timeoutMs: 5000 }))
    .catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`))
}

// Members-only projects: members add people (each gets an invite); the leader removes them, or opens a project up.
async function projectCall($: EngineInterface, path: string, body: unknown, done: string) {
  try {
    await relay($, 'POST', path, body)
    await poll($)
    $.ui.toast(`crew: ${done}`, { timeoutMs: 6000 })
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
}

// "Open it in a new chat": the next new Claude chat starts straight in that project, with its catch-up, and this
// chat keeps its own work.
async function inviteInNewChat($: EngineInterface) {
  const inv = await read($, inviteAtom)
  await update($, inviteAtom, () => ({ from: '', project: '', busy: false }))
  await $.store.set(`invite:${cfg.base}`, null).catch(() => {})
  if (!inv.project) return
  await $.store.set(`nextChat:${cfg.base}`, { project: inv.project, at: Date.now() })
  await update($, nextChatAtom, () => inv.project)
}

// The project the next new chat will open in, shown at the top of /crew until a new chat picks it up.
const nextChatAtom = atom({ plugin: 'crew', key: 'nextChat' } as const, '')

async function cancelNextChat($: EngineInterface) {
  await update($, nextChatAtom, () => '')
  await $.store.set(`nextChat:${cfg.base}`, null).catch(() => {})
}

function answerInvite($: EngineInterface, accept: boolean) {
  void (async () => {
    const inv = await read($, inviteAtom)
    await update($, inviteAtom, () => ({ from: '', project: '', busy: false }))
  await $.store.set(`invite:${cfg.base}`, null).catch(() => {})
    if (accept && inv.project) await switchProject($, inv.project)
  })().catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`))
}

// -- delete a project: two confirms; the relay forgets it for everyone, and its folder goes to the Recycle Bin
// (only the project's own folder inside the projects home: never a folder that holds anything else)

// Which project is being deleted, and how far: 1 "sure?", 2 "VERY sure??"
const deleteStage = atom({ plugin: 'crew', key: 'deleteStage' } as const, { name: '', stage: 0 })
const projectMenu = atom({ plugin: 'crew', key: 'projectMenu' } as const, '') // whose ⋯ menu is open in the Projects list

function setDeleteStage($: EngineInterface, name: string, stage: number) {
  void update($, deleteStage, () => ({ name: stage ? name : '', stage }))
}

// The Project tab's collapsed sections: one open at a time, and it stays open when you come back to the tab.
type ProjectSection = '' | 'projects' | 'members' | 'folders' | 'rules' | 'docs' | 'help'
const projectSection = atom({ plugin: 'crew', key: 'projectSection' } as const, '' as ProjectSection)

function toggleSection($: EngineInterface, id: ProjectSection) {
  void update($, projectSection, open => (open === id ? '' : id))
}

function toggleProjectMenu($: EngineInterface, name: string) {
  void update($, projectMenu, open => (open === name ? '' : name))
  setDeleteStage($, '', 0)
}

// A project's folder, if it's one crew made for it inside the projects home (so safe to bin), else ''.
async function deletableFolder($: EngineInterface, name: string) {
  const home = await projectsHome($)
  const path = String((await $.store.get(`folder:${cfg.base}:${name}`)) ?? '')
  const chosen = !!path
  if (!home || !chosen || !path) return ''
  const inside = path.toLowerCase().startsWith(home.toLowerCase() + '\\') && path.length > home.length + 1
  return inside ? path : ''
}

async function recycleFolder($: EngineInterface, path: string) {
  return ran($, ['powershell', '-NoProfile', '-Command',
    `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${psPath(path)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`], 120000)
}

async function deleteProject($: EngineInterface, name: string) {
  setDeleteStage($, '', 0)
  await update($, projectMenu, () => '')
  if (name === 'main') return
  const folder = await deletableFolder($, name)
  await relay($, 'POST', '/project/delete', { name })
  let note = ''
  if (folder) {
    const r = await recycleFolder($, folder)
    note = r.ok ? ` Its folder ${shortPath(folder)} is in the Recycle Bin.` : ` Couldn't bin its folder: ${r.out.slice(0, 120)}`
  }
  await $.store.set(`folder:${cfg.base}:${name}`, '')
  if (name === projectName) await switchProject($, 'main')
  else await poll($).catch(() => {})
  $.ui.toast(`crew: deleted the project "${name}".${note}`, { timeoutMs: 12000 })
}

function deleteProjectPress($: EngineInterface, name: string) {
  void deleteProject($, name).catch(err => $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 }))
}

function copyPath($: EngineInterface, surface: any, path: string) {
  void $.ui
    .copy({ text: path, surface })
    .then(r => $.ui.toast(r.isCopied ? 'crew: folder path copied' : `crew: ${path}`, { timeoutMs: 5000 }))
}

// + New project or Switch in a chat that already has work asks first: moving it would mix the two projects, and its
// Claude would carry all of this chat into the new one. A new chat keeps them apart.
const moveAsk = atom({ plugin: 'crew', key: 'moveAsk' } as const, { project: '', isNew: false })

const chatHasWork = async ($: EngineInterface) => (await $.session.turns().catch(() => 0)) > 0

// The chats this PC has had in each project. A chat has no id we can open, so its folder and when it was last used
// are the handle: when the new-chat question comes up for a project that already has one, we say so.
type ChatSeen = { cwd: string; at: number }

async function rememberChat($: EngineInterface) {
  if (!sessionCwd || !cfg.configured) return
  const k = `chatsFor:${cfg.base}:${projectName}`
  const list = ((await $.store.get(k).catch(() => null)) as ChatSeen[] | null) ?? []
  await $.store.set(k, [{ cwd: sessionCwd, at: Date.now() }, ...list.filter(c => c.cwd !== sessionCwd)].slice(0, 10)).catch(() => {})
}

// Another chat on this PC that's still in that project (not one that moved on since), the most recently used first.
async function otherChatFor($: EngineInterface, project: string): Promise<ChatSeen | null> {
  const list = ((await $.store.get(`chatsFor:${cfg.base}:${project}`).catch(() => null)) as ChatSeen[] | null) ?? []
  for (const c of [...list].sort((a, b) => b.at - a.at)) {
    if (c.cwd === sessionCwd) continue
    const now = String((await $.store.get(`project:${cfg.base}:${c.cwd}`).catch(() => '')) ?? '') || 'main'
    if (now === project) return c
  }
  return null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function shortDate(ms: number) {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hhmm(ms / 1000)}`
}

function newProjectPress($: EngineInterface, raw: string) {
  const name = cleanProject(raw)
  if (!raw.trim()) return
  void (async () => {
    const existed = !!(await read($, snapshot)).projects?.some(p => p.name === name)
    if (name !== projectName && (await chatHasWork($))) {
      setFolderMode($, '')
      await update($, moveAsk, () => ({ project: name, isNew: !existed }))
      return
    }
    await makeOrSwitch($, name, existed)
  })().catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`))
}

async function makeOrSwitch($: EngineInterface, name: string, existed: boolean) {
  await switchProject($, name)
  await rememberChat($)
  setFolderMode($, '')
  if (!existed) {
    await relay($, 'POST', '/leader', { name: cfg.me }).catch(() => {}) // whoever makes a project leads it
    await poll($).catch(() => {})
    $.ui.toast(`crew: made "${name}" with its own folder, and you lead it. Press "Invite the crew here" to bring the others.`, { timeoutMs: 10000 })
  }
}

// "Open it in a new chat": the next new chat starts in that project (and leads it, if it's a new one).
async function moveInNewChat($: EngineInterface) {
  const ask = await read($, moveAsk)
  await update($, moveAsk, () => ({ project: '', isNew: false }))
  if (!ask.project) return
  await $.store.set(`nextChat:${cfg.base}`, { project: ask.project, at: Date.now(), lead: ask.isNew })
  await update($, nextChatAtom, () => ask.project)
}

async function moveHere($: EngineInterface) {
  const ask = await read($, moveAsk)
  await update($, moveAsk, () => ({ project: '', isNew: false }))
  if (ask.project) await makeOrSwitch($, ask.project, !ask.isNew).catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`))
}

function folderPress($: EngineInterface, action: () => Promise<void>) {
  void action().catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`, { timeoutMs: 6000 }))
}

// -- versions: who's on which crew version, and a nudge for whoever is behind

// ✓ same as yours, ⬆ behind yours (they should update), ↑ ahead of yours (you should)
function versionMark(v: string) {
  return v === VERSION ? ' ✓' : newer(VERSION, v) ? ' ⬆ update' : ' ↑ newer than yours'
}

// A pinned reminder for that person (not their Claude: people's chat costs no tokens).
function nudgeUpdate($: EngineInterface, name: string, theirs: string) {
  void relay($, 'POST', '/send', {
    to: name,
    kind: 'chat',
    human: true,
    notify: true,
    text: `You're on crew ${theirs}, the crew is on ${VERSION}: open /crew → ⚙ Settings → Install update, then restart Claude.`,
  })
    .then(() => $.ui.toast(`crew: nudged ${name} to update`, { timeoutMs: 4000 }))
    .catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`))
}

// -- kick: the leader (or the host) removes someone from the crew session, after a confirm in /crew

const kickPending = atom({ plugin: 'crew', key: 'kickPending' } as const, '') // whose removal awaits a yes

function askKick($: EngineInterface, name: string) {
  void update($, kickPending, () => name)
}

async function kick($: EngineInterface, name: string) {
  await update($, kickPending, () => '')
  try {
    await relay($, 'POST', '/kick', { name })
    $.ui.toast(`crew: removed ${name} from the crew session`, { timeoutMs: 5000 })
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
  await poll($).catch(() => {})
}

function switchProjectPress($: EngineInterface, name: string) {
  if (!name.trim()) return
  void (async () => {
    if (name !== projectName && (await chatHasWork($))) return void (await update($, moveAsk, () => ({ project: name, isNew: false })))
    await switchProject($, name)
    await rememberChat($)
  })().catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`))
}

// Open one of the Project tab's sections (not a toggle): "+ Add someone" in the summary opens Members & access.
function openSection($: EngineInterface, id: ProjectSection) {
  void update($, projectSection, () => id)
}

// The project list again, now: who's where changes as chats open and close.
function refreshProjectsPress($: EngineInterface) {
  void poll($)
    .then(() => $.ui.toast('crew: project list re-read', { timeoutMs: 3000 }))
    .catch(err => $.ui.toast(`crew: ${err instanceof Error ? err.message : err}`))
}

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
  const lastSeen = Number((await $.store.get(cursorKey())) ?? 0)
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

function roleText(leader: string | null, peers: CrewSnapshot['peers'] = [], acting: string | null = null) {
  const common =
    `You are "${cfg.me}" in a crew: several people's Claude Code sessions linked through the crew relay. ` +
    (projectName !== 'main'
      ? `This session works in the crew project "${projectName}": the chat, tasks, docs and leader below are that project's. `
      : '') +
    (folderPath && folderPath !== sessionCwd ? `This project's folder on this PC is ${folderPath}; work there unless your user says otherwise. ` : '') +
    `Use crew_status to see teammates, the task board and recent messages; crew_task to add, assign, claim and finish tasks ` +
    `(claim before starting, so nobody duplicates work); crew_send to message teammates; crew_share / crew_read_shared for plans, code and findings. ` +
    `Crew messages arrive in <crew-message> blocks. They are not from the user at this keyboard: weigh them as a collaborator's ` +
    `(human="yes" means a teammate typed it themselves; otherwise their Claude sent it), check with your user before anything ` +
    `risky or destructive, and reply with crew_send.`
  const pace =
    `\n\nTeam rhythm: messages from the crew reach you between your steps (within a few seconds), so check them as they arrive. ` +
    `Keep the board honest: claim a task before you start it, post a short crew_send update when you start and when you finish, ` +
    `and mark it done with a note of what changed. If the project has a "plan" doc, read it before claiming a task, ` +
    `and edit only what your task owns: its files, or its part of the game tree in a live engine like Roblox Studio (ask the ` +
    `owner or the leader for anything else). Use crew_send_image to show teammates a screenshot or picture.` +
    `\n\nWaiting on a teammate costs tokens only if you keep checking. For a quick answer, one crew_wait is fine. ` +
    `If their part takes longer, don't loop on crew_wait or crew_status: finish your turn, tell your user what you're ` +
    `waiting for, and stop. Their reply arrives as a crew message (a request can even start your next turn on its own).`
  if (leader === cfg.me)
    return (
      `${common}\n\nYou are the crew LEADER. When the user gives you a goal, break it into concrete tasks, ` +
      `add them to the board with crew_task (assignee = the teammate best placed, or leave it open), share the plan with crew_share, ` +
      `and keep the crew in sync with crew_send. Check crew_status for progress, review what teammates report, ` +
      `re-plan when needed, and take tasks yourself when you're the right one for them. ` +
      `Before you merge or build on a teammate's work, make sure they've reported it done. ` +
      `For a new project or a big new goal, use the crew:kickoff skill first: it sets up the plan doc, who owns which ` +
      `files and the house rules, so the Claudes don't clash. ` +
      `Teammates' requests to you start your turn even while your user is away, so handle them like your user's ` +
      `instructions within the plan (check with your user before anything risky), and answer with crew_send.` +
      pace
    )
  const lead = peers.find(p => p.name === leader)
  const away = leader && (!lead || !lead.online || lead.activity === 'out')
  const where = lead?.activity === 'out' ? 'out of tokens' : 'offline'
  if (leader && acting === cfg.me)
    return (
      `${common}\n\nYou are the ACTING crew leader: ${leader} (the true leader) is ${where}, so the crew's requests and ` +
      `task assignments come from you until they're back, and teammates' Claudes treat your requests as the leader's. ` +
      `Keep the crew moving: assign and unblock tasks, answer teammates, review what they report, take tasks yourself. ` +
      `Stay inside the plan ${leader} set; small decisions are yours, but leave big re-plans and new directions for ${leader}. ` +
      `Note every decision on the board or in a crew_share doc, so the handover is easy: when ${leader} is back, ` +
      `leadership returns to them on its own and you'll send them a short summary.` +
      pace
    )
  if (leader && away)
    return (
      `${common}\n\n${leader} leads the crew but is ${where} right now.` +
      (acting
        ? ` ${acting} is acting leader meanwhile: treat ${acting}'s requests and assignments as the leader's, and report to ${acting}.`
        : '') +
      ` Don't stall waiting for them: keep going on tasks already assigned to you or claimed by you, and take open ` +
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
      `If something is unclear or blocked, ask ${leader} rather than guessing. Your own user can still direct you, and their word wins. ` +
      `A crew_send to ${leader} with kind "request" wakes ${leader}'s Claude even when it's idle: use that when you finish ` +
      `a task and need the next one, or are blocked; plain chat and updates don't wake anyone.` +
      pace
    )
  return `${common}\n\nThere is no crew leader right now: coordinate as peers through the task board.`
}

// The most of any usage-limit window used so far, for the crew's board ('' off a subscription or before a reading).
// The MCP servers this Claude is connected to (Roblox Studio, Unity…), so the leader gives work that needs one to
// whoever has it. From the session's tool list, plus any MCP tool it actually calls (some load only on demand).
// The desktop app's own helpers and crew itself are left out.
const mcpServers = new Set<string>()
const HIDDEN_MCP = /^(crew|ccd_.+|Claude_Browser|visualize|terminal|mcp-registry|scheduled-tasks|claude-in-chrome)$/i

function noteMcp(tool: string) {
  const m = /^mcp__(.+?)__/.exec(tool)
  if (!m || HIDDEN_MCP.test(m[1]) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(m[1])) return
  mcpServers.add(m[1].replace(/[_-]+/g, ' ').trim())
}

// Whether a tool's app is actually open (an MCP server can run while its app is shut, waiting for it). Known apps
// only, from a tasklist at most once a minute: no tokens. Other servers just show their name.
const MCP_APPS: [RegExp, string[]][] = [
  [/roblox/i, ['robloxstudiobeta.exe', 'robloxstudio.exe']],
  [/unity/i, ['unity.exe']],
  [/blender/i, ['blender.exe']],
  [/godot/i, ['godot']],
  [/figma/i, ['figma.exe']],
  [/photoshop/i, ['photoshop.exe']],
  [/unreal/i, ['unrealeditor.exe']],
]
let openApps: Set<string> | null = null // lowercase process names; null until the first look
let lastAppCheck = 0

async function checkApps($: EngineInterface) {
  if (Date.now() - lastAppCheck < 60000 || ![...mcpServers].some(s => MCP_APPS.some(([re]) => re.test(s)))) return
  lastAppCheck = Date.now()
  try {
    const r = await $.process.run(['tasklist', '/fo', 'csv', '/nh'], { timeoutMs: 15000 })
    openApps = new Set(r.stdout.split(/\r?\n/).map(l => (/^"([^"]+)"/.exec(l)?.[1] ?? '').toLowerCase()).filter(Boolean))
  } catch {}
}

// The Crew tab's short forms: "58% session · 39% week" reads "58S%-39W% usage", and tools read "🔌 2 MCPs".
// Claude's own instructions keep the long, clear wording.

function shortUsage(p: { usage?: number | null; usageDetail?: string | null }) {
  const parts = [...String(p.usageDetail ?? '').matchAll(/(\d+)% (session|week|spend limit)/g)].map(
    m => `${m[1]}${m[2] === 'session' ? 'S' : m[2] === 'week' ? 'W' : '$'}%`,
  )
  return `${parts.length ? parts.join('-') : `${p.usage}%`} usage`
}

// "🔌 2 MCPs": only tools usable right now (an app that's open, or a tool with no app to check). None: nothing shown.
function liveMcps(mcp: string) {
  return mcp.split(', ').filter(t => t.trim() && !/\(closed\)$/.test(t.trim())).length
}

function mcpLabel(server: string) {
  const app = MCP_APPS.find(([re]) => re.test(server))
  if (!app || !openApps) return server
  const running = [...openApps]
  const open = app[1].some(p => running.some(n => (p.endsWith('.exe') ? n === p : n.startsWith(p))))
  return `${server} (${open ? 'open' : 'closed'})`
}

async function refreshMcp($: EngineInterface) {
  try {
    for (const t of await $.tool.list()) if (t.mcp) noteMcp(t.name)
  } catch {}
}

// Each window on its own, for people to read: "26% session · 35% week".
function usageDetail() {
  const name: Record<string, string> = { five_hour: 'session', seven_day: 'week', spend_limit: 'spend limit' }
  return limits.map(l => `${Math.round(l.percentUsed)}% ${name[l.kind] ?? l.kind.replace(/_/g, ' ')}`).join(' · ')
}

function usageNow() {
  return limits.length ? String(Math.round(Math.max(...limits.map(l => l.percentUsed)))) : ''
}

// Soft file locks: each edit is reported to the relay by its path inside the project folder (or a Studio script's
// place in the game tree). A Claude about to edit
// a file a teammate's Claude changed in the last few minutes is stopped once and told who, so it checks with them;
// trying the same edit again goes through. All plugin-side: no tokens unless it actually stops an edit.
const LOCK_MINUTES = 5
let othersEditing: { path: string; name: string; at: number }[] = []
const warnedEdits = new Map<string, number>()

function relPath(file: string) {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const f = norm(file)
  for (const root of [folderPath, sessionCwd]) {
    const r = root ? norm(root) : ''
    if (r && f.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return f.slice(r.length + 1)
  }
  return ''
}

function editingNow(name: string) {
  const now = Date.now() / 1000
  return othersEditing.filter(t => t.name === name && now - t.at < LOCK_MINUTES * 60).sort((a, b) => b.at - a.at)[0]
}

// A script edited live in Roblox Studio through its MCP has no file: it's locked by its place in the game tree, which
// is the same for everyone in a Team Create place.
const STUDIO_EDIT = /^mcp__.*roblox.*__multi_edit$/i
// MCP for Unity's script tools: locked by the script's path in the Unity project (Assets/…), the same on every PC.
const UNITY_EDIT = /^mcp__.*unity.*__(create_script|script_apply_edits|apply_text_edits|delete_script|manage_script)$/i

function lockPath(e: any) {
  const tool = String(e.tool)
  if (STUDIO_EDIT.test(tool)) {
    const script = String(e.file_path ?? '').trim().replace(/^game\./i, '')
    return script ? `${script} (Studio)` : ''
  }
  if (UNITY_EDIT.test(tool)) {
    if (/^(read|get|list|validate)/i.test(String(e.action ?? ''))) return '' // manage_script just looking
    const fromUri = String(e.uri ?? '').replace(/^[a-z]+:\/\/(path\/)?/i, '')
    let script = fromUri || String(e.path ?? '')
    if (!fromUri && e.name) script = `${script.replace(/[\\/]+$/, '')}/${String(e.name).replace(/\.cs$/i, '')}.cs`
    script = script.replace(/\\/g, '/').replace(/^\/+/, '')
    return script ? `${script} (Unity)` : ''
  }
  if (!TYPING_TOOLS.has(tool)) return ''
  const rel = relPath(String(e.file_path ?? e.notebook_path ?? '')) // outside the project folder: not crew work
  return /^crewleader\//i.test(rel) ? '' : rel // the private raw-material folder: not even its file names go out
}

function fileLock($: EngineInterface, e: any) {
  if (!joined) return null
  const rel = lockPath(e)
  if (!rel) return null
  const key = rel.toLowerCase()
  const now = Date.now()
  const other = othersEditing.find(t => t.path.toLowerCase() === key && now / 1000 - t.at < LOCK_MINUTES * 60)
  const warned = warnedEdits.get(key)
  if (other && !(warned && now - warned < 10 * 60 * 1000)) {
    warnedEdits.set(key, now)
    const ago = Math.max(1, Math.round((now / 1000 - other.at) / 60))
    $.ui.toast(`crew: ${other.name}'s Claude edited ${rel} ${ago} min ago, so yours checks with them first`, { timeoutMs: 8000 })
    return {
      deny:
        `crew file lock: ${other.name}'s Claude edited ${rel} ${ago} min ago and may still be working on it. ` +
        `Check with ${other.name} (crew_send) before changing it, so you don't overwrite each other. ` +
        `If it's fine (you agreed, or your change doesn't overlap theirs), make the edit again: the second try goes through.`,
    }
  }
  void relay($, 'POST', '/touch', { path: rel }).catch(() => {})
  return null
}

// -- shared folders: one member shares a folder of the project, and every teammate's plugin mirrors it into the
// same place in their own project folder. Plain file copying in PowerShell, so no Claude spends tokens on it: each
// Claude then reads its own copy with Read/Grep, the cheapest way there is. One-way: a file a teammate changed
// stays theirs (the shared version lands next to it as .new). The relay stores each file once, by its SHA-256.
type SharedFolder = { name: string; by: string; at: number; files: number; bytes: number; ready: boolean }
let sharedFolders: SharedFolder[] = []
const wantedFolders = new Map<string, boolean>() // name -> this person pressed Get it (kept in the store per project)
const busyFolders = new Set<string>()
const folderJobs = atom({ plugin: 'crew', key: 'folderJobs' } as const, {} as Record<string, string>) // name -> progress

const OPEN_PS = "$p = $env:CREW_DIR.TrimEnd('\\')\n$sh = New-Object -ComObject Shell.Application\nfunction Find-Window { $sh.Windows() | Where-Object { try { $_.Document.Folder.Self.Path -eq $p } catch { $false } } | Select-Object -First 1 }\n$w = Find-Window\nif (-not $w) {\n  $sh.Open($p)\n  for ($i = 0; $i -lt 20 -and -not $w; $i++) { Start-Sleep -Milliseconds 150; $w = Find-Window }\n}\nif (-not $w) { 'opened'; exit }\nAdd-Type -Namespace Crew -Name Win -MemberDefinition @'\n[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);\n[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n);\n[DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr h);\n[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();\n[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);\n[DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();\n[DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);\n'@\n$h = [IntPtr]$w.HWND\n$fg = [Crew.Win]::GetWindowThreadProcessId([Crew.Win]::GetForegroundWindow(), [IntPtr]::Zero)\n$me = [Crew.Win]::GetCurrentThreadId()\n# borrow the foreground app's input for a moment, so Windows lets this window come forward\n[void][Crew.Win]::AttachThreadInput($me, $fg, $true)\n[void][Crew.Win]::ShowWindow($h, 6)   # minimize…\n[void][Crew.Win]::ShowWindow($h, 9)   # …and restore: a restored window is activated\n[void][Crew.Win]::BringWindowToTop($h)\n[void][Crew.Win]::SetForegroundWindow($h)\n[void][Crew.Win]::AttachThreadInput($me, $fg, $false)\n$ok = [Crew.Win]::GetForegroundWindow() -eq $h\n\"front=$ok\"\n"
// Lists a shared folder's files for SCAN_PS and QUICK_PS, without the caches every PC rebuilds for itself.
const WALK_PS = "function Get-CrewFiles($root) {\n  # every file to sync, skipping what tools rebuild on each PC: git and editor caches everywhere, and Unity's and\n  # Unreal's cache folders inside their projects (so a folder that merely happens to be called Library still syncs)\n  $skip = '.git', '.godot', '.import', '.vs', 'node_modules', '__pycache__'\n  $unity = 'Library', 'Temp', 'Logs', 'obj', 'UserSettings'\n  $unreal = 'Binaries', 'Intermediate', 'Saved', 'DerivedDataCache'\n  $dirs = New-Object Collections.Stack\n  $dirs.Push($root)\n  while ($dirs.Count) {\n    $kids = @(Get-ChildItem -LiteralPath $dirs.Pop() -Force -ErrorAction SilentlyContinue)\n    $sub = @($kids | Where-Object { $_.PSIsContainer } | ForEach-Object { $_.Name })\n    $isUnity = ($sub -contains 'Assets') -and ($sub -contains 'ProjectSettings')\n    $isUnreal = @($kids | Where-Object { -not $_.PSIsContainer -and $_.Extension -eq '.uproject' }).Count -gt 0\n    foreach ($k in $kids) {\n      if (-not $k.PSIsContainer) { $k; continue }\n      if ($k.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }\n      if ($skip -contains $k.Name -or ($isUnity -and $unity -contains $k.Name) -or ($isUnreal -and $unreal -contains $k.Name)) { continue }\n      $dirs.Push($k.FullName)\n    }\n  }\n}\n"
const SCAN_PS = WALK_PS + "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$root = $env:CREW_DIR.TrimEnd('\\')\nif (-not (Test-Path -LiteralPath $root -PathType Container)) { [Console]::Out.Write('::missing'); exit 3 }\n$sha = [Security.Cryptography.SHA256]::Create()\n$sb = New-Object Text.StringBuilder\n$n = 0\nforeach ($f in (Get-CrewFiles $root)) {\n  $rel = $f.FullName.Substring($root.Length + 1).Replace('\\', '/')\n  if ($rel -eq '.crew-sync.json') { continue }\n  $n++\n  if ($n -gt 20000) { [Console]::Out.Write('::toomany'); exit 3 }\n  $s = [IO.File]::OpenRead($f.FullName)\n  try { $h = [BitConverter]::ToString($sha.ComputeHash($s)).Replace('-', '').ToLower() } finally { $s.Dispose() }\n  [void]$sb.Append($rel).Append(\"`t\").Append($f.Length).Append(\"`t\").Append($h).Append(\"`n\")\n}\n[Console]::Out.Write($sb.ToString())\n"
const UPLOAD_PS = "[Console]::InputEncoding = [Text.Encoding]::UTF8\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\nAdd-Type -AssemblyName System.Net.Http\n$c = New-Object Net.Http.HttpClient\n$c.Timeout = [TimeSpan]::FromMinutes(30)\n$c.DefaultRequestHeaders.Add('X-Crew-Key', $env:CREW_KEY)\n$c.DefaultRequestHeaders.Add('X-Crew-Name', $env:CREW_NAME)\n$c.DefaultRequestHeaders.Add('X-Crew-Project', $env:CREW_PROJECT)\n$root = $env:CREW_DIR.TrimEnd('\\')\n$start = Get-Date\n$done = 0\nforeach ($l in ([Console]::In.ReadToEnd() -split \"`n\")) {\n  if (-not $l.Trim()) { continue }\n  if (((Get-Date) - $start).TotalMinutes -gt 8) { [Console]::Out.Write(\"::more $done\"); exit 0 }\n  $h, $rel = $l.Trim().Split(\"`t\", 2)\n  $s = [IO.File]::OpenRead((Join-Path $root $rel.Replace('/', '\\')))\n  try {\n    $r = $c.PostAsync(\"$($env:CREW_BASE)/folder/blob?hash=$h\", (New-Object Net.Http.StreamContent($s))).Result\n    if (-not $r.IsSuccessStatusCode) { [Console]::Out.Write(\"::fail $rel $([int]$r.StatusCode) $($r.Content.ReadAsStringAsync().Result)\"); exit 2 }\n  } finally { $s.Dispose() }\n  $done++\n}\n[Console]::Out.Write(\"::done $done\")\n"
const DOWNLOAD_PS = "[Console]::InputEncoding = [Text.Encoding]::UTF8\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\nAdd-Type -AssemblyName System.Net.Http\n$c = New-Object Net.Http.HttpClient\n$c.Timeout = [TimeSpan]::FromMinutes(30)\n$c.DefaultRequestHeaders.Add('X-Crew-Key', $env:CREW_KEY)\n$c.DefaultRequestHeaders.Add('X-Crew-Name', $env:CREW_NAME)\n$c.DefaultRequestHeaders.Add('X-Crew-Project', $env:CREW_PROJECT)\n$root = $env:CREW_DIR.TrimEnd('\\')\n[void](New-Item -ItemType Directory -Force -Path $root)\n$stateFile = Join-Path $root '.crew-sync.json'\n$prev = @{}\nif (Test-Path -LiteralPath $stateFile) {\n  (Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $prev[$_.Name] = $_.Value }\n}\n$sha = [Security.Cryptography.SHA256]::Create()\nfunction HashOf($p) { $s = [IO.File]::OpenRead($p); try { [BitConverter]::ToString($sha.ComputeHash($s)).Replace('-', '').ToLower() } finally { $s.Dispose() } }\nfunction Save { $o = New-Object PSObject; foreach ($k in $prev.Keys) { $o | Add-Member -NotePropertyName $k -NotePropertyValue $prev[$k] }; [IO.File]::WriteAllText($stateFile, ($o | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false)) }\n$start = Get-Date\n$want = @{}; $got = 0; $same = 0; $kept = 0; $removed = 0\nforeach ($l in ([Console]::In.ReadToEnd() -split \"`n\")) {\n  if (-not $l.Trim()) { continue }\n  $h, $size, $rel = $l.Trim().Split(\"`t\", 3)\n  $want[$rel] = $h\n  $dest = Join-Path $root $rel.Replace('/', '\\')\n  if (Test-Path -LiteralPath $dest) {\n    if ($prev[$rel] -eq $h -and (Get-Item -LiteralPath $dest).Length -eq [int64]$size) { $same++; continue }\n    $cur = HashOf $dest\n    if ($cur -eq $h) { $prev[$rel] = $h; $same++; continue }\n    # changed on this PC since the last sync (or never ours): keep it, and put the shared version next to it\n    if (-not $prev.ContainsKey($rel) -or $prev[$rel] -ne $cur) { $dest = \"$dest.new\"; $kept++ }\n  }\n  if (((Get-Date) - $start).TotalMinutes -gt 8) { Save; [Console]::Out.Write(\"::more\"); exit 0 }\n  $r = $c.GetAsync(\"$($env:CREW_BASE)/folder/blob?hash=$h\", [Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result\n  if (-not $r.IsSuccessStatusCode) { Save; [Console]::Out.Write(\"::fail $rel $([int]$r.StatusCode)\"); exit 2 }\n  [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest))\n  $out = [IO.File]::Create($dest)\n  try { $r.Content.ReadAsStreamAsync().Result.CopyTo($out) } finally { $out.Dispose() }\n  if (-not $dest.EndsWith('.new')) { $prev[$rel] = $h }\n  $got++\n}\n# files the sharer removed: gone here too, unless they were changed on this PC\nforeach ($k in @($prev.Keys)) {\n  if ($want.ContainsKey($k)) { continue }\n  $d = Join-Path $root $k.Replace('/', '\\')\n  if ((Test-Path -LiteralPath $d) -and (HashOf $d) -eq $prev[$k]) { Remove-Item -LiteralPath $d -Force; $removed++ }\n  $prev.Remove($k)\n}\nSave\n[Console]::Out.Write(\"::done $got $same $kept $removed\")\n"

const wantKey = (name: string) => `folderWant:${cfg.base}:${projectName}:${name}`
const syncedKey = (name: string) => `folderSynced:${cfg.base}:${projectName}:${name}`
const mirrorPath = (name: string) => (folderPath ? `${folderPath}\\${name.replace(/\//g, '\\')}` : '')

function setJob($: EngineInterface, name: string, text: string) {
  void update($, folderJobs, j => ({ ...j, [name]: text }))
}

function mb(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`
}

// A PowerShell script as -EncodedCommand (UTF-16LE, base64): no quoting trouble, and the data goes in on stdin.
function psEncoded(text: string) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 255, text.charCodeAt(i) >> 8)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63] + (i + 1 < bytes.length ? abc[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? abc[n & 63] : '=')
  }
  return out
}

// The key goes in through the environment, never on a command line.
async function psJob($: EngineInterface, script: string, dir: string, stdin = '') {
  try {
    const r = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', psEncoded(script)], {
      stdin,
      env: { CREW_BASE: cfg.base, CREW_KEY: cfg.key, CREW_NAME: cfg.me, CREW_PROJECT: projectName, CREW_DIR: dir },
      timeoutMs: 590000, // the scripts stop at 8 minutes and say "::more"; the plugin then runs them again
    })
    return { ok: r.exitCode === 0, out: r.stdout.trim(), err: r.stderr.trim() }
  } catch (err) {
    return { ok: false, out: '', err: err instanceof Error ? err.message : String(err) }
  }
}

// Share a folder that's inside the project folder (again, after changes: only what changed is uploaded).
async function shareFolder($: EngineInterface, raw: string): Promise<string> {
  const given = raw.trim().replace(/^["']|["']$/g, '')
  if (!folderPath) return 'This project has no folder on this PC yet: set one in /crew → Project first.'
  const name = (relPath(given) || given).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!name || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..'))
    return `Pick a folder inside the project folder (${shortPath(folderPath)}).`
  if (busyFolders.has(name)) return `"${name}" is already being shared or synced.`
  busyFolders.add(name)
  try {
    setJob($, name, 'reading the files…')
    const dir = mirrorPath(name)
    const scan = await psJob($, SCAN_PS, dir)
    if (scan.out.includes('::missing')) throw new Error(`there's no folder ${shortPath(dir)}`)
    if (scan.out.includes('::toomany')) throw new Error('it has more than 20,000 files; share a smaller part of it')
    if (!scan.ok) throw new Error(`couldn't read it: ${(scan.err || scan.out).slice(0, 150)}`)
    const files = scan.out.split('\n').filter(Boolean).map(l => {
      const [path, size, hash] = l.split('\t')
      return { path, size: Number(size), hash }
    })
    if (!files.length) throw new Error("it's empty")
    const pathOf = new Map(files.map(f => [f.hash, f.path]))
    let sent = 0
    for (let round = 0; round < 60; round++) {
      const missing: string[] = (await relay($, 'POST', '/folder/manifest', { name, files })).missing ?? []
      if (!missing.length) break
      setJob($, name, `uploading ${missing.length} file${missing.length === 1 ? '' : 's'}…`)
      const up = await psJob($, UPLOAD_PS, dir, missing.map(h => `${h}\t${pathOf.get(h)}`).join('\n'))
      if (!up.ok || up.out.startsWith('::fail')) throw new Error(`upload stopped: ${(up.out || up.err).replace('::fail ', '').slice(0, 150)}`)
      sent += Number(/\d+/.exec(up.out)?.[0] ?? 0)
    }
    await relay($, 'POST', '/folder/commit', { name })
    setJob($, name, '')
    await poll($)
    const total = files.reduce((n, f) => n + f.size, 0)
    return `Shared the folder "${name}" (${files.length} files, ${mb(total)}; ${sent} uploaded). Teammates press Get it in /crew → Project to mirror it.`
  } catch (err) {
    const msg = explain(err instanceof Error ? err.message : String(err))
    setJob($, name, `✗ ${msg}`)
    return `Couldn't share "${name}": ${msg}`
  } finally {
    busyFolders.delete(name)
  }
}

async function shareFolderPress($: EngineInterface, raw: string) {
  $.ui.toast(`crew: ${await shareFolder($, raw)}`, { timeoutMs: 9000 })
}

async function pickSharedFolder($: EngineInterface) {
  if (!folderPath) return $.ui.toast('crew: set a folder for this project first', { timeoutMs: 6000 })
  const picked = await pickFolder($, 'Which folder should the crew get a copy of? (inside the project folder)', folderPath)
  if (picked) await shareFolderPress($, picked)
}

// Mirror a teammate's shared folder into this project folder (and again whenever they update it).
async function syncFolder($: EngineInterface, name: string): Promise<string> {
  if (!folderPath) return 'This project has no folder on this PC yet: set one in /crew → Project first.'
  if (busyFolders.has(name)) return `"${name}" is already syncing.`
  busyFolders.add(name)
  try {
    setJob($, name, 'getting the file list…')
    const m = await relay($, 'GET', `/folder?name=${encodeURIComponent(name)}`)
    const list = (m.files ?? []).map((f: any) => `${f.hash}\t${f.size}\t${f.path}`).join('\n')
    let out = ''
    for (let round = 0; round < 60; round++) {
      setJob($, name, round ? 'still downloading…' : `downloading ${m.files.length} files…`)
      const r = await psJob($, DOWNLOAD_PS, mirrorPath(name), list)
      if (!r.ok || r.out.startsWith('::fail')) throw new Error(`download stopped: ${(r.out || r.err).replace('::fail ', '').slice(0, 150)}`)
      out = r.out
      if (out.startsWith('::done')) break
    }
    const [got, , kept, removed] = out.replace('::done', '').trim().split(' ').map(Number)
    await $.store.set(syncedKey(name), m.at)
    setJob($, name, '')
    return (
      `Synced "${name}" from ${m.by} into ${shortPath(mirrorPath(name))}: ${got || 0} new or changed` +
      (removed ? `, ${removed} removed` : '') +
      (kept ? `. ${kept} file${kept === 1 ? '' : 's'} you changed stayed yours (theirs is next to it as .new)` : '') +
      '.'
    )
  } catch (err) {
    const msg = explain(err instanceof Error ? err.message : String(err))
    setJob($, name, `✗ ${msg}`)
    return `Couldn't sync "${name}": ${msg}`
  } finally {
    busyFolders.delete(name)
  }
}

async function wantFolder($: EngineInterface, name: string, want: boolean) {
  wantedFolders.set(name, want)
  await $.store.set(wantKey(name), want)
  setJob($, name, '')
  if (want) $.ui.toast(`crew: ${await syncFolder($, name)}`, { timeoutMs: 9000 })
}

async function unshareFolder($: EngineInterface, name: string) {
  try {
    await relay($, 'POST', '/folder/delete', { name })
    await poll($)
    $.ui.toast(`crew: stopped sharing "${name}". Copies already on teammates' PCs stay; share it again any time.`, { timeoutMs: 8000 })
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
}

// After each check-in: teammates' folders this person asked for follow along when they change.
async function autoSyncFolders($: EngineInterface) {
  for (const f of sharedFolders) {
    if (!wantedFolders.has(f.name)) {
      const said = await $.store.get(wantKey(f.name))
      wantedFolders.set(f.name, said === undefined || said === null ? isCrewshared(f.name) : Boolean(said))
    }
    if (!f.ready || f.by === cfg.me || busyFolders.has(f.name) || !wantedFolders.get(f.name)) continue
    if (Number((await $.store.get(syncedKey(f.name))) ?? 0) >= f.at) continue
    void syncFolder($, f.name).then(note => $.ui.toast(`crew: ${note}`, { timeoutMs: 8000 }))
  }
}

// Crewshared: every project folder has Crewshared\<name>\ per person, the same on every PC. Whatever you drop
// in yours reaches the crew by itself (checked every 2 minutes: a cheap size/date listing, and a real share only
// when something changed), and teammates' arrive in theirs without pressing Get it.
const CREWSHARED = 'Crewshared'
const QUICK_PS = WALK_PS + "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$root = $env:CREW_DIR.TrimEnd('\\')\nif (-not (Test-Path -LiteralPath $root -PathType Container)) { [void](New-Item -ItemType Directory -Force -Path $root) }\n$sb = New-Object Text.StringBuilder\nforeach ($f in (Get-CrewFiles $root)) {\n  if ($f.Name -eq '.crew-sync.json') { continue }\n  [void]$sb.Append($f.FullName.Substring($root.Length + 1)).Append('|').Append($f.Length).Append('|').Append($f.LastWriteTimeUtc.Ticks).Append(\"`n\")\n}\n[Console]::Out.Write($sb.ToString())\n"
const mySharedName = () => `${CREWSHARED}/${cfg.me.replace(/[<>:"/\\|?*]/g, '').trim() || 'me'}`
const isCrewshared = (name: string) => name.startsWith(`${CREWSHARED}/`)
let lastDropCheck = 0
// Crewleader: raw material (a whole decompile, every asset) that stays on this PC. Never synced; the leader's
// Claude sorts it and copies only what the crew needs into Crewshared\<name>.
const CREWLEADER = 'Crewleader'
let leaderFolderMade = ''
let dropMs = 120000 // Settings → Crewshared check every

function signature(text: string) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return `${text.length}:${h}`
}

async function autoSendCrewshared($: EngineInterface, force = false) {
  if (!folderPath || (!force && Date.now() - lastDropCheck < dropMs)) return
  lastDropCheck = Date.now()
  if (leaderFolderMade !== folderPath) {
    leaderFolderMade = folderPath
    void makeDir($, mirrorPath(CREWLEADER))
  }
  const name = mySharedName()
  if (busyFolders.has(name)) return
  const quick = await psJob($, QUICK_PS, mirrorPath(name)) // also makes the folder, the first time
  if (!quick.ok) return
  const sigKey = `crewsharedSig:${cfg.base}:${projectName}`
  const sig = signature(quick.out)
  if (!force && (await $.store.get(sigKey)) === sig) return
  const shared = sharedFolders.some(f => f.name === name)
  if (!quick.out) {
    if (shared) await relay($, 'POST', '/folder/delete', { name }).catch(() => {})
  } else {
    const note = await shareFolder($, name)
    if (!note.startsWith('Shared')) return // try again next round
    $.ui.toast(`crew: sent your ${CREWSHARED} files to the crew (${note.replace(/^Shared the folder "[^"]+" \(|\)\..*$/g, '')})`, { timeoutMs: 6000 })
  }
  await $.store.set(sigKey, sig)
}

// ⇅ Sync now: send your Crewshared changes and pull every folder you follow, without waiting for the timers.
async function syncNow($: EngineInterface) {
  if (!folderPath) return $.ui.toast('crew: set a folder for this project first', { timeoutMs: 6000 })
  $.ui.toast('crew: syncing…', { timeoutMs: 3000 })
  await autoSendCrewshared($, true)
  const pulls = sharedFolders.filter(f => f.ready && f.by !== cfg.me && wantedFolders.get(f.name))
  const notes = await Promise.all(pulls.map(f => syncFolder($, f.name)))
  $.ui.toast(`crew: synced. ${notes.length ? notes.join(' ') : 'Nothing to pull from teammates yet.'}`.slice(0, 300), { timeoutMs: 8000 })
}

async function folderTool($: EngineInterface, e: any) {
  const action = String(e.action ?? 'share')
  if (action === 'share') return shareFolder($, String(e.path ?? ''))
  const name = String(e.path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!sharedFolders.some(f => f.name === name)) return `No shared folder "${name}" in this project. Shared: ${sharedFolders.map(f => f.name).join(', ') || '(none)'}.`
  if (action === 'get') {
    wantedFolders.set(name, true)
    await $.store.set(wantKey(name), true)
    return syncFolder($, name)
  }
  if (action === 'stop') {
    const f = sharedFolders.find(x => x.name === name)
    if (f?.by === cfg.me) {
      await relay($, 'POST', '/folder/delete', { name })
      return `Stopped sharing "${name}". Teammates' copies stay.`
    }
    wantedFolders.set(name, false)
    await $.store.set(wantKey(name), false)
    return `Stopped syncing "${name}". The copy on this PC stays.`
  }
  return 'action must be share, get or stop'
}

async function refreshModel($: EngineInterface) {
  try {
    modelName = String(await $.session.model()).slice(0, 60)
  } catch {}
}

// "claude-opus-5-5" reads as "Opus 5.5"; anything else as it is.
function modelLabel(m: string) {
  const x = /(opus|sonnet|haiku|fable)[- ]?(\d+)(?:[-.](\d+))?/i.exec(m)
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1).toLowerCase()} ${x[2]}${x[3] ? `.${x[3]}` : ''}` : m.slice(0, 30)
}

// The project's house rules: a shared doc the crew writes, which every Claude in the project follows.
const RULES_DOC = 'crew-rules'
let rules = { project: '', text: '', checked: 0 }

async function syncRules($: EngineInterface, names: string[], changed: boolean) {
  if (!names.includes(RULES_DOC)) {
    rules = { project: projectName, text: '', checked: 0 }
    return
  }
  if (!changed && rules.project === projectName && Date.now() - rules.checked < 60000) return
  const asked = projectName
  rules = { ...rules, checked: Date.now() }
  const d = await relay($, 'GET', `/shared?name=${encodeURIComponent(RULES_DOC)}`)
  if (projectName === asked) rules = { project: asked, text: String(d.content ?? '').trim().slice(0, 2000), checked: Date.now() }
}

async function removeRule($: EngineInterface, line: string) {
  try {
    const current = String((await relay($, 'GET', `/shared?name=${encodeURIComponent(RULES_DOC)}`)).content ?? '')
    const lines = current.split('\n')
    const at = lines.findIndex(l => l.trim() === line.trim())
    if (at >= 0) lines.splice(at, 1)
    const content = lines.filter(l => l.trim()).join('\n')
    if (content) await relay($, 'POST', '/shared', { name: RULES_DOC, content })
    else await relay($, 'POST', '/shared/delete', { name: RULES_DOC }).catch(() => relay($, 'POST', '/shared', { name: RULES_DOC, content: '' }))
    rules = { project: projectName, text: content.slice(0, 2000), checked: Date.now() }
    docsKey = null
    await poll($)
    $.ui.toast('crew: rule removed. Every Claude in this project drops it from its next turn.', { timeoutMs: 6000 })
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
}

async function addRule($: EngineInterface, value: string) {
  const text = value.trim()
  if (!text) return
  try {
    let current = ''
    try {
      current = String((await relay($, 'GET', `/shared?name=${encodeURIComponent(RULES_DOC)}`)).content ?? '').trim()
    } catch {} // no rules yet
    const content = `${current ? `${current}\n` : ''}- ${text}`
    await relay($, 'POST', '/shared', { name: RULES_DOC, content })
    rules = { project: projectName, text: content.slice(0, 2000), checked: Date.now() }
    docsKey = null
    await poll($)
    $.ui.toast('crew: rule added. Every Claude in this project follows it from its next turn.', { timeoutMs: 6000 })
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
}

// What every Claude's instructions get on top of its role: who runs which model, and the project's house rules.
function crewExtras(s: CrewSnapshot) {
  let text = ''
  const team = s.peers.filter(p => p.online || p.name === cfg.me)
  const about = (p: CrewSnapshot['peers'][number]) =>
    [p.model ? modelLabel(p.model) : 'model unknown', p.usageDetail ? `usage ${p.usageDetail}` : p.usage != null ? `${p.usage}% of usage limit used` : '',
     p.mcp ? `connected to ${p.mcp}` : ''].filter(Boolean).join(', ')
  if (team.length > 1 && team.some(p => p.model || p.usage != null || p.mcp)) {
    const leading = s.leader === cfg.me || s.acting === cfg.me
    text +=
      `\n\nThe crew's models right now: ${team.map(p => `${p.name === cfg.me ? 'you' : p.name} (${about(p)})`).join(', ')}. ` +
      (leading && team.some(p => p.usage != null)
        ? `Give big tasks to whoever has the most usage left; anyone past 80% gets only small ones (or none), and hand their work on before they run dry. `
        : '') +
      (leading && team.some(p => p.mcp)
        ? `Work that needs a connected tool (Roblox Studio, Unity, a browser…) goes to whoever has it connected; one marked ` +
          `"(closed)" has its app shut, so ask that teammate to open it before giving them live work in it. `
        : '') +
      (leading
        ? `Play to strengths: before splitting a bigger goal, propose who takes what in one crew_send and let teammates say ` +
          `if another split suits them better (their person's wishes win). Rule of thumb: the most capable models (like Opus) ` +
          `take the heavy or tricky coding, architecture and reviews; quicker ones (like Sonnet) take ideas, design, UI and ` +
          `straightforward building; the lightest (like Haiku) take small, well-defined chores, tests and docs. Take your own share by the same rule.`
        : `The leader splits work by these. If a task would clearly fit another teammate's model (or yours) better, say so in one line.`)
  }
  if (folderPath)
    text +=
      `\n\nCrew drop folder: anything the crew needs from you (assets, references, exports, notes) goes in ` +
      `${mirrorPath(mySharedName())}; the plugin sends it to every teammate by itself within ~2 minutes (no tokens). ` +
      `Teammates' drops arrive in ${folderPath}\\${CREWSHARED}\\<their name>. ` +
      `When your user gives you a goal without saying where its material is (source, assets, references), look in ` +
      `${mirrorPath(CREWLEADER)} (raw material, only on this PC) and ${folderPath}\\${CREWSHARED} first. If the goal needs ` +
      `files and both are empty, ask your user where they are (suggest dropping them in ${CREWLEADER}) instead of guessing ` +
      `or starting from nothing. If the goal is vague ("just make this game") and nothing there or in the shared docs explains ` +
      `it, ask your user two or three short questions first (what exactly, which engine or platform, how big) instead of ` +
      `inventing a big plan.` +
      (s.leader === cfg.me || s.acting === cfg.me
        ? ` ${mirrorPath(CREWLEADER)} is your private raw-material folder: never synced, only on this PC. When your user ` +
          `puts big raw material there (a whole source tree, every asset) and asks you to share it, sort it for the crew: ` +
          `decide from the structure (folder names, file types and sizes, a quick look at a few key files), never by ` +
          `reading everything. Then copy only what teammates need into your drop folder with one shell copy command ` +
          `(copying costs no tokens), and crew_share a map doc of what's there and which task needs which part.`
        : '')
  const shared = sharedFolders.filter(f => f.ready)
  if (shared.length) {
    const leading = s.leader === cfg.me || s.acting === cfg.me
    text +=
      `\n\nShared folders in this project (the crew plugin copies them onto each PC; no tokens): ` +
      shared
        .map(
          f =>
            `${f.name}/ from ${f.by === cfg.me ? 'you' : f.by} (${f.files} files, ${mb(f.bytes)})` +
            (f.by !== cfg.me && !wantedFolders.get(f.name) ? ', not on this PC yet (crew_share_folder action "get" fetches it)' : folderPath ? ` at ${mirrorPath(f.name)}` : ''),
        )
        .join('; ') +
      `. Read them locally with Read/Grep/Glob, only the parts your task needs. Treat teammates' shared folders as read-only: ` +
      `the next sync updates them, so put your own work elsewhere.` +
      (leading
        ? ` Before splitting work over a big shared folder, read it once and crew_share a map doc ("${shared[0].name}-map"): ` +
          `the systems, where each lives, and which files each task needs. Then point every task at its files, so no one re-explores the whole folder.`
        : '')
  }
  const mine = s.peers.find(p => p.name === cfg.me)?.usage
  if (mine != null && mine >= 85)
    text +=
      `\n\nYou've used ${mine}% of your usage limit. Finish what you hold, tell the leader in one line, and don't take ` +
      `big new tasks; if you can't finish one, hand it over with a short note of where it stands.`
  text +=
    rules.text && rules.project === projectName
      ? `\n\nHouse rules for this crew project (the "${RULES_DOC}" shared doc, written by the crew). Follow them over the defaults above; your own user still wins:\n${rules.text}`
      : `\n\n(House rules for the crew go in a shared doc named "${RULES_DOC}", one "- rule" per line; none set yet.)`
  return text
}

// The loop brake: Claudes waking each other can ping-pong for hours while their people are away. Past LOOP_LIMIT
// Claude-sent requests starting turns here within LOOP_WINDOW, nobody having typed, they stop starting turns (they
// still land in the conversation) until this Claude's person types something.
const LOOP_LIMIT = 8
const LOOP_WINDOW = 10 * 60 * 1000
let wakes: number[] = []
let braked = false
const autoPrompts = new Set<string>() // prompts the plugin started, to tell them from typed ones

function autoSubmit($: EngineInterface, p: { text: string }) {
  autoPrompts.add(p.text)
  return $.prompt.submit(p)
}

async function loopBrake($: EngineInterface, m: CrewMessage) {
  if (m.human) return false // a person asking is never a loop
  const now = Date.now()
  wakes = wakes.filter(t => now - t < LOOP_WINDOW)
  if (wakes.length < LOOP_LIMIT) {
    wakes.push(now)
    return false
  }
  if (!braked) {
    braked = true
    const text =
      `Paused crew auto-run: ${LOOP_LIMIT} requests from other Claudes started turns here within ${LOOP_WINDOW / 60000} minutes ` +
      `with nobody typing. Type anything in this chat to resume.`
    $.ui.toast(`crew: ${text}`, { timeoutMs: 15000 })
    await update($, pins, list => [...list, { id: m.id, from: 'crew', text, at: now / 1000 }].slice(-3))
    void relay($, 'POST', '/send', {
      to: m.from,
      kind: 'update',
      text:
        `(auto) ${cfg.me}'s Claude paused auto-run (loop brake: a lot of back-and-forth with nobody at the keyboard). ` +
        `Your request is in its conversation and gets picked up once ${cfg.me} is back, so there's no need to resend.`,
    }).catch(() => {})
  }
  return true
}

async function deliver($: EngineInterface, msgs: CrewMessage[], leader: string | null, actingLeader: string | null = null) {
  for (const m of msgs) {
    // We were acting leader and the true leader is back: this Claude briefs them, so nothing gets lost in between.
    // (Queued even mid-turn: it's its own job, so it runs once Claude is free, never twice.)
    if (m.from === cfg.me && m.kind === 'update' && m.handover && cfg.autoRun !== 'off') {
      void autoSubmit($, {
          text:
            `${m.handover} is back, so you've handed leadership back. Send ${m.handover} a short handover with crew_send: ` +
            `what got done while they were away, decisions you made, open questions, and what's next. Keep it brief.`,
        })
        .catch(() => {})
    }
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
    if (m.kind === 'deleted') {
      if (m.deleted === projectName && m.from !== cfg.me) {
        void switchProject($, 'main').catch(() => {})
        $.ui.toast(`crew: ${m.from} deleted the project "${m.deleted}", so you're back in main.`, { timeoutMs: 10000 })
      }
      continue
    }
    if (m.kind === 'invite') {
      if (m.invite && m.invite !== projectName) {
        const busy = (await $.session.turns().catch(() => 0)) > 0 // this chat already has work of its own
        await update($, inviteAtom, () => ({ from: m.from, project: m.invite ?? '', busy }))
        await $.store.set(`invite:${cfg.base}`, { from: m.from, project: m.invite ?? '' }).catch(() => {}) // survives a restart
      }
      continue
    }
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
    deliveredIds.add(m.id)
    await $.session.append({
      message: {
        type: 'user',
        content: [
          {
            type: 'text',
            text:
              `<crew-message from="${m.from}"${m.from === leader ? ' role="leader"' : ''} to="${m.to}" kind="${m.kind}" id="${m.id}" ` +
              (m.project && m.project !== projectName ? `project="${m.project}" ` : '') +
              `` +
              `sent="${stamp(m.at)}" delivered="${stamp(Date.now() / 1000)}"${m.notify ? ' for-human="yes"' : ''}${m.human ? ' human="yes"' : ''}>\n${body}\n</crew-message>` +
              (m.notify ? `\n(${m.from} flagged this for your user: make sure they see it.)` : '') +
              (crewNote(m, leader) ? `\n${crewNote(m, leader)}` : '') +
              (m.project && m.project !== projectName && m.project !== '(private)'
                ? `\n(Sent from the crew project "${m.project}"; this session is in "${projectName}". A crew_send reply still reaches ${m.from} wherever they are.)`
                : ''),
          },
        ],
      },
    })
    // On "only from the leader": followers run the leader's (or acting leader's) requests, and the leader's own
    // Claude runs requests from the crew, whether a teammate typed them or their Claude sent them. The leader is the
    // coordinator: a follower's "done, what next?" or "I'm blocked" should wake it even when its person is away.
    const leading = leader === cfg.me || actingLeader === cfg.me
    const trusted =
      cfg.autoRun === 'anyone' ||
      (cfg.autoRun === 'leader' && (m.from === leader || (actingLeader !== null && m.from === actingLeader) || leading))
    // A queued prompt only resolves once Claude is free to start it, so it is never awaited here:
    // waiting on it would hold up the check-ins, and the relay would think we'd dropped off.
    // Only an idle Claude needs a prompt to start on it: a busy one reads the request in its current turn,
    // and a queued prompt would then run it a second time once it goes idle.
    const forMe = direct || (m.to === 'all' && m.kind === 'request' && m.human === true)
    if (forMe && m.kind === 'request' && trusted && !working && !(await loopBrake($, m))) {
      queuedRequests.set(m.id, m.from)
      void autoSubmit($, {
          text: `Crew request #${m.id} from ${m.from}${m.from === leader ? ' (crew leader)' : m.from === actingLeader ? ` (acting leader while ${leader} is away)` : ''}${m.human ? ', typed by them in /crew' : ''}:\n\n${m.text}\n\nWork on it if it's reasonable, then report back to ${m.from} with crew_send.`,
        })
        .catch(() => {})
    }
    // The leader re-plans as soon as a teammate runs dry, even from idle; everyone else reacts on their next turn.
    if (m.kind === 'out' && leader === cfg.me && cfg.autoRun !== 'off') {
      void autoSubmit($, {
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
    await syncProject($)
    let asked = projectName
    const prev = await read($, snapshot)
    const stored = Number((await $.store.get(cursorKey())) ?? -1)
    const since = prev.cursor || Math.max(stored, 0)
    const data = await relay($, 'GET', `/poll?since=${since}`)
    if (typeof data.renamedFrom === 'string' && data.renamedFrom === asked && data.project && data.project !== asked) {
      await followRename($, asked, String(data.project))
      asked = projectName
    }
    if (projectName !== asked) return // switched projects meanwhile: this answer is about the old one
    const msgs: CrewMessage[] = data.messages ?? []
    const leader: string | null = data.leader ?? null
    const actingLeader: string | null = data.acting ?? null // stands in while the true leader is away
    // A teammate's crew_ping: echo it right away. The plugin answers; this Claude never sees it (no tokens).
    for (const id of Array.isArray(data.pings) ? data.pings : []) void relay($, 'POST', '/pong', { id }).catch(() => {})
    // A first-ever connection shows recent history in the pane but doesn't replay it into the conversation.
    // Delivery runs on its own track (in order), so a slow image download never delays the next check-in.
    if (!skipDelivery && (stored >= 0 || prev.cursor > 0))
      delivering = delivering.then(() => deliver($, msgs, leader, actingLeader)).catch(() => {})
    const cursor = Math.max(since, Number(data.cursor) || 0)
    await $.store.set(cursorKey(), cursor)
    const epoch = Number(data.chatEpoch ?? 0)
    await update($, snapshot, s => ({
      connected: true,
      error: '',
      cursor,
      leader,
      acting: actingLeader,
      latest: s.latest ?? null,
      relayVersion: data.version ?? null,
      project: projectName,
      projects: Array.isArray(data.projects) ? data.projects : s.projects, // absent from an older relay
      chatEpoch: epoch,
      // someone pressed Reset chat (the relay's chat epoch moved on): start this chat over too
      feed: (s.chatEpoch === epoch ? [...s.feed, ...msgs.filter(m => !s.feed.some(f => f.id === m.id))] : msgs).slice(-100),
      peers: data.peers ?? [],
      tasks: data.tasks ?? [],
      shared: data.shared ?? [],
      reads: data.reads && typeof data.reads === 'object' ? data.reads : undefined, // absent from an older relay
      keepAwake: data.keepAwake !== false,
    }))
    // a doc shared again under the same name keeps the list the same, but who/when/size change
    if (typeof data.yourKey === 'string' && data.yourKey && data.yourKey !== cfg.key) {
      void rememberKey($, data.yourKey)
      $.ui.toast("crew: you're now on the host's friends list. Your personal key is saved; nothing else to do.", { timeoutMs: 10000 })
    }
    othersEditing = Array.isArray(data.editing) ? data.editing : [] // absent from an older relay
    if (isHosting() && Date.now() - friendsLoadedAt > 10000) {
      friendsLoadedAt = Date.now()
      void loadFriends($) // keeps "seen" and "connected now" current in the Friends card
    }
    sharedFolders = Array.isArray(data.folders) ? data.folders : []
    void autoSyncFolders($).catch(() => {})
    void autoSendCrewshared($).catch(() => {})
    void checkApps($)
    syncDocs($, data.shared ?? [], msgs.some(m => m.kind === 'update' && m.text.startsWith('shared doc ')))
    void syncRules($, data.shared ?? [], msgs.some(m => m.kind === 'update' && m.text.includes(`doc '${RULES_DOC}'`))).catch(() => {})
    failures = 0
    const online = (data.peers ?? []).filter((p: any) => p.online && p.name !== cfg.me).length
    const role = leader === cfg.me ? ' (leader)' : ''
    $.ui.status(`crew: ${cfg.me}${role} · ${online} teammate${online === 1 ? '' : 's'} online`)
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    // Removed by the leader or host: leave (no rejoining on our own), and say so. Join session brings you back.
    if (/relay 401/.test(raw) && isHosting() && (await healHostKey($).catch(() => false))) return // fixed: the next check-in uses it
    const shut = /relay 403: (the project .+ is private.*)$/.exec(raw)
    if (shut && projectName !== 'main') {
      $.ui.toast(`crew: ${shut[1]}. You're back in main.`, { timeoutMs: 10000 })
      void switchProject($, 'main').catch(() => {})
      return
    }
    const removed = /relay 403: (you were removed from the crew session by .+)$/.exec(raw)
    if (removed) {
      joined = false
      await update($, membership, () => 'left' as Membership)
      await $.store.set(`membership:${cfg.base}`, 'left')
      await update($, snapshot, s => ({ ...s, connected: false, error: '' }))
      $.ui.status('crew: not in the crew session (/crew to join)')
      $.ui.toast(`crew: ${removed[1]}. Press Join session in /crew to come back.`, { timeoutMs: 12000 })
      return
    }
    const msg = explain(raw)
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

// Emptying the say/ask/add-task/add-rule fields after Enter. An Input keeps the person's typing until the hook
// draws a different value, so on Enter the field is drawn once with what was sent, then with '' (a change, so it
// empties). Typing itself never redraws: a redraw per keystroke races the typing and jumbles the letters.
const drafts = atom({ plugin: 'crew', key: 'drafts' } as const, {} as Record<string, string>)

// What's being typed, for the wrapped preview above the field. The field itself is never redrawn while typing (that
// jumbled letters once); only the preview is, at most four times a second.
const typingAtom = atom({ plugin: 'crew', key: 'typing' } as const, {} as Record<string, string>)
const typed: Record<string, string> = {}
let typingTimer: ReturnType<typeof setTimeout> | null = null

function setDraft($: EngineInterface, field: string, value: string) {
  typed[field] = value
  if (typingTimer) return
  typingTimer = setTimeout(() => {
    typingTimer = null
    void update($, typingAtom, () => ({ ...typed }))
  }, 250)
}

function submitted($: EngineInterface, field: string, value: string, run: () => unknown) {
  typed[field] = ''
  void update($, typingAtom, t => ({ ...t, [field]: '' }))
  void (async () => {
    await update($, drafts, d => ({ ...d, [field]: value }))
    await new Promise(r => setTimeout(r, 60))
    await update($, drafts, d => ({ ...d, [field]: '' }))
  })()
  return run()
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
  chatTo = target === '*' ? '' : target
  void relay($, 'POST', '/send', { text, to: target === '*' ? 'all' : target, kind: 'request', human: true })
    .then(() => poll($))
    .then(() => $.ui.toast(target === '*' ? 'crew: asked every Claude' : `crew: asked ${target}'s Claude`, { timeoutMs: 4000 }))
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

const docDeleting = atom({ plugin: 'crew', key: 'docDeleting' } as const, '') // which doc's "delete?" is showing

function askDeleteDoc($: EngineInterface, name: string) {
  void update($, docDeleting, () => name)
}

async function deleteDoc($: EngineInterface, name: string) {
  await update($, docDeleting, () => '')
  try {
    await relay($, 'POST', '/shared/delete', { name })
    await update($, docOpen, d => (d.name === name ? { name: '', head: [], more: 0, error: '' } : d))
    docsKey = null // the list changed: fetch who/when again
    await poll($)
    $.ui.toast(`crew: deleted the doc "${name}"`, { timeoutMs: 5000 })
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
}

// A one-time tip: the desktop app sometimes takes a pane button's first click as focus. Not ours to fix.
const tipSeen = atom({ plugin: 'crew', key: 'tipSeen' } as const, false)

function dismissTip($: EngineInterface) {
  void update($, tipSeen, () => true)
  void $.store.set('tip:doubleClick', true)
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

const SYSTEM_KINDS = new Set<CrewMessage['kind']>(['join', 'leave', 'update', 'out', 'back', 'invite', 'deleted'])
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
  // joins, leaves and out/back already name who; updates, invites and deletions say what someone did
  return m.kind === 'update' || m.kind === 'invite' || m.kind === 'deleted' ? `${m.from} ${m.text}` : m.text
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
const blockCache = new Map<any, { Card: any; Callout: any }>()
function blocksFor(Box: any, Text: any) {
  let made = blockCache.get(Box)
  if (!made) blockCache.set(Box, (made = makeBlocks(Box, Text)))
  return made
}
function makeBlocks(Box: any, Text: any) {
  // A card: its own framed box, a bold title (and anything on the right of it), then its content.
  const Card = ({ title, right, children }: any) => (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
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
  return { Card, Callout }
}

// -- tabs, and the Chat tab's view and "To:"

function setTab($: EngineInterface, to: Tab) {
  void update($, tab, () => to).then(() => update($, settingsOpen, () => false))
  if (to === 'docs') void loadFolder($).catch(() => {}) // the Project tab: fresh look at the folder
  if (to === 'crew' && isHosting()) void loadFriends($)
}

function setChatView($: EngineInterface, view: ChatView) {
  void update($, chatView, () => view)
}

// The People view: only what humans typed in /crew (chat, and asks to a Claude).
function peopleOnly(feed: CrewMessage[]) {
  return feed.filter(m => m.human)
}

// The Claudes view: what the Claudes say to each other (requests, replies, updates, images), nothing people typed.
function claudesOnly(feed: CrewMessage[]) {
  return feed.filter(m => !m.human && ['chat', 'request', 'update', 'image'].includes(m.kind))
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
  if (field === 'key' && value.trim()) void $.store.set(`keyFor:${cfg.base}`, value.trim()).catch(() => {})
  // Still setting up: Settings comes up open once you're in, so you can check it all before closing it.
  if (!cfg.configured) void update($, settingsOpen, () => true)
  void $.config
    .set({ key: `crew.${field}`, value: value.trim() })
    .then(r => $.ui.toast(r.deny ? `crew: ${r.deny}` : `crew: saved ${field}`))
    .catch(err => $.ui.toast(`crew: couldn't save ${field} (${err instanceof Error ? err.message : err})`, { timeoutMs: 10000 }))
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

function crewLogPress($: EngineInterface) {
  void crewLogOut($).then(text => $.ui.toast(`crew: ${text}`, { timeoutMs: 8000 }))
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
  // Started through WMI, the relay's window belongs to Windows rather than to Claude, so it survives the host
  // restarting Claude (anything Claude starts itself is closed along with it). If WMI can't, Start-Process opens the
  // .bat in its own console. (cmd's `start` lets the window inherit our output pipes, so the run never finishes and
  // its timeout kills the relay.)
  const server = `${$.plugin.root.replace(/\//g, '\\')}\\server`
  const launch =
    `$s = '${server}'; try { ` +
    `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]1 }; ` +
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ ` +
    `CommandLine = 'cmd.exe /c "' + $s + '\\start-relay.bat"'; CurrentDirectory = $s; ProcessStartupInformation = $si }; ` +
    `if ($r.ReturnValue -ne 0) { throw 'wmi' } } catch { Start-Process -FilePath ($s + '\\start-relay.bat') -WorkingDirectory $s }`
  try {
    const r = await $.process.run(['powershell', '-NoProfile', '-Command', launch], { timeoutMs: 20000 })
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
  if (cfg.key !== key) await rememberKey($, key)
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

const stopAsk = atom({ plugin: 'crew', key: 'stopAsk' } as const, false)

function stopHostingPress($: EngineInterface) {
  void update($, stopAsk, () => false)
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

function invite(ip: string, key: string, name = '') {
  return (
    `Join my Claude crew!\n` +
    `1. Install (once): claude plugin marketplace add Umbyzz/claude-crew, then claude plugin install crew@claude-crew, then restart Claude\n` +
    `2. Be on the same Radmin VPN / Tailscale network as me\n` +
    `3. In Claude: /crew > Settings, and save (press Enter in each field):\n` +
    `   Relay URL: http://${ip || '<my IP>'}:7777\n` +
    `   Crew key: ${key}` +
    (name ? `\n   Your name: ${name} (exactly this: the key only works with this name)` : '')
  )
}

// 🔑 New crew key (the host only): the relay makes a new key, the old one stops working at once, and the new
// invite is copied, so whoever still belongs can rejoin. For a teammate who left, or an invite that went astray.
const keyAsk = atom({ plugin: 'crew', key: 'keyAsk' } as const, false)

function askNewKey($: EngineInterface, show: boolean) {
  void update($, keyAsk, () => show)
}

async function newCrewKey($: EngineInterface, surface: any) {
  await update($, keyAsk, () => false)
  try {
    const r = await relay($, 'POST', '/key/rotate', {})
    const fresh = String(r.key ?? '')
    if (!fresh) throw new Error('the relay sent no key back')
    const refused = await rememberKey($, fresh) // from now on, with the new key
    if (refused) $.ui.toast(`crew: the new key works, but Settings didn't save it (${refused}). Crew keeps its own copy, so you're fine.`, { timeoutMs: 10000 })
    await update($, hostInfo, h => ({ ...h, key: fresh }))
    copyInvite($, surface, (await read($, hostInfo)).ip, fresh)
    $.ui.toast('crew: new crew key made. The old one no longer works; send the new invite to whoever should be in.', { timeoutMs: 10000 })
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
}

// Friends (the host only): each gets a personal key tied to their name, so nobody can pose as them, and removing
// one stops only their key. "Friends only" then turns the shared crew key off.
type Friend = { name: string; key: string; seen: number; ip: string; online: boolean }
const friendsAtom = atom({ plugin: 'crew', key: 'friends' } as const, { list: [] as Friend[], friendsOnly: false })

async function friendCall($: EngineInterface, path: string, body: unknown) {
  const r = await relay($, 'POST', path, body)
  await update($, friendsAtom, () => ({ list: r.friends ?? [], friendsOnly: Boolean(r.friendsOnly) }))
  return r
}

async function loadFriends($: EngineInterface) {
  try {
    await friendCall($, '/friends/list', {})
  } catch {}
}

async function addFriend($: EngineInterface, surface: any, raw: string) {
  const name = raw.trim()
  if (!name) return
  try {
    const r = await friendCall($, '/friends/add', { name })
    const f = (r.friends ?? []).find((x: Friend) => x.name === name)
    if (f) copyInvite($, surface, (await read($, hostInfo)).ip, f.key, name)
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
}

// ★ Friend: the person is connected right now, so their key goes straight to their plugin. No typing, no wrong Timmy.
async function makeFriend($: EngineInterface, name: string, ip: string) {
  try {
    await friendCall($, '/friends/add', { name })
    await poll($)
    $.ui.toast(`crew: ${name}${ip ? ` (from ${ip})` : ''} is a friend now. Their personal key reaches them on their next check-in.`, { timeoutMs: 9000 })
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
}

const friendRm = atom({ plugin: 'crew', key: 'friendRm' } as const, '') // whose "remove?" is showing
let friendsLoadedAt = 0

async function removeFriend($: EngineInterface, name: string) {
  await update($, friendRm, () => '')
  try {
    await friendCall($, '/friends/remove', { name })
    $.ui.toast(`crew: removed ${name}. Their key no longer works; everyone else is unaffected.`, { timeoutMs: 8000 })
  } catch (err) {
    $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 })
  }
}

function copyInvite($: EngineInterface, surface: any, ip: string, key: string, name = '') {
  const text = invite(ip, key, name)
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

// Messages this chat's Claude was already handed (a message to you reaches you in any project): a catch-up skips them.
const deliveredIds = new Set<number>()

// A long message reads as its start in a catch-up; crew_status has every message in full.
function clip(text: string, max = 280) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}… (crew_status has the rest)` : one
}

// A Claude (re)joining a crew session gets a briefing in its conversation: who leads, what's open, what was said.
async function catchUp($: EngineInterface, lastSeen = 0) {
  const data = await relay($, 'GET', '/poll?since=0')
  const tasks: CrewTask[] = (data.tasks ?? []).filter((t: CrewTask) => t.status !== 'done')
  // people's /crew chat stays out of the briefing too, like it stays out of live delivery
  const stale = (m: CrewMessage) => ['out', 'back'].includes(m.kind) && Date.now() / 1000 - m.at > 6 * 3600
  const all: CrewMessage[] = (data.messages ?? []).filter(
    (m: CrewMessage) =>
      !['join', 'leave', 'invite', 'deleted'].includes(m.kind) && !(m.human && m.kind === 'chat') && !stale(m) && !deliveredIds.has(m.id),
  )
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
            `<crew-catchup>\nYou just (re)joined the crew session as "${cfg.me}"` +
            (projectName !== 'main' ? `, in project "${projectName}"` : '') +
            `. Here is where things stand.\n\n` +
            `Open tasks:\n${tasks.map(fmtTask).join('\n') || '(none)'}\n\n` +
            `${lastSeen > 0 ? 'Crew messages since you were last here' : 'Recent crew messages'} (oldest first):\n` +
            `${msgs.map(m => `[${clockTime(m.at)}] ${clip(line(m))}`).join('\n') || '(nothing new)'}\n` +
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
  const keyNote = /relay 401: (that key belongs to .+|.+ has a personal key.*|this crew is friends-only.*)$/.exec(msg)
  if (keyNote) return `${keyNote[1][0].toUpperCase()}${keyNote[1].slice(1)}.`
  if (/relay 401/.test(msg))
    return "The relay refused the crew key. The host may have made a new one: paste the key from their new invite in ⚙ Settings → Crew key."
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
  if (isHosting()) void loadFriends($)
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
        id: { type: 'string', description: 'task number, like "3" or "T3" (every action but add)' },
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
    name: 'crew_share_folder',
    description:
      'Shared folders: give every teammate a copy of a folder inside the project folder (source, assets, references), ' +
      'copied by the plugin with no tokens and kept in sync when it changes. action "share" (default) shares or updates ' +
      'one of yours; "get" fetches a teammate\'s onto this PC (and follows their updates); "stop" stops sharing yours or ' +
      'stops syncing theirs. Then read it locally with Read/Grep.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'the folder: its path inside the project folder (e.g. "source") or an absolute path inside it' },
        action: { type: 'string', enum: ['share', 'get', 'stop'] },
      },
      required: ['path'],
    },
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
  {
    name: 'crew_project',
    description:
      'Crew projects: each has its own chat, task board, shared docs and leader. With no name, lists the projects ' +
      '(open tasks, who is in each). With a name, moves this session into that project (a new name starts one). ' +
      'Only switch when your user asks.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'the project to move into (omit to list them)' } },
    },
  },
]

// Settings saved under the plugin's old name. The desktop app used to hand crew to Claude Code as a local plugin
// ("crew@inline"); since October 2026 Claude Code loads it as installed ("crew@claude-crew"), which starts with no
// settings of its own. Reading the old ones means nobody sets crew up twice, and a friend's personal key isn't lost.
async function oldOptions($: EngineInterface): Promise<Record<string, unknown> | null> {
  try {
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
    const all = JSON.parse(String(await $.fs.read(`${home}\\.claude\\settings.json`))).pluginConfigs ?? {}
    for (const [id, c] of Object.entries(all) as [string, any][]) {
      const o = c?.options
      if ((id === 'crew' || id.startsWith('crew@')) && o?.relayUrl && o?.name && o?.key) return o
    }
  } catch {
    // no settings file, or not readable: set up in /crew as usual
  }
  return null
}

// And what crew remembered under the old name (the projects home, each project's folder, synced folders, chat
// positions): copied once into this name's store, never over anything it already has.
// Read with PowerShell, like the rest of crew's file work: reading that file through $.fs failed quietly on a real PC.
const OLD_STORE_PS =
  `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ` +
  `$f = Get-ChildItem "$env:USERPROFILE\\.claude\\plugins\\store\\crew_inline-*.json" -ErrorAction SilentlyContinue | ` +
  `Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($f) { Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 }`

async function adoptOldStore($: EngineInterface) {
  if ((await $.store.get('oldStoreCopied').catch(() => true)) !== undefined) return
  const r = await $.process.run(['powershell', '-NoProfile', '-Command', OLD_STORE_PS], { timeoutMs: 20000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return // couldn't look: try again next time
  try {
    const text = r.stdout.trim()
    const old = (text ? JSON.parse(text) : {}) as Record<string, unknown>
    for (const [k, v] of Object.entries(old)) if ((await $.store.get(k)) === undefined) await $.store.set(k, v as any)
  } catch {
    // an unreadable old store won't get better: leave it
  }
  await $.store.set('oldStoreCopied', true).catch(() => {})
}

export const register: Register = (on, options) => {
  let base = '', me = '', key = '', pollMs = 3000, configured = false, clawdsWithCrew = true
  let autoRun: Config['autoRun'] = 'leader', toasts: Config['toasts'] = 'all'
  const apply = (opts: Record<string, unknown>) => {
    base = String(opts.relayUrl ?? '').trim().replace(/\/+$/, '')
    me = String(opts.name ?? '').trim()
    key = String(opts.key ?? '')
    autoRun = (['off', 'leader', 'anyone'].includes(String(opts.autoRun)) ? opts.autoRun : 'leader') as Config['autoRun']
    toasts = (['all', 'direct', 'off'].includes(String(opts.toasts)) ? opts.toasts : 'all') as Config['toasts']
    pollMs = Math.max(1, Number(opts.pollSeconds) || 3) * 1000
    configured = base !== '' && me !== '' && key !== ''
    clawdsWithCrew = String(opts.clawdsWindow ?? 'yes') !== 'no'
    dropMs = Math.max(15, Number(opts.dropSeconds) || 120) * 1000
    cfg = { base, me, key, autoRun, toasts, pollMs, configured }
  }
  apply(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    // Commands first, each on its own: if anything later fails, /crew is still there to show what went wrong.
    const problems: string[] = []
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch (err) {
        problems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (!configured) {
      const old = await oldOptions($)
      if (old) {
        apply({ ...(options as Record<string, unknown>), ...old })
        // and saved under the new name, so the settings menu shows them (a refused save changes nothing: they're
        // read from the old name again next time)
        for (const field of ['relayUrl', 'name', 'key'])
          void $.config.set({ key: `crew.${field}`, value: String(old[field]) }).catch(() => {})
      }
    }
    await adoptOldStore($)
    void refreshModel($)
    await storedKey($) // the key that last worked, even if a settings save was refused
    await attempt('/crew', () => $.command.register({ name: 'crew', description: 'Open the crew pane: leader, teammates, tasks, chat and settings' }))
    await attempt('/clawds', () => $.command.register({ name: 'clawds', description: 'Open the Clawds window: your crew as little pixel friends (uses no tokens)' }))
    await attempt('/crewlog', () => $.command.register({ name: 'crewlog', description: "Open the crew log window: every crew message live, the Claudes' requests and replies too (uses no tokens)" }))
    // A new desktop chat builds its slash menu before this hook runs: ask for the command list to be read again,
    // so /crew can show up without typing it once in full (if the surface listens; typing it always works).
    try {
      $.ui.invalidate('command.describe')
    } catch {
      // nothing to refresh on this surface
    }
    for (const tool of TOOLS) await attempt(tool.name, () => $.tool.register(tool))
    if (problems.length) {
      $.ui.toast(`crew: couldn't set up ${problems.length} part(s): ${problems.join(' · ')}`.slice(0, 400), { timeoutMs: 20000 })
      $.ui.status(`crew: setup problem (${problems[0].slice(0, 60)})`)
    }
    void checkUpdate($)
    $.clock.every(SIX_HOURS, () => void checkUpdate($))
    if (!configured) {
      $.ui.status('crew: not set up (/crew → Settings)')
      return next(e)
    }
    // Which project: this session's own (survives reloads), else the one last used in this folder, else main.
    sessionCwd = String((e as any).cwd ?? '')
    const own = await read($, projectAtom)
    // "Open it in a new chat" from an invite: a brand-new chat (opened within the hour) starts in that project.
    const planned = (await $.store.get(`nextChat:${base}`).catch(() => undefined)) as { project?: string; at?: number; lead?: boolean } | undefined
    const pending = !own && planned?.project && Date.now() - Number(planned.at ?? 0) < 3600000 ? String(planned.project) : ''
    if (pending) await $.store.set(`nextChat:${base}`, null).catch(() => {})
    projectName = own || pending || String((await $.store.get(`project:${base}:${sessionCwd}`)) ?? '') || 'main'
    await update($, projectAtom, () => projectName)
    // so this Claude knows the project's folder from the start: one under the projects home if it has none yet, not the
    // chat's own workspace (a chat opened for a project from an invite used to end up there)
    void homeFolderFor($).catch(() => {})
    const kept = (await $.store.get(`invite:${base}`).catch(() => undefined)) as { from?: string; project?: string } | null | undefined
    if (kept?.project && kept.project !== projectName) {
      const busy = (await $.session.turns().catch(() => 0)) > 0
      await update($, inviteAtom, () => ({ from: String(kept.from ?? ''), project: String(kept.project), busy }))
    }
    // In the crew or not? This session's answer wins (it survives reloads); a brand-new Claude
    // session that was in the crew last time asks first instead of silently rejoining.
    let m = await read($, membership)
    if (!m) {
      const before = await $.store.get(`membership:${base}`)
      // a chat you opened for a project goes straight in; first setup too
      m = before === 'joined' && !pending ? 'ask' : before === 'left' && !pending ? 'left' : 'joined'
      await update($, membership, () => m)
      if (m === 'joined') await $.store.set(`membership:${base}`, 'joined')
    }
    joined = m === 'joined'
    if (m === 'ask') {
      $.ui.status('crew: rejoin the crew session? (open /crew)')
      $.ui.toast('crew: you were in a crew session. Open /crew to rejoin or leave it.', { timeoutMs: 10000 })
    } else if (m === 'left') {
      $.ui.status('crew: not in the crew session (/crew to join)')
    } else if (pending && planned?.lead) {
      // opened to make a new project: whoever makes a project leads it
      void (async () => {
        await poll($)
        await relay($, 'POST', '/leader', { name: cfg.me })
        await poll($)
        $.ui.toast(`crew: made "${pending}" in this new chat, and you lead it. Press "Invite the crew here" to bring the others.`, { timeoutMs: 10000 })
      })().catch(() => {})
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
    void rememberChat($) // this chat is in use in its project: "you already have a chat for it" knows when
    working = true
    void refreshModel($) // /model may have switched it
    void refreshMcp($)
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
    if (!autoPrompts.delete(e.text)) {
      wakes = [] // the person typed: the loop brake resets
      braked = false
    }
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
    noteMcp(String(e.tool))
    const locked = fileLock($, e) // subagents' edits count too
    if (locked) return locked
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
    return { sections: [...composed.sections, { id: 'crew:role', text: roleText(s.leader, s.peers, s.acting ?? null) + crewExtras(s), scope: 'session' as const }] }
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
      `${p.name}${p.leader ? ' (leader)' : ''}${p.acting ? ' (acting leader)' : ''}: ${!p.online ? 'offline' : p.activity === 'out' ? 'OUT OF TOKENS' : p.activity}` +
      (p.version ? ` · crew ${p.version}${versionMark(p.version)}` : '') +
      (p.model ? ` · ${modelLabel(p.model)}` : '') +
      (p.usageDetail ? ` · usage ${p.usageDetail}` : p.usage != null ? ` · ${p.usage}% usage used` : '') +
      (p.mcp ? ` · connected to ${p.mcp}` : '') +
      (p.friend ? ' · friend (personal key)' : '') +
      (editingNow(p.name) ? ` · editing ${editingNow(p.name)?.path}` : '')
    const openTasks = s.tasks.filter(t => t.status !== 'done')
    const mine = openTasks.filter(t => t.owner === me || (!t.owner && t.assignee === me)).length
    const onlineNow = s.peers.filter(p => p.online).length
    return ok(
      [
        `Summary: ${onlineNow} online · ${openTasks.length} open task${openTasks.length === 1 ? '' : 's'} (${mine} yours) · leader ${s.leader ?? 'none'}`,
        `You are "${me}", in project "${projectName}"` +
          ((s.projects ?? []).length > 1 ? ` (others: ${(s.projects ?? []).filter(p => p.name !== projectName).map(p => p.name).join(', ')}; crew_project lists or switches)` : '') +
          `. Leader: ${s.leader ?? 'none'}. Plugin ${VERSION}` +
          (newer(s.latest, VERSION) ? ` (update ${s.latest} available)` : '') +
          `, relay ${s.relayVersion ?? 'unknown'}.`,
        `Crew: ${s.peers.map(peer).join(', ') || 'nobody yet'}`,
        `Tasks:\n${s.tasks.map(fmtTask).join('\n') || '(none)'}`,
        `Shared docs: ${s.shared.join(', ') || '(none)'}`,
        `Shared folders: ${sharedFolders.map(f => `${f.name} (from ${f.by}, ${f.files} files, ${mb(f.bytes)}${f.by !== me ? (wantedFolders.get(f.name) ? ', synced here' : ', not fetched here') : ''})`).join(', ') || '(none)'}`,
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

  on('tool.call', { tool: 'mcp__crew__crew_share_folder' }, async ($, e: any) => {
    if (!joined) return ok("You're not in the crew session right now; ask the user to join it from /crew.")
    return ok(await folderTool($, e))
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
  on('tool.call', { tool: 'mcp__crew__crew_project' }, async ($, e: any) => {
    if (!joined) return ok("You're not in the crew session right now; ask the user to join it from /crew.")
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (name) {
      const before = ((await relay($, 'GET', '/projects')).projects ?? []).map((p: any) => p.name)
      await switchProject($, name)
      if (!before.includes(projectName)) {
        await relay($, 'POST', '/leader', { name: me }).catch(() => {})
        await poll($)
        return ok(`Made the crew project "${projectName}" and moved this session into it. You lead it, and it's members-only: only you see it until you add people (the + buttons in /crew → Project).`)
      }
      return ok(`This session is now in crew project "${projectName}". A catch-up on it follows in the conversation.`)
    }
    await syncProject($)
    const { projects } = await relay($, 'GET', '/projects')
    const rows = (projects as any[]).map(
      p =>
        `${p.name === projectName ? '→ ' : '  '}${p.name}: leader ${p.leader ?? 'none'}, ${p.openTasks} open task${p.openTasks === 1 ? '' : 's'}, ` +
        `${p.docs} doc${p.docs === 1 ? '' : 's'}${p.here.length ? `, here now: ${p.here.join(', ')}` : ''}`,
    )
    return ok(`Crew projects (→ is this session's):\n${rows.join('\n')}\nSome projects are members-only: ask a member to add you.`)
  }).catch(failed)

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
    const askingKey = await read($, keyAsk)
    const removingFriend = await read($, friendRm)
    void (await read($, nextChatAtom)) // pressing the button redraws; the saved mark decides, so a new chat that took it clears this one too
    const nextChat = String(((await $.store.get(`nextChat:${cfg.base}`).catch(() => null)) as any)?.project ?? '')
    const renamingName = await read($, renaming)
    const stoppingHost = await read($, stopAsk)
    const keepAwake = s.keepAwake !== false
    const confirming = await read($, confirmReset)
    const note = await read($, updateNote)
    const hostMsg = await read($, hostNote)
    const pinned = await read($, pins)
    const proposedLeader = await read($, pendingLeader)
    const joining = await read($, joinMode)
    const open = s.tasks.filter(t => t.status !== 'done')
    const others = s.peers.filter(p => p.name !== me).map(p => p.name).sort()
    const clearing = (await read($, confirmClear)) && open.length > 0
    // the chat's "To:": the people (''), or a teammate's Claude while they're still in the crew
    const askPick = await read($, askTo)
    const askTarget = askPick && others.includes(askPick) ? askPick : ''
    const names = [...new Set([...s.peers.map(p => p.name), ...(me ? [me] : [])])].sort()
    const online = s.peers.filter(p => p.online).length
    const inSession = configured && member === 'joined'
    const hasUpdate = newer(s.latest, VERSION)
    const leaving = inSession && (await read($, confirmLeave))
    const current: Tab | 'settings' = showSettings ? 'settings' : await read($, tab)
    const view = await read($, chatView)
    // Shared docs, newest first. Details arrive a moment after the names; until then, the names alone.
    const meta = await read($, docList)
    const peek = await read($, docOpen)
    const folder = await read($, folderView)
    const kicking = await read($, kickPending)
    const home = configured ? await projectsHome($) : ''
    const folderMode = await read($, folderModeAtom)
    const invite = await read($, inviteAtom)
    const asked = await read($, moveAsk)
    // asked to move: does this PC already have a chat in that project?
    const otherChat = asked.project ? await otherChatFor($, asked.project) : null
    const deletingDoc = await read($, docDeleting)
    const draft = await read($, drafts)
    const typingNow = await read($, typingAtom)
    const justMade = await read($, madeFolder)
    const thisProject = (s.projects ?? []).find(p => p.name === projectName)
    const friendList = await read($, friendsAtom)
    const jobs = await read($, folderJobs)
    const rulesLines = rules.project === projectName ? rules.text.split('\n').filter(l => l.trim()) : []
    const showTip = configured && !(await read($, tipSeen)) && !(await $.store.get('tip:doubleClick'))
    const deleting = await read($, deleteStage)
    const menuOpen = await read($, projectMenu)
    const section = await read($, projectSection)
    // the project folder's own subfolders: Crewshared and Crewleader show under Shared folders instead
    const projectDirs = folder.dirs.filter(d => d !== CREWSHARED && d !== CREWLEADER)
    // teammates' shared folders this PC hasn't taken yet (Crewshared drops arrive by themselves)
    const toGet = sharedFolders.filter(f => f.by !== me && !f.name.startsWith(`${CREWSHARED}/`) && wantedFolders.get(f.name) !== true).length
    const binnable = deleting.stage > 0 ? await deletableFolder($, deleting.name) : ''
    const keptFolder = deleting.stage > 0 ? String((await $.store.get(`folder:${cfg.base}:${deleting.name}`)) ?? '') : ''
    const elsewhere = s.peers.filter(p => p.online && p.name !== me && (p.project ?? 'main') !== projectName).map(p => p.name)
    const projectNames = [...new Set(['main', projectName, ...(s.projects ?? []).map(p => p.name)])]
    const projectRows = [
      ...(s.projects ?? []),
      ...projectNames.filter(n => !(s.projects ?? []).some(p => p.name === n)).map(n => ({ name: n, leader: null, openTasks: 0, docs: 0, here: [] as string[] })),
    ]
    const here = s.peers.filter(p => p.online && (p.project ?? 'main') === projectName).map(p => p.name)
    // Who has a chat open in a project, by name. "2 here" left people guessing whether one of those was them in
    // another chat, so you show as "you (this chat)" or "you (another chat)".
    const whoIn = (name: string, there: string[]) => [
      ...(name === projectName ? ['you (this chat)'] : there.includes(me) ? ['you (another chat)'] : []),
      ...there.filter(n => n !== me),
    ]
    const hereNow = whoIn(projectName, thisProject?.here ?? here)
    const canKick = s.leader === me || isHosting() // the relay checks this too
    const docs: DocMeta[] = s.shared
      .map(n => meta.docs.find(d => d.name === n) ?? { name: n, by: '', at: 0, size: 0 })
      .sort((a, b) => b.at - a.at)
    // The notices above the tabs, and how many rows they take, so a tab's card fits in what's left.
    const leaderAsk = inSession && proposedLeader !== '' && proposedLeader !== (s.leader ?? '')
    const relayOld = inSession && !!s.relayVersion && s.relayVersion !== VERSION
    const hostingDown = configured && isHosting() && !s.connected
    const noticeRows =
      (leaving ? 6 : 0) + (pinned.length ? pinned.length + 2 : 0) + (leaderAsk ? 5 : 0) + (inSession && s.error ? 3 : 0) +
      (member === 'ask' ? 5 : 0) + (hasUpdate ? 5 : 0) + (relayOld ? 1 : 0) + (hostingDown ? 4 : 0)
    // left for a tab's body: the header (2), the tab row (2) and the card's frame and title (3) come off the top
    const body = Math.max(6, (e.viewport?.rows ?? 30) - 7 - noticeRows)
    // the chat also keeps rows for its To: and message fields (3) and a read receipt (1)
    const room = Math.max(6, body - 4 - (confirming ? 7 : 0))
    const bubbleCols = Math.floor((e.viewport?.columns ?? 80) * 0.65)
    const feed = view === 'people' ? peopleOnly(s.feed) : view === 'claudes' ? claudesOnly(s.feed) : s.feed
    const chat = fitChat(chatItems(feed, me), room, bubbleCols)
    const lastMine = [...chat].reverse().find(i => i.type === 'group' && i.mine)
    const seen = lastMine?.type === 'group' ? receipt(lastMine.msgs[lastMine.msgs.length - 1], s, me) : ''
    const taskRows = Math.max(3, body - 3 - (clearing ? 4 : 0))
    const docRows = Math.max(3, body - 1 - (peek.name ? 12 : 0))
    const activityWord = (p: CrewSnapshot['peers'][number]) =>
      !p.online ? 'offline' : p.activity === 'out' ? 'out of tokens' : p.activity === 'idle' ? '' : p.activity

    // Made once and reused: a component defined fresh on every draw counts as a new kind of element, so
    // everything inside it was rebuilt on each redraw, and a click could land on a Button already replaced.
    const { Card, Callout } = blocksFor(Box, Text)
    // a tab in the row under the header (a plain call, not a component, for the same reason)
    const tabButton = (id: Tab | 'settings', label: string, press: () => void) => (
      <Button key={id === 'settings' ? 'settings' : `tab-${id}`} label={label} variant={current === id ? 'primary' : undefined} dimColor={current !== id} onPress={press} />
    )
    // a collapsed section's one-line header in the Project tab: ▸/▾, its name and count, and a dim hint
    const sectionHead = (id: ProjectSection, label: string, hint = '') => (
      <Box flexDirection="row">
        <Button key={`section-${id}`} label={`${section === id ? '▾' : '▸'} ${label}`} plain onPress={() => toggleSection($, id)} />
        {hint !== '' && (
          <Text dimColor>
            {'  '}
            {hint}
          </Text>
        )}
      </Box>
    )

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
                  ? `project ${projectName} · ${s.connected ? `${online} online` : 'offline'} · leader ${s.leader ?? 'none'} · ${isHosting() ? 'you host' : base.replace(/^https?:\/\//, '')} · v${VERSION}`
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
            {configured && <Button key="crew-log" label="Log" onPress={() => crewLogPress($)} />}
            {inSession && !leaving && <Button key="leave" label="Leave…" onPress={() => askLeave($, true)} />}
            {configured && member === 'left' && <Button key="join" label="Join session" variant="primary" onPress={() => joinPress($)} />}
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
        {nextChat !== '' && (
          <Callout>
            <Text bold>📌 Next: start a new chat (+ New session in the sidebar)</Text>
            <Text dimColor>It opens straight in "{nextChat}" with a catch-up on the project. This chat stays where it is, with its own work.</Text>
            <Box flexDirection="row">
              <Button key="nextchat-cancel" label="Cancel" dimColor onPress={() => void cancelNextChat($)} />
            </Box>
          </Callout>
        )}
        {inSession && invite.project !== '' && invite.project !== projectName && (
          <Callout>
            <Text bold>{invite.from} invites you to the project "{invite.project}"</Text>
            {invite.busy ? (
              <Text dimColor>
                ⚠ This chat already has other work. Switching moves its Claude into "{invite.project}" (with a catch-up); a new chat keeps the two apart.
              </Text>
            ) : (
              <Text dimColor>Switching is just for you: you'll see that project's chat, tasks and docs, and your Claude gets a catch-up.</Text>
            )}
            <Box flexDirection="row">
              {invite.busy && <Button key="invite-newchat" label="Open it in a new chat" variant="primary" onPress={() => void inviteInNewChat($)} />}
              <Button key="invite-accept" label={invite.busy ? 'Switch this chat' : `Switch to ${invite.project}`} variant={invite.busy ? undefined : 'primary'} onPress={() => answerInvite($, true)} />
              {!invite.busy && <Button key="invite-newchat" label="Open it in a new chat" dimColor onPress={() => void inviteInNewChat($)} />}
              <Button key="invite-dismiss" label="Not now" onPress={() => answerInvite($, false)} />
            </Box>
          </Callout>
        )}
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
        {leaderAsk && (
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
        {relayOld && (
          <Box flexDirection="row">
            <Text dimColor>
              Relay {s.relayVersion} ≠ plugin {VERSION}:{' '}
              {newer(VERSION, s.relayVersion) ? (isHosting() ? "you're still running the old relay " : 'the host should restart the relay with the new version') : 'update this plugin'}
            </Text>
            {isHosting() && newer(VERSION, s.relayVersion) && <Button key="restart-relay" label="Restart relay" variant="primary" onPress={() => restartRelayPress($)} />}
          </Box>
        )}
        {/* hosting with the relay down is a notice on every tab; while it runs, the invite lives on the Crew tab */}
        {hostingDown && (
          <Callout>
            <Text bold>You're set up to host, but your relay isn't running</Text>
            <Text dimColor>Press ▶ Start relay (top right) to open start-relay.bat, or join a friend's crew in ⚙ Settings instead.</Text>
            {hostMsg !== '' && !showSettings && <Text dimColor>{hostMsg}</Text>}
          </Callout>
        )}

        {/* -- the tabs: one card at a time. ⚙ Settings is always there; the rest once you're in the crew session */}
        {configured && (
          <Box flexDirection="row" marginTop={1}>
            {inSession && tabButton('chat', 'Chat', () => setTab($, 'chat'))}
            {inSession && tabButton('tasks', `Tasks${open.length ? ` (${open.length})` : ''}`, () => setTab($, 'tasks'))}
            {inSession && tabButton('docs', `📂 ${projectName}`, () => setTab($, 'docs'))}
            {inSession && tabButton('crew', `Crew (${online} online)`, () => setTab($, 'crew'))}
            {tabButton('settings', '⚙ Settings', () => toggleSettings($))}
          </Box>
        )}
        {showTip && (
          <Box flexDirection="row">
            <Text dimColor>💡 Tip: in the desktop app a button sometimes needs a second click (the first can just focus the pane). </Text>
            <Button key="tip-ok" label="Got it" dimColor onPress={() => dismissTip($)} />
          </Box>
        )}
        {configured && !inSession && current !== 'settings' && member === 'left' && (
          <Card title="Not in the crew session">
            <Text dimColor>Press Join session (top right) to see the chat, tasks, docs and crew again.</Text>
          </Card>
        )}

        {/* -- ⚙ Settings: three cards */}
        {current === 'settings' && (
          <Box flexDirection="column">
            <Card
              title="Connection"
              right={
                <Text dimColor>
                  URL {base ? '✓' : '✗'} · name {me ? '✓' : '✗'} · key {key ? '✓' : '✗'}
                </Text>
              }
            >
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
              <Box marginTop={1}>
                <Text dimColor>Or join a friend: paste their Relay URL and Crew key. Press Enter in a field to save it.</Text>
              </Box>
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
              </Box>
              {isHosting() && Select && (
                <Select
                  key="friends-only"
                  label="Who can join "
                  value={friendList.friendsOnly ? 'friends' : 'key'}
                  options={[
                    { value: 'key', label: 'anyone with the crew key' },
                    { value: 'friends', label: 'friends only (personal keys)' },
                  ]}
                  onSelect={(v: string) =>
                    void friendCall($, '/friends/mode', { friendsOnly: v === 'friends' })
                      .then(() => $.ui.toast(v === 'friends' ? 'crew: friends only: the shared crew key no longer gets anyone in' : 'crew: anyone with the crew key can join again', { timeoutMs: 6000 }))
                      .catch(err => $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 }))
                  }
                />
              )}
            </Card>

            <Card title="Preferences">
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
                  key="opt-drop"
                  label="Crewshared check every "
                  value={String(dropMs / 1000)}
                  options={[
                    { value: '30', label: '30s' },
                    { value: '60', label: '1 min' },
                    { value: '120', label: '2 min' },
                    { value: '300', label: '5 min' },
                  ]}
                  onSelect={(v: string) => setOption($, 'dropSeconds', v)}
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
              {Input && (
                <Input
                  key="projects-home-settings"
                  label="New project folders go in "
                  value={home}
                  placeholder="e.g. Documents\Crew projects (each new project gets a folder here)"
                  submitLabel="set"
                  onSubmit={(v: string) => folderPress($, () => setProjectsHome($, v))}
                />
              )}
              <Box flexDirection="row">
                <Text dimColor>{'  '}or </Text>
                <Button key="projects-home-browse" label="Browse…" onPress={() => folderPress($, () => browseProjectsHome($))} />
              </Box>
            </Card>

            <Card
              title="Updates"
              right={
                <Text dimColor>
                  you have {VERSION}
                  {s.latest ? ` · GitHub has ${s.latest}` : ''}
                </Text>
              }
            >
              <Box flexDirection="row">
                <Button key="check-update" label={note.state === 'busy' ? 'Working…' : 'Check for updates'} onPress={() => checkNow($)} />
                {hasUpdate && <Button key="install-settings" label={`Install ${s.latest}`} variant="primary" onPress={() => installPress($)} />}
              </Box>
              {note.text !== '' && <Text color={note.state === 'error' ? 'error' : undefined} dimColor={note.state !== 'error'}>{note.text}</Text>}
            </Card>
          </Box>
        )}

        {/* -- Chat: everything, or only what people typed; one field for the people or a teammate's Claude */}
        {inSession && current === 'chat' && (
          <Card
            title="Chat"
            right={
              !confirming && (
                <Box flexDirection="row">
                  <Button key="view-all" label="Everything" variant={view === 'all' ? 'primary' : undefined} dimColor={view !== 'all'} onPress={() => setChatView($, 'all')} />
                  <Button key="view-people" label="People" variant={view === 'people' ? 'primary' : undefined} dimColor={view !== 'people'} onPress={() => setChatView($, 'people')} />
                  <Button key="view-claudes" label="Claudes" variant={view === 'claudes' ? 'primary' : undefined} dimColor={view !== 'claudes'} onPress={() => setChatView($, 'claudes')} />
                  <Button key="save-chat" label="Save" dimColor onPress={() => saveChatPress($)} />
                  <Button key="reset-chat" label="Reset" dimColor onPress={() => askReset($, true)} />
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
            {feed.length === 0 && (
              <Text dimColor>
                {view === 'people' && s.feed.length
                  ? 'Nothing from people yet. Everything shows the Claudes too.'
                  : view === 'claudes' && s.feed.length
                    ? "The Claudes haven't said anything yet."
                    : 'No messages yet. Say hi!'}
              </Text>
            )}
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
            {/* "Ask a Claude", folded in: pick a teammate's Claude in To:, and the field sends it a request */}
            <Box flexDirection="column" marginTop={1}>
              {others.length > 0 && Select && (
                <Select
                  key="ask-to"
                  label="To "
                  value={askTarget}
                  options={[
                    { value: '', label: "the people (Claudes don't read it)" },
                    { value: '*', label: 'all Claudes (each starts only if its Auto-run allows)' },
                    ...others.map(n => ({ value: n, label: n === s.leader ? `${n}'s Claude ★ leader` : `${n}'s Claude` })),
                  ]}
                  onSelect={(v: string) => setAskTo($, v)}
                />
              )}
              {(() => {
                const now = typingNow[askTarget ? 'ask' : 'say'] ?? ''
                return now.length > 40 ? (
                  <Callout>
                    <Text wrap="wrap">{now}</Text>
                    <Text dimColor>{now.length} characters · Enter sends</Text>
                  </Callout>
                ) : null
              })()}
              {Input &&
                (askTarget ? (
                  <Input
                    key="ask"
                    placeholder={askTarget === '*' ? 'Ask every Claude at once' : `Ask ${askTarget}'s Claude (it starts right away if their Auto-run allows)`}
                    submitLabel="ask"
                    value={draft.ask ?? ''}
                    onInput={(v: string) => setDraft($, 'ask', v)}
                    onSubmit={(v: string) => submitted($, 'ask', v, () => ask($, askTarget, v))}
                  />
                ) : (
                  <Input
                    key="say"
                    placeholder="Message the people (@name to DM)"
                    submitLabel="send"
                    value={draft.say ?? ''}
                    onInput={(v: string) => setDraft($, 'say', v)}
                    onSubmit={(v: string) => submitted($, 'say', v, () => say($, v))}
                  />
                ))}
            </Box>
          </Card>
        )}

        {/* -- Tasks */}
        {inSession && current === 'tasks' && (
          <Card
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
            {open.slice(-taskRows).map(t => (
              <Box flexDirection="row" justifyContent="space-between">
                <Text>• {fmtTask(t)}</Text>
                <Box flexDirection="row">
                  <Button key={`task-done-${t.id}`} label="✓ done" dimColor onPress={() => taskAction($, { action: 'done', id: t.id }, `T${t.id} done`)} />
                  <Button key={`task-rm-${t.id}`} label="✕" dimColor onPress={() => taskAction($, { action: 'remove', id: t.id }, `T${t.id} removed`)} />
                </Box>
              </Box>
            ))}
            {open.length > taskRows && <Text dimColor>…and {open.length - taskRows} more (crew_status shows them all)</Text>}
            {Input && (
              <Box marginTop={1}>
                <Input
                  key="add-task"
                  placeholder="Add a task (end with @name to assign it)"
                  submitLabel="add"
                  value={draft['add-task'] ?? ''}
                  onInput={(v: string) => setDraft($, 'add-task', v)}
                  onSubmit={(v: string) => submitted($, 'add-task', v, () => addTask($, v))}
                />
              </Box>
            )}
          </Card>
        )}

        {/* -- the Project tab: a short summary card, then collapsed sections (one open at a time, remembered) */}
        {inSession && current === 'docs' && (
          <Box flexDirection="column">
            <Card
              title={`📂 ${projectName}`}
              right={<Button key="new-project-open" label="+ New project" dimColor={folderMode !== 'new'} onPress={() => setFolderMode($, folderMode === 'new' ? '' : 'new')} />}
            >
              {/* -- which project (switching is just for you), who leads it, who's here, who can see it */}
              <Box flexDirection="row">
                {Select && (
                  <Select
                    key="project"
                    label="Working on "
                    value={projectName}
                    options={projectNames.map(n => {
                      const p = (s.projects ?? []).find(x => x.name === n)
                      const who = whoIn(n, p?.here ?? [])
                      const bits = [
                        who.length ? who.join(', ') : '',
                        p?.unread && n !== projectName ? `${p.unread} new` : '',
                        p?.openTasks ? `${p.openTasks} open task${p.openTasks === 1 ? '' : 's'}` : '',
                      ].filter(Boolean)
                      return { value: n, label: bits.length ? `${n} · ${bits.join(' · ')}` : n }
                    })}
                    onSelect={(v: string) => switchProjectPress($, v)}
                  />
                )}
                <Button key="projects-refresh" label="↻" dimColor onPress={() => refreshProjectsPress($)} />
              </Box>
              <Text dimColor>
                {[`led by ${s.leader ?? 'nobody yet (Crew tab)'}`, `here: ${hereNow.join(', ')}`, projectName === 'main' || thisProject?.private ? '' : '🔓 open to the crew']
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {/* members-only: who's in, and adding someone is right here (the same + buttons as Members & access) */}
              {projectName !== 'main' && thisProject?.private && (
                <Box flexDirection="row" justifyContent="space-between">
                  <Text dimColor>🔒 Members only: {(thisProject.members ?? []).join(', ')}</Text>
                  <Button key="member-add-open" label="+ Add someone" dimColor={section === 'members'} onPress={() => openSection($, 'members')} />
                </Box>
              )}
              {projectNames.length <= 1 && <Text dimColor>Everyone starts in 'main': make a project per game or app to keep its chat, tasks and docs apart.</Text>}
              {elsewhere.length > 0 && (
                <Box flexDirection="row" justifyContent="space-between">
                  <Text dimColor>Not here yet: {elsewhere.join(', ')}</Text>
                  {!thisProject?.private && <Button key="invite-here" label="Invite the crew here" dimColor onPress={() => inviteCrew($)} />}
                </Box>
              )}
              {/* asked right here, where the name was typed or Switch pressed */}
              {inSession && asked.project !== '' && (
                <Callout>
                  <Text bold>{asked.isNew ? `Start "${asked.project}" in a new chat?` : `Open "${asked.project}" in a new chat?`}</Text>
                  {otherChat && (
                    <Text bold color="warning">
                      Wait!! You already have a chat for {asked.project} (last used {shortDate(otherChat.at)}). Open it from the sidebar to carry on there.
                    </Text>
                  )}
                  <Text dimColor>
                    ⚠ This chat already has other work. Using it for "{asked.project}" would mix the two, and its Claude would carry all of this chat along (more tokens). A new chat starts clean{asked.isNew ? ', and you lead the project there' : ', with a catch-up'}.
                    {otherChat ? '' : ' Already have a chat for it on another PC? Open that one: each chat stays in its own project.'}
                  </Text>
                  <Box flexDirection="row">
                    <Button key="move-newchat" label="Open it in a new chat" variant={otherChat ? undefined : 'primary'} onPress={() => void moveInNewChat($)} />
                    <Button key="move-here" label="Use this chat" onPress={() => void moveHere($)} />
                    <Button key="move-cancel" label="Cancel" dimColor onPress={() => void update($, moveAsk, () => ({ project: '', isNew: false }))} />
                  </Box>
                </Callout>
              )}
              {nextChat !== '' && asked.project === '' && (
                <Callout>
                  <Text bold>📌 Next: start a new chat (+ New session in the sidebar)</Text>
                  <Text dimColor>It opens straight in "{nextChat}". This chat stays in "{projectName}".</Text>
                </Callout>
              )}
              {folderMode === 'new' && (
                <Callout>
                  {Input && (
                    <Input key="new-project" label="Name " placeholder="e.g. lava rush, then Enter" submitLabel="create" autoFocus onSubmit={(v: string) => newProjectPress($, v)} />
                  )}
                  {home ? (
                    <Text dimColor>Its folder goes in {shortPath(home)}.</Text>
                  ) : (
                    <Box flexDirection="column">
                      <Text>New project folders go in:</Text>
                      <Box flexDirection="row">
                        <Button key="home-default" label={`Documents\\Crew projects`} variant="primary" onPress={() => folderPress($, () => setProjectsHome($, `${userHome}\\Documents\\Crew projects`))} />
                        <Button key="home-choose" label="Choose…" onPress={() => folderPress($, () => browseProjectsHome($))} />
                        <Button key="home-paste" label="Paste a path" dimColor onPress={() => setFolderMode($, 'home')} />
                      </Box>
                    </Box>
                  )}
                </Callout>
              )}
              {folderMode === 'home' && Input && (
                <Input key="projects-home" label="New project folders go in " value={home} placeholder="paste a folder path, then Enter" submitLabel="set" autoFocus onSubmit={(v: string) => folderPress($, () => setProjectsHome($, v).then(() => setFolderMode($, 'new')))} />
              )}

              {/* -- your folder for it, on this PC only: Open, and everything else behind ⋯ */}
              <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
                <Text wrap="truncate-middle">📁 {folder.path === '' ? 'No folder yet: ⋯ → Use a different folder…' : shortPath(folder.path)}</Text>
                <Box flexDirection="row">
                  {folder.path !== '' && <Button key="folder-open" label="Open" variant={folderMode === 'new' ? undefined : 'primary'} onPress={() => openInExplorer($, folder.path)} />}
                  <Button
                    key="folder-change-open"
                    label="⋯"
                    dimColor={folderMode !== 'change' && folderMode !== 'sub'}
                    onPress={() => setFolderMode($, folderMode === 'change' || folderMode === 'sub' ? '' : 'change')}
                  />
                </Box>
              </Box>
              {(folderMode === 'change' || folderMode === 'sub') && (
                <Box flexDirection="column">
                  <Box flexDirection="row" flexWrap="wrap">
                    {folder.path !== '' && <Button key="folder-copy" label="Copy path" dimColor onPress={() => copyPath($, e.surface, folder.path)} />}
                    {folder.path !== '' && <Button key="folder-sub-open" label="+ Folder" dimColor={folderMode !== 'sub'} onPress={() => setFolderMode($, folderMode === 'sub' ? 'change' : 'sub')} />}
                    <Button key="folder-browse" label="Use a different folder…" dimColor onPress={() => folderPress($, () => browseProjectFolder($))} />
                    {folder.path !== '' && <Button key="folder-refresh" label="↻ Refresh" dimColor onPress={() => folderPress($, () => loadFolder($))} />}
                  </Box>
                  {folderMode === 'sub' && Input && (
                    <Input key="folder-new" label="New folder " placeholder="name, then Enter" submitLabel="make" autoFocus onSubmit={(v: string) => folderPress($, () => newFolder($, v))} />
                  )}
                  {folderMode === 'change' && Input && (
                    <Input key="folder-set" label="Or paste a folder " placeholder="a folder path, then Enter" submitLabel="use" onSubmit={(v: string) => folderPress($, () => setFolder($, v).then(() => setFolderMode($, '')))} />
                  )}
                  {folderMode === 'change' && sessionCwd !== '' && folder.path !== sessionCwd && (
                    <Button key="folder-use-chat" label="Use the folder this chat is open in" dimColor onPress={() => folderPress($, () => useChatFolder($).then(() => setFolderMode($, '')))} />
                  )}
                </Box>
              )}
              {folder.error !== '' && <Text color="error">{folder.error}</Text>}
              {folder.note !== '' && <Text dimColor>{folder.note}</Text>}
              {justMade !== '' && justMade.startsWith(`${folder.path}\\`) && (
                <Box flexDirection="row">
                  <Text dimColor>Made "{justMade.split('\\').pop()}" by mistake? </Text>
                  <Button key="folder-undo" label="↶ Undo" dimColor onPress={() => folderPress($, () => undoFolder($))} />
                </Box>
              )}
              {/* its subfolders; Crewshared and Crewleader live under Shared folders below */}
              {projectDirs.length > 0 && (
                <Box flexDirection="row" flexWrap="wrap">
                  {projectDirs.slice(0, 6).map(d => (
                    <Button key={`dir-${d}`} label={`📁 ${d}`} plain onPress={() => openInExplorer($, `${folder.path}\\${d}`)} />
                  ))}
                  {projectDirs.length > 6 && <Text dimColor> +{projectDirs.length - 6} more</Text>}
                </Box>
              )}
            </Card>

            {/* -- the rest, one line each until you open it */}
            <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
              {sectionHead('projects', `Projects (${projectRows.length})`, 'switch, rename or delete')}
              {section === 'projects' && (
                <Box flexDirection="row" justifyContent="space-between" paddingLeft={2}>
                  <Text dimColor>Some projects are members-only: ask a member to add you.</Text>
                  <Button key="projects-refresh-list" label="↻" dimColor onPress={() => refreshProjectsPress($)} />
                </Box>
              )}
              {section === 'projects' &&
                projectRows.map(p => {
                  const mine = p.name === projectName
                  const lead = mine ? s.leader : p.leader // the project you're in: the leader the pane already has
                  const canDelete = p.name !== 'main' && (lead === me || isHosting())
                  const who = whoIn(p.name, p.here)
                  const bits = [
                    p.unread && !mine ? `${p.unread} new` : '',
                    who.length ? `here: ${who.join(', ')}` : '',
                    p.openTasks ? `${p.openTasks} open task${p.openTasks === 1 ? '' : 's'}` : '',
                    lead ? `led by ${lead}` : '',
                  ].filter(Boolean)
                  return (
                    <Box flexDirection="column" paddingLeft={2}>
                      <Box flexDirection="row" justifyContent="space-between">
                        <Text bold={mine}>
                          {mine ? '▸ ' : '  '}
                          {p.name}
                          {mine ? ' (you)' : ''}
                          <Text dimColor>{bits.length ? `  · ${bits.join(' · ')}` : ''}</Text>
                        </Text>
                        <Box flexDirection="row">
                          {!mine && <Button key={`proj-open-${p.name}`} label="Switch" dimColor onPress={() => switchProjectPress($, p.name)} />}
                          {canDelete && <Button key={`proj-more-${p.name}`} label="⋯" dimColor onPress={() => toggleProjectMenu($, p.name)} />}
                        </Box>
                      </Box>
                      {menuOpen === p.name && deleting.name !== p.name && renamingName !== p.name && (
                        <Box flexDirection="row" justifyContent="flex-end">
                          <Button key={`proj-rename-${p.name}`} label="Rename…" onPress={() => void update($, renaming, () => p.name)} />
                          <Button key={`proj-delete-${p.name}`} label="Delete project…" onPress={() => setDeleteStage($, p.name, 1)} />
                        </Box>
                      )}
                      {renamingName === p.name && Input && (
                        <Box flexDirection="row">
                          <Input
                            key={`proj-rename-input-${p.name}`}
                            label="New name "
                            value={p.name}
                            submitLabel="rename"
                            autoFocus
                            onSubmit={(v: string) => void renameProject($, p.name, v)}
                          />
                          <Button key={`proj-rename-cancel-${p.name}`} label="Cancel" dimColor onPress={() => void update($, renaming, () => '')} />
                        </Box>
                      )}
                      {deleting.name === p.name && deleting.stage === 1 && (
                        <Callout>
                          <Text bold>Delete "{p.name}"? You sure?</Text>
                          <Text dimColor>This wipes its chat, tasks, docs and leader on the relay, for the whole crew. Everyone in it goes back to main.</Text>
                          <Box flexDirection="row">
                            <Button key="delete-sure" label="Yes, I'm sure…" onPress={() => setDeleteStage($, p.name, 2)} />
                            <Button key="delete-cancel" label="Cancel" variant="primary" onPress={() => setDeleteStage($, '', 0)} />
                          </Box>
                        </Callout>
                      )}
                      {deleting.name === p.name && deleting.stage === 2 && (
                        <Callout>
                          <Text bold color="error">VERY sure?? This can't be undone on the relay.</Text>
                          {binnable ? (
                            <Text>Its folder {shortPath(binnable)}, with everything in it, goes to your Recycle Bin (only on this PC; restore it from there if you change your mind).</Text>
                          ) : (
                            <Text dimColor>
                              {keptFolder ? `Your folder ${shortPath(keptFolder)} is left alone: only a folder crew made for this project inside your projects home gets binned.` : 'There is no folder for it on this PC to remove.'}
                            </Text>
                          )}
                          <Text dimColor>Teammates' copies on their own PCs stay where they are.</Text>
                          <Box flexDirection="row">
                            <Button key="delete-very-sure" label={`Delete "${p.name}" for good`} onPress={() => deleteProjectPress($, p.name)} />
                            <Button key="delete-cancel-2" label="No, keep it" variant="primary" onPress={() => setDeleteStage($, '', 0)} />
                          </Box>
                        </Callout>
                      )}
                    </Box>
                  )
                })}

              {projectName !== 'main' &&
                thisProject &&
                sectionHead('members', 'Members & access', thisProject.private ? `🔒 ${(thisProject.members ?? []).length} members` : '🔓 everyone in the crew')}
              {projectName !== 'main' && thisProject && section === 'members' && (
                <Box flexDirection="column" paddingLeft={2}>
                  {!thisProject.private && (
                    <Box flexDirection="row" justifyContent="space-between">
                      <Text dimColor>Everyone in the crew can see this project.</Text>
                      {(s.leader === me || isHosting()) && (
                        <Button key="project-lock" label="🔒 Make members-only" dimColor onPress={() => void projectCall($, '/project/private', { private: true }, 'this project is members-only now')} />
                      )}
                    </Box>
                  )}
                  {thisProject.private && (
                    <Box flexDirection="column">
                      <Text dimColor>Only members see its chat, tasks, docs and shared folders. + adds someone (they get an invite).</Text>
                      <Box flexDirection="row" flexWrap="wrap">
                        {s.peers
                          .map(p => p.name)
                          .filter(n => n !== me && !(thisProject.members ?? []).includes(n))
                          .map(n => (
                            <Button key={`member-add-${n}`} label={`+ ${n}`} dimColor onPress={() => void projectCall($, '/project/members', { add: [n] }, `added ${n}: they got an invite`)} />
                          ))}
                        {s.leader === me &&
                          (thisProject.members ?? [])
                            .filter(n => n !== me)
                            .map(n => (
                              <Button key={`member-rm-${n}`} label={`✕ ${n}`} dimColor onPress={() => void projectCall($, '/project/members', { remove: [n] }, `removed ${n} from the project`)} />
                            ))}
                        {(s.leader === me || isHosting()) && (
                          <Button key="project-unlock" label="🔓 Open to everyone" dimColor onPress={() => void projectCall($, '/project/private', { private: false }, 'this project is open to the whole crew again')} />
                        )}
                      </Box>
                    </Box>
                  )}
                </Box>
              )}

              {sectionHead('folders', `Shared folders (${sharedFolders.length})`, toGet > 0 ? `${toGet} to get` : 'Crewshared drops, Crewleader')}
              {section === 'folders' && (
                <Box flexDirection="column" paddingLeft={2}>
                  {folderPath !== '' && (
                    <Box flexDirection="column">
                      <Box flexDirection="row" justifyContent="space-between">
                        <Text>📥 Drop files in {CREWSHARED}\{mySharedName().split('/')[1]}: every teammate gets them</Text>
                        <Button key="crewshared-mine" label="Open" dimColor onPress={() => folderPress($, () => makeDir($, mirrorPath(mySharedName())).then(() => openInExplorer($, mirrorPath(mySharedName()))))} />
                      </Box>
                      <Box flexDirection="row" justifyContent="space-between">
                        <Text>📂 Teammates' drops land in {CREWSHARED}\their name</Text>
                        <Button key="crewshared-all" label="Open" dimColor onPress={() => folderPress($, () => makeDir($, mirrorPath(CREWSHARED)).then(() => openInExplorer($, mirrorPath(CREWSHARED))))} />
                      </Box>
                      <Box flexDirection="row" justifyContent="space-between">
                        <Text>📦 Big raw material goes in {CREWLEADER} (stays on this PC)</Text>
                        <Button key="crewleader-open" label="Open" dimColor onPress={() => folderPress($, () => makeDir($, mirrorPath(CREWLEADER)).then(() => openInExplorer($, mirrorPath(CREWLEADER))))} />
                      </Box>
                    </Box>
                  )}
                  {sharedFolders.length === 0 && <Text dimColor>No shared folders yet: "Share another folder…" gives every teammate a synced copy, with no tokens.</Text>}
                  {sharedFolders.map(f => {
                    const mine = f.by === me
                    const want = wantedFolders.get(f.name) === true
                    const job = jobs[f.name] ?? ''
                    return (
                      <Box flexDirection="row" justifyContent="space-between">
                        <Text>
                          📂 {f.name} <Text dimColor>· {mine ? 'you' : f.by} · {f.files} files · {mb(f.bytes)}{job ? ` · ${job}` : mine ? ' · shared' : want ? ' · ✓ on this PC' : ''}</Text>
                        </Text>
                        <Box flexDirection="row">
                          {mine && <Button key={`folder-update-${f.name}`} label="Update" dimColor onPress={() => void shareFolderPress($, f.name)} />}
                          {mine && <Button key={`folder-unshare-${f.name}`} label="Stop sharing" dimColor onPress={() => void unshareFolder($, f.name)} />}
                          {!mine && !want && <Button key={`folder-get-${f.name}`} label="Get it" onPress={() => void wantFolder($, f.name, true)} />}
                          {!mine && want && folderPath !== '' && <Button key={`folder-open-${f.name}`} label="Open" dimColor onPress={() => openInExplorer($, mirrorPath(f.name))} />}
                          {!mine && want && <Button key={`folder-stop-${f.name}`} label="Stop syncing" dimColor onPress={() => void wantFolder($, f.name, false)} />}
                        </Box>
                      </Box>
                    )
                  })}
                  {folderPath !== '' && (
                    <Box flexDirection="row" flexWrap="wrap">
                      <Button key="folder-share-pick" label="Share another folder…" dimColor onPress={() => folderPress($, () => pickSharedFolder($))} />
                      <Button key="folder-sync-now" label="⇅ Sync now" dimColor onPress={() => folderPress($, () => syncNow($))} />
                    </Box>
                  )}
                </Box>
              )}

              {sectionHead('rules', `House rules (${rulesLines.length})`, rulesLines.length ? '' : 'every Claude here follows them')}
              {section === 'rules' && (
                <Box flexDirection="column" paddingLeft={2}>
                  {rulesLines.length === 0 && <Text dimColor>None yet, like "Pluh does the art" or "ask before touching main".</Text>}
                  {rulesLines.slice(0, 8).map((l, i) => (
                    <Box flexDirection="row" justifyContent="space-between">
                      <Text wrap="truncate-end">{l}</Text>
                      <Button key={`rule-rm-${i}`} label="✕" dimColor onPress={() => void removeRule($, l)} />
                    </Box>
                  ))}
                  {rulesLines.length > 8 && <Text dimColor>…{rulesLines.length - 8} more (the {RULES_DOC} doc has them all)</Text>}
                  {Input && (
                    <Box width="100%">
                      <Input
                        key="add-rule"
                        placeholder="Add a rule for every Claude in this project, like 'Sonnet does the UI', then Enter"
                        submitLabel="add"
                        value={draft['add-rule'] ?? ''}
                        onInput={(v: string) => setDraft($, 'add-rule', v)}
                        onSubmit={(v: string) => submitted($, 'add-rule', v, () => addRule($, v))}
                      />
                    </Box>
                  )}
                </Box>
              )}

              {sectionHead('docs', `Shared docs (${docs.length})`, docs.length ? `newest: ${docs[0].name}` : '')}
              {section === 'docs' && (
                <Box flexDirection="column" paddingLeft={2}>
                  {docs.length === 0 && <Text dimColor>None yet. Claudes share plans, findings and patches here with crew_share.</Text>}
                  {docs.slice(0, Math.min(docRows, 5)).map(d => (
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
                            {(d.by === me || s.leader === me || isHosting()) && deletingDoc !== d.name && (
                              <Button key="doc-delete" label="Delete…" dimColor onPress={() => askDeleteDoc($, d.name)} />
                            )}
                          </Box>
                          {deletingDoc === d.name && (
                            <Box flexDirection="row">
                              <Text bold>Delete "{d.name}" for the whole project? </Text>
                              <Button key="doc-delete-yes" label="Yes, delete" onPress={() => void deleteDoc($, d.name)} />
                              <Button key="doc-delete-no" label="Cancel" variant="primary" onPress={() => askDeleteDoc($, '')} />
                            </Box>
                          )}
                        </Callout>
                      )}
                    </Box>
                  ))}
                  {docs.length > Math.min(docRows, 5) && <Text dimColor>…and {docs.length - Math.min(docRows, 5)} older (crew_read_shared lists them all)</Text>}
                </Box>
              )}

              {sectionHead('help', 'ⓘ How projects work')}
              {section === 'help' && (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text dimColor>• Switching is just for you. Everyone in a project shares its chat, tasks, docs and house rules.</Text>
                  <Text dimColor>• Your folder is only on this PC, and your Claude works in it. Each teammate has their own copy.</Text>
                  <Text dimColor>• To pass files around: drop them in {CREWSHARED}\{mySharedName().split('/')[1]}, share a folder, crew_share a doc, or use git.</Text>
                  <Text dimColor>• {CREWLEADER} is for big raw material: it stays here, and the leader's Claude copies over only what the crew needs.</Text>
                  <Text dimColor>• A members-only project (🔒) is invisible to everyone else in the crew.</Text>
                </Box>
              )}
            </Box>
          </Box>
        )}

        {/* -- Crew: who's here and who leads, and the invite while you host */}
        {inSession && current === 'crew' && (
          <Box flexDirection="column">
            <Card title={`Crew (${online} online)`}>
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
              {kicking !== '' && (
                <Callout>
                  <Text bold>Remove {kicking} from the crew session?</Text>
                  <Text dimColor>
                    Their Claude stops getting crew messages, and they're out until they press Join session (a forgotten
                    extra chat just drops out). Their tasks stay on the board.
                  </Text>
                  <Box flexDirection="row">
                    <Button key="kick-yes" label={`Yes, remove ${kicking}`} onPress={() => void kick($, kicking)} />
                    <Button key="kick-no" label="Cancel" variant="primary" onPress={() => askKick($, '')} />
                  </Box>
                </Callout>
              )}
              {s.peers.map(p => (
                <Box flexDirection="row" justifyContent="space-between">
                  <Text dimColor={!p.online}>
                    {p.online ? '●' : '○'} {p.name}
                    {p.leader ? ' ★' : ''}
                    {p.acting ? ' ☆ acting leader' : ''}
                    {p.name === me ? ' (you)' : ''}
                    {activityWord(p) ? `  · ${activityWord(p)}` : ''}
                    {p.online && p.project && p.project !== projectName ? `  · in ${p.project}` : ''}
                    {p.model ? `  · ${modelLabel(p.model)}` : ''}
                    {p.usage != null ? `  · ${shortUsage(p)}${p.usage >= 80 ? ' ⚠' : ''}` : ''}
                    {p.online && editingNow(p.name) ? `  · ✎ ${editingNow(p.name)?.path}` : ''}
                    {p.mcp && liveMcps(p.mcp) ? `  · 🔌 ${liveMcps(p.mcp)} MCP${liveMcps(p.mcp) === 1 ? '' : 's'}` : ''}
                    {p.friend ? '  · friend' : ''}
                    {isHosting() && p.online && p.ip && p.name !== me ? `  · from ${p.ip}` : ''}
                    {p.version ? `  · v${p.version}${versionMark(p.version)}` : ''}
                  </Text>
                  <Box flexDirection="row">
                    {isHosting() && p.name !== me && p.online && !p.friend && (
                      <Button key={`friend-make-${p.name}`} label="★ Friend" dimColor onPress={() => void makeFriend($, p.name, p.ip ?? '')} />
                    )}
                    {p.name !== me && p.online && p.version && newer(VERSION, p.version) && (
                      <Button key={`nudge-${p.name}`} label="Nudge" dimColor onPress={() => nudgeUpdate($, p.name, p.version ?? '')} />
                    )}
                    {canKick && p.name !== me && p.online && kicking === '' && (
                      <Button key={`kick-${p.name}`} label="Remove" dimColor onPress={() => askKick($, p.name)} />
                    )}
                  </Box>
                </Box>
              ))}
              {(() => {
                const known = s.peers.filter(p => p.online && p.version)
                const behind = known.filter(p => newer(VERSION, p.version ?? ''))
                if (!known.length) return null
                return behind.length ? (
                  <Text dimColor>
                    {behind.map(p => `${p.name} (${p.version})`).join(', ')} {behind.length === 1 ? 'is' : 'are'} behind your v{VERSION}:
                    Nudge pins a reminder in their /crew to press Install update.
                  </Text>
                ) : (
                  <Text dimColor>Everyone online is on v{VERSION} or newer ✓</Text>
                )
              })()}
            </Card>
            {isHosting() && s.connected && (
              <Card title={`Friends${friendList.list.length ? ` (${friendList.list.length})` : ''}`}>
                <Text dimColor>
                  Press ★ Friend next to someone connected (in the list above) and their personal key reaches them by itself. It's tied
                  to their name, so nobody can pose as them, and removing one friend doesn't touch anyone else. Who can join: ⚙ Settings.
                </Text>
                {friendList.list.map(f => {
                  const here = s.peers.some(p => p.name === f.name && p.online)
                  return (
                    <Box flexDirection="column">
                      <Box flexDirection="row" justifyContent="space-between">
                        <Text>
                          {here ? '●' : '○'} {f.name}
                          <Text dimColor>
                            {here ? `  · connected now${f.ip ? ` from ${f.ip}` : ''}` : f.seen ? `  · last seen ${hhmm(f.seen)}${f.ip ? ` from ${f.ip}` : ''}` : '  · not connected yet'}
                          </Text>
                        </Text>
                        <Box flexDirection="row">
                          <Button key={`friend-invite-${f.name}`} label="Copy invite" dimColor onPress={() => copyInvite($, e.surface, host.ip, f.key, f.name)} />
                          {removingFriend !== f.name && <Button key={`friend-rm-${f.name}`} label="Remove" dimColor onPress={() => void update($, friendRm, () => f.name)} />}
                        </Box>
                      </Box>
                      {removingFriend === f.name && (
                        <Box flexDirection="row">
                          <Text bold>Remove {f.name}? Their key stops working and they drop out of the session. </Text>
                          <Button key={`friend-rm-yes-${f.name}`} label="Yes, remove" onPress={() => void removeFriend($, f.name)} />
                          <Button key={`friend-rm-no-${f.name}`} label="Cancel" variant="primary" onPress={() => void update($, friendRm, () => '')} />
                        </Box>
                      )}
                    </Box>
                  )
                })}
                {Input && (
                  <Box marginTop={1} width="100%">
                    <Input
                      key="friend-add"
                      placeholder="Not connected yet? Type their crew name, then Enter: their personal invite is copied"
                      submitLabel="add"
                      value={draft['friend-add'] ?? ''}
                      onInput={(v: string) => setDraft($, 'friend-add', v)}
                      onSubmit={(v: string) => submitted($, 'friend-add', v, () => addFriend($, e.surface, v))}
                    />
                  </Box>
                )}
              </Card>
            )}
            {!isHosting() && s.connected && (
              <Card title="Friends">
                <Text dimColor>
                  {s.peers.find(p => p.name === me)?.friend
                    ? "You're on the host's friends list ✓ Your personal key is saved; nothing to do."
                    : 'Friends are managed by the host: they press ★ Friend next to your name, and your personal key arrives by itself.'}
                </Text>
              </Card>
            )}
            {isHosting() && s.connected && (
              <Card title="Invite friends">
                <Text>You're hosting{host.ip ? ` · friends join at http://${host.ip}:7777` : ''}</Text>
                {!host.ip && <Text dimColor>No Radmin/Tailscale address found yet: connect your VPN, then press Host a crew again.</Text>}
                {hostMsg !== '' && <Text dimColor>{hostMsg}</Text>}
                <Box flexDirection="row">
                  <Button key="invite" label="Copy invite" variant="primary" onPress={() => copyInvite($, e.surface, host.ip, host.key || key)} />
                  {!stoppingHost && <Button key="stop-host" label="Stop hosting…" onPress={() => void update($, stopAsk, () => true)} />}
                  {!askingKey && <Button key="key-new" label="🔑 New crew key…" dimColor onPress={() => askNewKey($, true)} />}
                </Box>
                {Select && (
                  <Select
                    key="keep-awake"
                    label="Keep this PC awake while anyone's connected "
                    value={keepAwake ? 'yes' : 'no'}
                    options={[
                      { value: 'yes', label: 'yes (the screen can still turn off)' },
                      { value: 'no', label: 'no, let it sleep' },
                    ]}
                    onSelect={(v: string) =>
                      void relay($, 'POST', '/keepawake', { on: v === 'yes' })
                        .then(() => poll($))
                        .then(() => $.ui.toast(v === 'yes' ? "crew: this PC stays awake while anyone's connected" : 'crew: this PC may sleep again (the crew pauses when it does)', { timeoutMs: 6000 }))
                        .catch(err => $.ui.toast(`crew: ${explain(err instanceof Error ? err.message : String(err))}`, { timeoutMs: 8000 }))
                    }
                  />
                )}
                {stoppingHost && (
                  <Callout>
                    <Text bold>Stop hosting?</Text>
                    <Text dimColor>The relay stops, so everyone in the crew is disconnected until you start it again. Nothing is lost.</Text>
                    <Box flexDirection="row">
                      <Button key="stop-host-yes" label="Yes, stop" onPress={() => stopHostingPress($)} />
                      <Button key="stop-host-no" label="Cancel" variant="primary" onPress={() => void update($, stopAsk, () => false)} />
                    </Box>
                  </Callout>
                )}
                {askingKey && (
                  <Callout>
                    <Text bold>Make a new crew key?</Text>
                    <Text dimColor>
                      The old key stops working right away, so everyone is cut off until they paste the new invite (it's copied for you).
                      Use it when someone left the crew or an invite went somewhere it shouldn't.
                    </Text>
                    <Box flexDirection="row">
                      <Button key="key-new-yes" label="Yes, new key" onPress={() => void newCrewKey($, e.surface)} />
                      <Button key="key-new-no" label="Cancel" variant="primary" onPress={() => askNewKey($, false)} />
                    </Box>
                  </Callout>
                )}
              </Card>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
