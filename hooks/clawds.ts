// Pixel Clawds for the /clawds pane: pure drawing, no model calls.
// Desktop gets one animated SVG (CSS keyframes run inside it); the terminal gets a
// half-block Raster of the scene's key pose.

export type ClawdMember = { name: string; online: boolean; activity: string; leader: boolean }
export type SceneName = 'idle' | 'wave' | 'dance' | 'hi5' | 'hop' | 'walk'

export const SCENES: readonly SceneName[] = ['idle', 'wave', 'dance', 'hi5', 'hop', 'walk']

const ORANGE = '#D97757'
const GREY = '#8A8580'
const EYE = '#141413'
const W = 64 // viewBox columns
const H = 22 // viewBox rows
const TOP = 7 // rows kept free above the sprites for bubbles and z's
const SLOT = (i: number) => 4 + i * 20

// The sprite, 14 x 10 cells, split into the parts that move on their own.
const BODY = cells([0, 1, 2, 3, 4, 5, 6, 7], [3, 4, 5, 6, 7, 8, 9, 10])
const ARM_L = cells([4, 5], [1, 2])
const ARM_R = cells([4, 5], [11, 12])
const EYES = [[2, 5], [2, 8]] as const
const LIDS = [[3, 5], [3, 8]] as const
const LEGS_A = cells([8, 9], [3, 5, 8, 10])
const LEGS_B = [...cells([8], [3, 5, 8, 10]), ...cells([9], [4, 6, 9, 11])]

function cells(rows: number[], cols: number[]) {
  const out: [number, number][] = []
  for (const r of rows) for (const c of cols) out.push([r, c])
  return out
}

