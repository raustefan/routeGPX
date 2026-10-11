import assert from 'node:assert'
import { decodePolyline6, distance, length, removeSpurs, resample, simplify, toGpx, transform, type LL } from './route.ts'

// Valhalla docs example polyline6
assert.deepStrictEqual(decodePolyline6('_izlhA~rlgdF_{geC~ywl@'), [[38.5, -120.2], [40.7, -120.95]])

const line: LL[] = [[52.5, 13.4], [52.51, 13.4]] // ~1112 m north
const pts = resample(line, 100)
assert.equal(pts.length, 13)
assert.ok(Math.abs(length(pts) - length(line)) < 1e-6)
assert.ok(toGpx(line, 'x').includes('<trkpt lat="52.510000" lon="13.400000"/>'))
console.log('ok')

// transform: scale 2× + rotate 90° CCW about c moves a point 100 m east to 200 m north
const c: LL = [52.5, 13.4]
const east: LL = [52.5, 13.4 + 100 / (111320 * Math.cos((52.5 * Math.PI) / 180))]
const [moved] = transform([east], c, 2, Math.PI / 2)
assert.ok(Math.abs(distance(c, moved) - 200) < 1 && moved[0] > c[0] && Math.abs(moved[1] - c[1]) < 1e-9)

// removeSpurs: out-and-back detour is cut, the straight line survives
const spur: LL[] = [[52.5, 13.4], [52.5005, 13.4], [52.5005, 13.402], [52.5005, 13.4], [52.501, 13.4]] // 135 m spur east
const cut = removeSpurs(resample(spur, 10), 400)
assert.ok(cut.every(([, lon]) => lon < 13.4001) && Math.abs(length(cut) - 111) < 5)
// …unless its tip is a real spike of the shape
assert.equal(removeSpurs(resample(spur, 10), 400, [[52.5005, 13.402]]).length, resample(spur, 10).length)
// …but straight lines and corners are left alone
const corner = resample([[52.5, 13.4], [52.502, 13.4], [52.502, 13.403]], 10)
assert.equal(removeSpurs(corner, 400).length, corner.length)
// simplify keeps the corners of a closed shape (start == end)
const square: LL[] = [[52.5, 13.4], [52.5, 13.405], [52.5, 13.41], [52.505, 13.41], [52.51, 13.41], [52.51, 13.4], [52.5, 13.4]]
assert.equal(simplify(square, 20).length, 5) // mid-edge points dropped, corners kept
console.log('ok transform/spurs')
