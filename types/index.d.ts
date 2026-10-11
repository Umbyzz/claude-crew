export type CrewMessage = {
  id: number
  from: string
  to: string
  kind: 'chat' | 'request' | 'update'
  text: string
  at: number
}

export type CrewPeer = {
  name: string
  online: boolean
  lastSeen: number
  activity: 'idle' | 'working' | 'away'
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

declare module 'claude-code' {
  interface PluginState {
    crew: { snapshot: CrewSnapshot; settingsOpen: boolean }
  }
}