function rects(px: readonly (readonly [number, number])[], fill: string, h = 1) {
  return px.map(([r, c]) => `<rect x="${c}" y="${r}" width="1" height="${h}" fill="${fill}"/>`).join('')
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Three slots: the crew (me first) padded with nameless Clawds. */
export function cast(members: ClawdMember[], me: string): ClawdMember[] {
  const sorted = [...members].sort((a, b) =>
    a.name === me ? -1 : b.name === me ? 1 : Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  )
  const out = sorted.slice(0, 3)
  while (out.length < 3) out.push({ name: '', online: true, activity: 'idle', leader: false })
  return out
}

/** Each Clawd's own state wins over the scene: asleep when out of tokens, typing while its Claude works. */
function mood(m: ClawdMember): 'sleep' | 'type' | 'think' | 'chat' | 'done' | 'cheer' | 'off' | null {
  if (!m.online && m.name) return 'off'
  const a = m.activity
  if (a === 'out') return 'sleep'
  if (a === 'typing' || a === 'working') return 'type'
  if (a === 'thinking') return 'think'
  if (a === 'chatting') return 'chat'
  if (a === 'done') return 'done'
  if (a === 'cheer') return 'cheer'
  return null
}

export function caption(scene: SceneName, crew: ClawdMember[], seed: number) {
  const n = crew.map((m, i) => m.name || ['Clawd', 'Clawdette', 'Lil Clawd'][i])
  const a = seed % 3
  const b = (a + 1) % 3
  const asleep = crew.filter(m => m.activity === 'out').map((m, i) => m.name || n[i])
  const note = asleep.length ? `  ·  ${asleep.join(', ')} ${asleep.length > 1 ? 'are' : 'is'} snoozing (out of tokens)` : ''
  const text = {
    idle: 'just vibing',
    wave: `${n[a]} waves at ${n[b]}… ${n[b]} waves back!`,
    dance: 'dance party! ♪',
    hi5: `${n[0]} and ${n[2]} go for a high-five`,
    hop: `${n[a]} does a happy hop`,
    walk: 'out for a little stroll',
  }[scene]
  return text + note
}

const CSS = `
.part,.mover,.bobber{transform-box:view-box}
.bobber{animation:bob 1.4s steps(1) infinite}
@keyframes bob{0%{transform:translate(0,0)}50%{transform:translate(0,-1px)}}
.eyes{animation:blink 5s steps(1) infinite}
.lids{opacity:0;animation:lids 5s steps(1) infinite}
@keyframes blink{0%,93%{opacity:1}94%,100%{opacity:0}}
@keyframes lids{0%,93%{opacity:0}94%,100%{opacity:1}}
.legsB,.bubble,.z,.dots,.note,.spark{opacity:0}

.s-wave .armR{animation:wave .45s steps(1) 7}
@keyframes wave{0%{transform:translate(0,-3px)}50%{transform:translate(0,-2px)}}
.s-wave .bubble{animation:say 3.2s steps(1) 1}
@keyframes say{0%{opacity:1}100%{opacity:0}}

.s-dance .mover{animation:dance .8s steps(1) infinite}
@keyframes dance{0%{transform:translate(0,0)}25%{transform:translate(-1px,-2px)}50%{transform:translate(0,0)}75%{transform:translate(1px,-2px)}}
.s-dance .armL{animation:up2 .8s steps(1) infinite}
.s-dance .armR{animation:up2 .8s steps(1) .4s infinite}
@keyframes up2{0%{transform:translate(0,-2px)}50%{transform:translate(0,0)}}
.s-dance .legsA{animation:la .4s steps(1) infinite}
.s-dance .legsB{animation:lb .4s steps(1) infinite}
.s-dance .note{animation:note 1.6s linear infinite}
@keyframes note{0%{opacity:0;transform:translate(0,0)}20%{opacity:1}100%{opacity:0;transform:translate(-2px,-5px)}}

.s-hi5.k0 .mover{animation:toR 6s steps(10) 1}
.s-hi5.k2 .mover{animation:toL 6s steps(10) 1}
@keyframes toR{0%,100%{transform:translate(0,0)}40%,60%{transform:translate(5px,0)}}
@keyframes toL{0%,100%{transform:translate(0,0)}40%,60%{transform:translate(-5px,0)}}
.s-hi5.k0 .armR,.s-hi5.k2 .armL,.s-hi5.k1 .armL,.s-hi5.k1 .armR{animation:hi 6s steps(1) 1}
@keyframes hi{0%,41%{transform:translate(0,0)}42%,58%{transform:translate(0,-3px)}59%,100%{transform:translate(0,0)}}
.s-hi5.k1 .spark{animation:spark 6s steps(1) 1}
@keyframes spark{0%,44%{opacity:0}45%,57%{opacity:1}58%,100%{opacity:0}}
.s-hi5 .legsA{animation:la .5s steps(1) 4}
.s-hi5 .legsB{animation:lb .5s steps(1) 4}

.s-hop .mover{animation:hop 1.1s steps(1) 4}
@keyframes hop{0%{transform:translate(0,0)}20%{transform:translate(0,-3px)}40%{transform:translate(0,-2px)}60%,100%{transform:translate(0,0)}}

.s-walk .mover{animation:walk 8s steps(16) infinite}
@keyframes walk{0%,100%{transform:translate(0,0)}25%{transform:translate(3px,0)}75%{transform:translate(-3px,0)}}
.s-walk .legsA{animation:la .5s steps(1) infinite}
.s-walk .legsB{animation:lb .5s steps(1) infinite}
@keyframes la{0%{opacity:1}50%{opacity:0}}
@keyframes lb{0%{opacity:0}50%{opacity:1}}

.m-type .armL,.m-type .armR{animation:typ .25s steps(1) infinite}
.m-type .armR{animation-delay:.12s}
@keyframes typ{0%{transform:translate(0,0)}50%{transform:translate(0,-1px)}}
.m-type .dots{animation:dots 1.2s steps(1) infinite}
@keyframes dots{0%{opacity:0}30%{opacity:1}100%{opacity:1}}
.m-type .mover{animation:none}

.m-sleep .mover,.m-off .mover{animation:none}
.m-sleep .bobber{animation:breathe 3s steps(1) infinite}
@keyframes breathe{0%{transform:translate(0,0)}50%{transform:translate(0,1px)}}
.m-sleep .eyes,.m-off .eyes{animation:none;opacity:0}
.m-sleep .lids,.m-off .lids{animation:none;opacity:1}
.m-sleep .armL,.m-sleep .armR,.m-sleep .legsA,.m-sleep .legsB,.m-sleep .bubble,.m-sleep .note{animation:none}
.m-sleep .z{animation:z 3s linear infinite}
.m-sleep .z2{animation-delay:1s}.m-sleep .z3{animation-delay:2s}
@keyframes z{0%{opacity:0;transform:translate(0,0)}20%{opacity:1}100%{opacity:0;transform:translate(3px,-6px)}}
.m-off .bobber{animation:none}

.m-think .mover{animation:none}
.m-think .eyes{transform:translate(0,-1px)}
.m-think .armR{transform:translate(0,-2px)}
.m-think .dots{animation:dots 1.5s steps(1) infinite}

.m-chat .mover{animation:none}
.m-chat .bubble{animation:say 1.6s steps(1) infinite}
.m-chat .armR{animation:up2 .6s steps(1) infinite}

.m-done .mover{animation:dance .8s steps(1) infinite}
.m-done .armL{animation:up2 .8s steps(1) infinite}
.m-done .armR{animation:up2 .8s steps(1) .4s infinite}
.m-done .note{animation:note 1.6s linear infinite}

.m-cheer .mover{animation:hop 1.1s steps(1) infinite}
.m-cheer .armL,.m-cheer .armR{transform:translate(0,-3px);animation:none}
.m-cheer .spark{animation:spark 1.1s steps(1) infinite}
`

export function clawdSvg(scene: SceneName, crew: ClawdMember[], seed: number) {
  const a = seed % 3
  const b = (a + 1) % 3
  const delays: string[] = []
  // Wave: one greets, the next answers 1.8s later. Hop: one Clawd hops.
  if (scene === 'wave') {
    delays.push(`.k${a} .armR,.k${a} .bubble{animation-delay:.3s}`, `.k${b} .armR,.k${b} .bubble{animation-delay:2.1s}`)
    for (const k of [0, 1, 2].filter(k => k !== a && k !== b)) delays.push(`.k${k} .armR,.k${k} .bubble{animation:none}`)
  }
  if (scene === 'hop') for (const k of [0, 1, 2].filter(k => k !== a)) delays.push(`.k${k} .mover{animation:none}`)

  const sprites = crew
    .map((m, i) => {
      const md = mood(m)
      const fill = md === 'off' ? GREY : ORANGE
      const cls = `clawd k${i} s-${scene}${md ? ` m-${md}` : ''}`
      const name = m.name ? `${m.leader ? '★ ' : ''}${m.name}` : ''
      const word = md === 'chat' ? 'blah!' : scene === 'wave' ? (i === a ? 'hi!' : 'hey!') : 'hi!'
      return `
<g transform="translate(${SLOT(i)},${TOP})"><g class="${cls}"><g class="mover"><g class="bobber">
  <g class="part body">${rects(BODY, fill)}</g>
  <g class="part armL">${rects(ARM_L, fill)}</g>
  <g class="part armR">${rects(ARM_R, fill)}</g>
  <g class="part eyes">${rects(EYES, EYE)}</g>
  <g class="part lids">${rects(LIDS, EYE, 0.4)}</g>
  <g class="part legsA">${rects(LEGS_A, fill)}</g>
  <g class="part legsB">${rects(LEGS_B, fill)}</g>
  <g class="bubble"><rect x="9" y="-6" width="8" height="4" rx="1" fill="#fff" stroke="#3d3d3a" stroke-width=".3"/><path d="M11 -2 L10.5 -0.8 L12.5 -2 Z" fill="#fff"/><text x="13" y="-3.1" font-size="2.6" text-anchor="middle" fill="#141413" font-family="sans-serif">${word}</text></g>
  <g class="dots"><text x="12" y="-1" font-size="3" fill="#b0aea5" font-family="sans-serif">…</text></g>
  <g class="note"><text x="0" y="-1" font-size="3" fill="${ORANGE}">♪</text></g>
  <g class="z"><text x="11" y="-1" font-size="2.4" fill="#87867f" font-family="sans-serif">z</text></g>
  <g class="z z2"><text x="12" y="-2" font-size="2.8" fill="#87867f" font-family="sans-serif">z</text></g>
  <g class="z z3"><text x="13" y="-3" font-size="3.2" fill="#87867f" font-family="sans-serif">Z</text></g>
  ${i === 1 ? `<g class="spark"><text x="7" y="-3.5" font-size="3.5" text-anchor="middle" fill="#E3B23C">✦</text></g>` : ''}
</g></g></g>
<text x="7" y="12.6" font-size="2.3" text-anchor="middle" fill="#9c9a92" font-family="sans-serif">${esc(name.slice(0, 14))}</text>
</g>`
    })
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">` +
    `<style>${CSS}${delays.join('')}</style>${sprites}</svg>`
  )
}

