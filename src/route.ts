export type LL = [lat: number, lon: number]
export type Mode = 'run' | 'bike'

// FOSSGIS public Valhalla server: no key, CORS enabled, ~1 req/s fair use.
const VALHALLA = 'https://valhalla1.openstreetmap.de'

const costing = (mode: Mode) =>
  mode === 'run'
    ? { costing: 'pedestrian' }
    : { costing: 'bicycle', costing_options: { bicycle: { bicycle_type: 'Hybrid', use_roads: 0.2 } } }

export function distance([lat1, lon1]: LL, [lat2, lon2]: LL): number {
  const r = Math.PI / 180
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return 12742000 * Math.asin(Math.sqrt(a))
}

export const length = (pts: LL[]) => pts.slice(1).reduce((s, p, i) => s + distance(pts[i], p), 0)

// Evenly spaced points along the polyline, roughly every `step` meters.
export function resample(pts: LL[], step: number): LL[] {
  if (pts.length < 2) return pts
  const out: LL[] = [pts[0]]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]]
    const d = distance(a, b)
    let t = step - carry
    while (t <= d) {
      out.push([a[0] + ((b[0] - a[0]) * t) / d, a[1] + ((b[1] - a[1]) * t) / d])
      t += step
    }
    carry = d - (t - step)
  }
  out.push(pts[pts.length - 1])
  return out
}

// Scale by `f`, rotate by `rot` radians (counter-clockwise) about `c`, then shift by `d`.
export function transform(pts: LL[], c: LL, f: number, rot: number, d: LL = [0, 0]): LL[] {
  const k = Math.cos((c[0] * Math.PI) / 180)
  const [cs, sn] = [f * Math.cos(rot), f * Math.sin(rot)]
  return pts.map(([lat, lon]) => {
    const x = (lon - c[1]) * k, y = lat - c[0]
    return [c[0] + d[0] + x * sn + y * cs, c[1] + d[1] + (x * cs - y * sn) / k]
  })
}

// Douglas–Peucker: drop points within `tol` meters of the simplified line (kills hand jitter).
export function simplify(pts: LL[], tol: number): LL[] {
  if (pts.length < 3) return pts
  const k = Math.cos((pts[0][0] * Math.PI) / 180)
  const xy = pts.map(([lat, lon]) => [lon * k * 111320, lat * 110540])
  const keep = new Set([0, pts.length - 1])
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    const [ax, ay] = xy[i], [bx, by] = xy[j]
    const len = Math.hypot(bx - ax, by - ay)
    let max = 0, idx = -1
    for (let m = i + 1; m < j; m++) {
      const d = len
        ? Math.abs((bx - ax) * (ay - xy[m][1]) - (ax - xy[m][0]) * (by - ay)) / len
        : Math.hypot(xy[m][0] - ax, xy[m][1] - ay) // closed shape: start == end
      if (d > max) [max, idx] = [d, m]
    }
    if (max > tol) {
      keep.add(idx)
      stack.push([i, idx], [idx, j])
    }
  }
  return pts.filter((_, i) => keep.has(i))
}

// Cut out-and-back spurs and tiny loops: wherever the route comes back within
// 30 m (opposite sidewalk) of an earlier point after 50…`maxLen` meters, skip the
// detour — unless it reaches one of the `keep` points (a real spike of the shape).
// Feed it densely resampled points: out and back legs rarely share vertices.
export function removeSpurs(pts: LL[], maxLen: number, keep: LL[] = []): LL[] {
  const out: LL[] = []
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i])
    let walked = 0, back = i
    for (let j = i + 1; j < pts.length && walked < maxLen; j++) {
      walked += distance(pts[j - 1], pts[j])
      if (walked > 50 && distance(pts[i], pts[j]) < 30) back = j
    }
    const spike = () => pts.slice(i, back).some((p) => keep.some((c) => distance(p, c) < 50))
    if (back > i && !spike()) i = back // resume after the farthest return, if any
  }
  return out
}

// Absolute direction change at b, in radians.
function bend(a: LL, b: LL, c: LL): number {
  const k = Math.cos((b[0] * Math.PI) / 180)
  const bearing = (p: LL, q: LL) => Math.atan2((q[1] - p[1]) * k, q[0] - p[0])
  const d = Math.abs(bearing(b, c) - bearing(a, b))
  return Math.min(d, 2 * Math.PI - d)
}

// Count direction changes sharper than 45° (ignoring sub-15 m wiggles).
export function turns(pts: LL[]): number {
  const p = resample(pts, 15)
  return p.slice(2).filter((c, i) => bend(p[i], p[i + 1], c) > Math.PI / 4).length
}

export function decodePolyline6(s: string): LL[] {
  const out: LL[] = []
  let i = 0, lat = 0, lon = 0
  const next = () => {
    let shift = 0, result = 0, b
    do {
      b = s.charCodeAt(i++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    return result & 1 ? ~(result >> 1) : result >> 1
  }
  while (i < s.length) {
    lat += next()
    lon += next()
    out.push([lat / 1e6, lon / 1e6])
  }
  return out
}

type Trip = { trip: { legs: { shape: string }[] } }

async function valhalla(endpoint: string, body: object) {
  const res = await fetch(`${VALHALLA}/${endpoint}`, { method: 'POST', body: JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json as Trip
}

const shapeOf = (t: Trip) => t.trip.legs.flatMap((l) => decodePolyline6(l.shape))
const toLoc = ([lat, lon]: LL) => ({ lat, lon })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Corners of the (simplified) shape plus evenly spaced points on long sides, ~`spacing` m apart.
export function waypoints(s: LL[], spacing: number): LL[] {
  return s.flatMap((b, i) => {
    if (!i) return [b]
    const a = s[i - 1], n = Math.ceil(distance(a, b) / spacing)
    return Array.from({ length: n }, (_, k): LL => [
      a[0] + ((b[0] - a[0]) * (k + 1)) / n,
      a[1] + ((b[1] - a[1]) * (k + 1)) / n,
    ])
  })
}

// Route through waypoints along the sketch. Sparser waypoints = fewer turns but
// looser shape. (Map-matching the raw sketch was tested: it fragments and zig-zags.)
export async function snap(pts: LL[], mode: Mode, spacing: number): Promise<LL[]> {
  const s = simplify(pts, spacing / 4)
  const w = waypoints(s, spacing)
  const spikes = s.filter((p, i) => i && i < s.length - 1 && bend(s[i - 1], p, s[i + 1]) > (100 * Math.PI) / 180)
  const out: LL[] = []
  // Public server allows 10 locations per request; chunks share their end points.
  for (let i = 0; i < w.length - 1; i += 9) {
    if (i) await sleep(1000) // fair use: ~1 req/s
    const chunk = w.slice(i, i + 10)
    const locations = chunk.map((p, k) => ({ ...toLoc(p), type: k && k < chunk.length - 1 ? 'via' : 'break' }))
    out.push(...shapeOf(await valhalla('route', { locations, ...costing(mode) })))
  }
  return removeSpurs(resample(out, 10), 2 * spacing, spikes)
}

export const toGpx = (pts: LL[], name: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="routeGPX" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>${name}</name><trkseg>
${pts.map(([lat, lon]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join('\n')}
</trkseg></trk>
</gpx>
`
