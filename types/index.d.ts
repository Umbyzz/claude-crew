export type CrewMessage = {
  id: number
  from: string
  to: string
  kind: 'chat' | 'request' | 'update' | 'out' | 'back' | 'join' | 'leave' | 'image'
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
}

export type CrewPeer = {
  name: string
  online: boolean
  lastSeen: number
  activity: 'idle' | 'thinking' | 'typing' | 'working' | 'chatting' | 'done' | 'cheer' | 'away' | 'out'
  subagents?: number
  chatTo?: string | null
  leader: boolean
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
}

export type CrewSnapshot = {
  connected: boolean
  error: string
  cursor: number
  leader: string | null
  latest: string | null
  relayVersion: string | null
  feed: CrewMessage[]
  peers: CrewPeer[]
  tasks: CrewTask[]
  shared: string[]
  chatEpoch?: number // the relay's chat-reset count: when it changes, the chat starts over
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
    }
  }
}
