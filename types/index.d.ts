export type CrewMessage = {
  id: number
  from: string
  to: string
  kind: 'chat' | 'request' | 'update' | 'out' | 'back'
  text: string
  at: number
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
}

export type ClawdScene = { name: 'idle' | 'wave' | 'dance' | 'hi5' | 'hop' | 'walk'; seed: number }

declare module 'claude-code' {
  interface PluginState {
    crew: { snapshot: CrewSnapshot; settingsOpen: boolean; clawdScene: ClawdScene }
  }
}
