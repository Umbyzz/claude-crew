export type CrewMessage = {
  id: number
  from: string
  to: string
  kind: 'chat' | 'request' | 'update' | 'out' | 'back' | 'join' | 'leave' | 'image' | 'invite' | 'deleted'
  deleted?: string // kind 'deleted': the project that was deleted
  invite?: string // kind 'invite': the project the sender asks people into
  text: string
  at: number
  // images only: the relay's file id, its name, type, size and caption
  file?: string
  name?: string
  mime?: string
  size?: number
  caption?: string
  notify?: boolean // flagged "for your human" by the sender
  human?: boolean // typed by a person in /crew rather than sent by their Claude
  handover?: string // an acting leader handing back: the true leader who's back
  project?: string // which crew project it belongs to (none: crew-wide, like joins and leaves)
}

export type CrewPeer = {
  name: string
  online: boolean
  lastSeen: number
  activity: 'idle' | 'thinking' | 'typing' | 'working' | 'chatting' | 'done' | 'cheer' | 'away' | 'out'
  subagents?: number
  chatTo?: string | null
  leader: boolean
  acting?: boolean // standing in for the leader while they're away
  project?: string // the crew project their Claude is working in
  version?: string | null // their crew plugin version, as their last check-in said
  model?: string | null // the model their Claude runs (the leader splits work by it)
  usage?: number | null // the most of any usage-limit window they've used, in percent
  usageDetail?: string | null // each window on its own: "26% session · 35% week"
  mcp?: string | null // the MCP servers their Claude is connected to ("Roblox Studio, Unity")
  friend?: boolean // on the host's friends list (a personal key)
  ip?: string // where they connect from (only the host sees it)
}

export type CrewTask = {
  id: number
  title: string
  note: string
  status: 'open' | 'claimed' | 'done'
  owner: string | null
  assignee: string | null
  by: string
  at: number
  ownerAway?: number // minutes the claiming owner has been offline (from 10 on); at 30 the relay reopens it
}

export type CrewSnapshot = {
  connected: boolean
  error: string
  cursor: number
  leader: string | null
  acting?: string | null // the acting leader while the true leader is away (relay 0.9.9+)
  latest: string | null
  relayVersion: string | null
  feed: CrewMessage[]
  peers: CrewPeer[]
  tasks: CrewTask[]
  shared: string[]
  chatEpoch?: number // the relay's chat-reset count: when it changes, the chat starts over
  reads?: Record<string, number> // read receipts: the newest message id each member's plugin has (relay 0.9.5+)
  project?: string // the crew project this session is in ('main' unless switched)
  projects?: CrewProject[] // every project on the relay (relay 1.1+)
  keepAwake?: boolean // the host keeps their PC awake while anyone's connected (relay 1.10.1+)
}

export type CrewProject = {
  name: string
  leader: string | null
  openTasks: number
  docs: number
  here: string[] // who's online in it right now
  unread?: number // messages there you haven't seen yet (relay 1.5.3+)
  private?: boolean // members-only (relay 1.10+)
  members?: string[] // who's in a members-only project
}

declare module 'claude-code' {
  interface PluginState {
    crew: {
      snapshot: CrewSnapshot
      settingsOpen: boolean
      membership: '' | 'joined' | 'left' | 'ask'
      host: { ip: string; key: string }
      confirmReset: boolean
      updateNote: { state: '' | 'busy' | 'ok' | 'error'; text: string }
      hostNote: string
      pins: { id: number; from: string; text: string; at: number }[]
      pendingLeader: string
      joinMode: boolean
      askTo: string
      briefed: number
      confirmClear: boolean
      confirmLeave: boolean
      docList: { names: string; docs: { name: string; by: string; at: number; size: number }[] }
      docOpen: { name: string; head: string[]; more: number; error: string }
      tab: 'chat' | 'tasks' | 'docs' | 'crew'
      chatView: 'all' | 'people' | 'claudes'
      project: string
      folder: { path: string; chosen: boolean; dirs: string[]; error: string; note: string }
      kickPending: string
      folderMode: '' | 'new' | 'home' | 'sub' | 'change'
      invite: { from: string; project: string; busy?: boolean }
      deleteStage: { name: string; stage: number }
      projectMenu: string
      docDeleting: string
      tipSeen: boolean
      drafts: Record<string, string>
      madeFolder: string
      folderJobs: Record<string, string>
      keyAsk: boolean
      friendRm: string
      renaming: string
      stopAsk: boolean
      nextChat: string
      typing: Record<string, string>
      friends: { list: { name: string; key: string; seen: number; ip: string; online: boolean }[]; friendsOnly: boolean }
    }
  }
}
