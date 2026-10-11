import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { length, snap, toGpx, transform, turns, type LL, type Mode } from './route.ts'

// Sample every drawable element of an SVG into screen-space points.
function svgPoints(text: string): [number, number][] {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  doc.querySelectorAll('script, foreignObject').forEach((el) => el.remove())
  doc.querySelectorAll('*').forEach((el) =>
    [...el.attributes].forEach((a) => a.name.startsWith('on') && el.removeAttribute(a.name)),
  )
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement
  svg.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0'
  document.body.appendChild(svg)
  try {
    const els = [...svg.querySelectorAll<SVGGeometryElement>('path, polyline, polygon, line, rect, circle, ellipse')]
    const lens = els.map((el) => el.getTotalLength())
    const total = lens.reduce((a, b) => a + b, 0)
    return els.flatMap((el, i) => {
      const n = Math.max(2, Math.ceil((lens[i] / total) * 500))
      const m = el.getScreenCTM()!
      return Array.from({ length: n + 1 }, (_, k) => {
        const p = el.getPointAtLength((lens[i] * k) / n).matrixTransform(m)
        return [p.x, p.y] as [number, number]
      })
    })
  } finally {
    svg.remove()
  }
}

// Fit points into the middle 60% of the current map view.
function placeOnMap(map: L.Map, pts: [number, number][]): LL[] {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)]
  const w = Math.max(...xs) - minX || 1, h = Math.max(...ys) - minY || 1
  const size = map.getSize()
  const s = (0.6 * Math.min(size.x, size.y)) / Math.max(w, h)
  const ox = (size.x - w * s) / 2, oy = (size.y - h * s) / 2
  return pts.map(([x, y]) => {
    const ll = map.containerPointToLatLng([ox + (x - minX) * s, oy + (y - minY) * s])
    return [ll.lat, ll.lng]
  })
}

const handle = (cls: string, label: string) =>
  L.divIcon({ className: `handle ${cls}`, html: label, iconSize: [36, 36] })