// ---- terminal: one key pose per scene, drawn with half blocks ----

function rgb(hex: string) {
  return parseInt(hex.slice(1), 16)
}

const DEFAULT = 0x01000000
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return out
}

export const RASTER_COLUMNS = W
export const RASTER_ROWS = 9

export function clawdRaster(scene: SceneName, crew: ClawdMember[], seed: number) {
  const PH = RASTER_ROWS * 2
  const px: (number | null)[][] = Array.from({ length: PH }, () => Array<number | null>(W).fill(null))
  const put = (r: number, c: number, color: number) => {
    if (r >= 0 && r < PH && c >= 0 && c < W) px[r][c] = color
  }
  const a = seed % 3
  crew.forEach((m, i) => {
    const md = mood(m)
    const fill = rgb(md === 'off' ? GREY : ORANGE)
    const lift = scene === 'hop' && i === a && !md ? -2 : scene === 'dance' && !md ? -1 : 0
    const shift = scene === 'hi5' && !md ? (i === 0 ? 4 : i === 2 ? -4 : 0) : 0
    const x0 = SLOT(i) + shift
    const y0 = 6 + lift
    const armUp = (scene === 'wave' && i === a) || scene === 'dance' || scene === 'hi5'
    for (const [r, c] of BODY) put(y0 + r, x0 + c, fill)
    for (const [r, c] of ARM_L) put(y0 + r - (scene === 'dance' || (scene === 'hi5' && i > 0) ? 2 : 0), x0 + c, fill)
    for (const [r, c] of ARM_R) put(y0 + r - (armUp && md === null ? 3 : 0), x0 + c, fill)
    for (const [r, c] of scene === 'walk' ? LEGS_B : LEGS_A) put(y0 + r, x0 + c, fill)
    const shut = md === 'sleep' || md === 'off'
    for (const [r, c] of shut ? LIDS : EYES) put(y0 + r, x0 + c, rgb(EYE))
    if (md === 'sleep') {
      put(y0 - 2, x0 + 12, rgb('#87867f'))
      put(y0 - 4, x0 + 13, rgb('#87867f'))
    }
  })
  const words = new Uint32Array(W * RASTER_ROWS * 3)
  for (let row = 0; row < RASTER_ROWS; row++)
    for (let c = 0; c < W; c++) {
      const top = px[row * 2][c]
      const bottom = px[row * 2 + 1][c]
      const o = (row * W + c) * 3
      if (top === null && bottom === null) words.set([0x20, DEFAULT, DEFAULT], o)
      else if (top === null) words.set([0x2584, bottom as number, DEFAULT], o)
      else words.set([0x2580, top, bottom ?? DEFAULT], o)
    }
  return base64(new Uint8Array(words.buffer))
}