export default function App() {
  const mapEl = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map>(null)
  const sketchLine = useRef<L.Polyline>(null)
  const routeLine = useRef<L.Polyline>(null)
  const [mode, setMode] = useState<Mode>('run')
  const [spacing, setSpacing] = useState(350)
  const [drawing, setDrawing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sketch, setSketch] = useState<LL[]>([])
  const [route, setRoute] = useState<LL[]>([])
  const [status, setStatus] = useState('Draw a shape or upload an SVG.')
  const latest = useRef(sketch) // drop Fit results for a shape that has since been edited
  latest.current = sketch

  useEffect(() => {
    const m = L.map(mapEl.current!, { zoomControl: false }).setView([52.52, 13.405], 14)
    L.control.zoom({ position: 'topright' }).addTo(m)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap · routing: Valhalla/FOSSGIS',
    }).addTo(m)
    sketchLine.current = L.polyline([], { color: '#333', weight: 3, dashArray: '6 6' }).addTo(m)
    routeLine.current = L.polyline([], { color: '#fc4c02', weight: 5 }).addTo(m)
    navigator.geolocation?.getCurrentPosition((p) => m.setView([p.coords.latitude, p.coords.longitude], 15))
    map.current = m
    return () => void m.remove()
  }, [])

  // Freehand drawing with pointer events (mouse, touch, pen).
  useEffect(() => {
    const m = map.current!, el = mapEl.current!
    if (!drawing) return
    m.dragging.disable()
    m.touchZoom.disable()
    let pts: LL[] | null = null
    const at = (e: PointerEvent): LL => {
      const ll = m.mouseEventToLatLng(e)
      return [ll.lat, ll.lng]
    }
    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId)
      pts = [at(e)]
    }
    const move = (e: PointerEvent) => {
      if (!pts) return
      pts.push(at(e))
      sketchLine.current!.setLatLngs(pts)
    }
    const up = () => {
      if (pts && pts.length > 1) setSketch(pts)
      pts = null
      setDrawing(false)
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    return () => {
      m.dragging.enable()
      m.touchZoom.enable()
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
  }, [drawing])

  // Any edit to the shape invalidates the snapped route.
  useEffect(() => {
    sketchLine.current!.setLatLngs(sketch)
    setRoute([])
    setStatus(sketch.length > 1
      ? `Shape: ${(length(sketch) / 1000).toFixed(1)} km. Drag ✥ to move, ⤡ to scale/rotate, then Fit.`
      : 'Draw a shape or upload an SVG.')
  }, [sketch, mode, spacing])

  // Move handle at the center, scale/rotate handle at the top-right corner.
  useEffect(() => {
    if (sketch.length < 2 || drawing) return
    const m = map.current!, line = sketchLine.current!
    const b = L.latLngBounds(sketch)
    const c: LL = [b.getCenter().lat, b.getCenter().lng]
    const corner: LL = [b.getNorth(), b.getEast()]
    const k = Math.cos((c[0] * Math.PI) / 180)
    const pos = (mk: L.Marker): LL => [mk.getLatLng().lat, mk.getLatLng().lng]
    let next = sketch

    const mover = L.marker(c, { draggable: true, icon: handle('move', '✥') }).addTo(m)
    const scaler = L.marker(corner, { draggable: true, icon: handle('scale', '⤡') }).addTo(m)
    mover.on('drag', () => {
      const p = pos(mover)
      next = transform(sketch, c, 1, 0, [p[0] - c[0], p[1] - c[1]])
      line.setLatLngs(next)
      scaler.setLatLng([corner[0] + p[0] - c[0], corner[1] + p[1] - c[1]])
    })
    scaler.on('drag', () => {
      const p = pos(scaler)
      const [x0, y0] = [(corner[1] - c[1]) * k, corner[0] - c[0]]
      const [x1, y1] = [(p[1] - c[1]) * k, p[0] - c[0]]
      const f = Math.hypot(x1, y1) / Math.hypot(x0, y0)
      next = transform(sketch, c, f, Math.atan2(y1, x1) - Math.atan2(y0, x0))
      line.setLatLngs(next)
    })
    mover.on('dragend', () => setSketch(next))
    scaler.on('dragend', () => setSketch(next))
    return () => void [mover, scaler].forEach((mk) => mk.remove())
  }, [sketch, drawing])

  useEffect(() => void routeLine.current!.setLatLngs(route), [route])

  async function fit() {
    setBusy(true)
    setStatus(`Fitting to ${mode === 'run' ? 'running' : 'cycling'} paths…`)
    try {
      const r = await snap(sketch, mode, spacing)
      if (latest.current !== sketch) return
      setRoute(r)
      setStatus(`Route: ${(length(r) / 1000).toFixed(2)} km · ${turns(r)} turns`)
    } catch (e) {
      setStatus(`Fitting failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function upload(file: File) {
    try {
      const pts = svgPoints(await file.text())
      if (pts.length < 2) throw new Error('no shapes found')
      setSketch(placeOnMap(map.current!, pts))
    } catch (e) {
      setStatus(`Could not read SVG: ${(e as Error).message}`)
    }
  }

  function exportGpx() {
    const blob = new Blob([toGpx(route, `routeGPX ${mode}`)], { type: 'application/gpx+xml' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `route-${mode}.gpx`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <>
      <div id="map" ref={mapEl} className={drawing ? 'drawing' : ''} />
      <div className="panel">
        <div className="status" aria-live="polite">{status}</div>
        <div className="row">
          <div className="seg">
            <button className={mode === 'run' ? 'on' : ''} onClick={() => setMode('run')}>🏃 Run</button>
            <button className={mode === 'bike' ? 'on' : ''} onClick={() => setMode('bike')}>🚴 Bike</button>
          </div>
          <button className={drawing ? 'on' : ''} onClick={() => setDrawing(!drawing)}>
            {drawing ? 'Drag on map…' : '✏️ Draw'}
          </button>
          <label className="btn">
            📄 SVG
            <input type="file" accept=".svg,image/svg+xml" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }} />
          </label>
        </div>
        <label className="detail">
          <span>Fewer turns</span>
          <input type="range" min={150} max={800} step={50} value={950 - spacing}
            onChange={(e) => setSpacing(950 - +e.target.value)} />
          <span>Closer to shape</span>
        </label>
        <div className="row">
          <button disabled={!sketch.length || busy} onClick={() => setSketch([])}>Clear</button>
          <button className="primary" disabled={sketch.length < 2 || busy} onClick={fit}>
            {busy ? 'Fitting…' : '🧲 Fit'}
          </button>
          <button disabled={!route.length || busy} onClick={exportGpx}>⬇️ GPX</button>
        </div>
      </div>
    </>
  )
}
