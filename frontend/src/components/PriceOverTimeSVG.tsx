// Hand-rolled SVG price-over-time chart — no external charting library (matching the
// platform house style; see baxter/winemaster SurplusScatterSVG). Takes an svgRef so the
// Reports page can grab .outerHTML and open it in a projector window.
//
// One STAIRCASE line per group. X = elapsed seconds from THAT group's auction start
// (0 → durationSeconds), so groups that started at different wall-clock times overlay
// cleanly and are directly comparable. A staircase (step-after) is used rather than a
// straight line-between-dots: the auction price is CONSTANT between bids and JUMPS at each
// bid, so the staircase is the honest shape — and it makes end-of-auction sniping (a tall
// late vertical jump near the right edge) visually unmistakable. Dots mark each actual bid.

import type { GroupSeries } from '../api'

const COLORS = ['#1a73e8', '#137333', '#c5221f', '#8a6d00', '#8430ce', '#0b8043', '#d93025']

const W = 900, H = 520
const PAD = { top: 24, right: 24, bottom: 52, left: 68 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

function niceMax(v: number): number {
  if (v <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}

function ticks(max: number, count = 5): number[] {
  const out: number[] = []
  for (let i = 0; i <= count; i++) out.push(Math.round((max / count) * i))
  return out
}

export interface PriceOverTimeSVGProps {
  series: GroupSeries[]
  svgRef?: React.Ref<SVGSVGElement>
}

export default function PriceOverTimeSVG({ series, svgRef }: PriceOverTimeSVGProps) {
  const withData = series.filter(s => s.points.length > 0)
  const maxT = niceMax(Math.max(1, ...withData.map(s => s.duration_seconds), ...withData.flatMap(s => s.points.map(p => p.t))))
  const maxP = niceMax(Math.max(1, ...withData.flatMap(s => s.points.map(p => p.price))))

  const xOf = (t: number) => PAD.left + (t / maxT) * PLOT_W
  const yOf = (p: number) => PAD.top + PLOT_H - (p / maxP) * PLOT_H

  // Staircase path: hold price flat to the next bid's time, then jump.
  const stairPath = (pts: Array<{ t: number; price: number }>): string => {
    const sorted = [...pts].sort((a, b) => a.t - b.t)
    if (sorted.length === 0) return ''
    let d = `M ${xOf(sorted[0].t)} ${yOf(sorted[0].price)}`
    for (let i = 1; i < sorted.length; i++) {
      d += ` L ${xOf(sorted[i].t)} ${yOf(sorted[i - 1].price)}`   // hold flat
      d += ` L ${xOf(sorted[i].t)} ${yOf(sorted[i].price)}`       // jump
    }
    return d
  }

  const xTicks = ticks(maxT)
  const yTicks = ticks(maxP)

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, fontFamily: 'system-ui, sans-serif', background: '#fff' }} role="img" aria-label="Auction price over time by group">
      {/* Y gridlines + labels */}
      {yTicks.map(v => (
        <g key={`y${v}`}>
          <line x1={PAD.left} y1={yOf(v)} x2={W - PAD.right} y2={yOf(v)} stroke="#eee" strokeWidth={1} />
          <text x={PAD.left - 8} y={yOf(v) + 4} textAnchor="end" fontSize={12} fill="#666">${v.toLocaleString('en-US')}</text>
        </g>
      ))}
      {/* X ticks + labels */}
      {xTicks.map(t => (
        <g key={`x${t}`}>
          <line x1={xOf(t)} y1={PAD.top} x2={xOf(t)} y2={PAD.top + PLOT_H} stroke="#f4f4f4" strokeWidth={1} />
          <text x={xOf(t)} y={PAD.top + PLOT_H + 20} textAnchor="middle" fontSize={12} fill="#666">{t}s</text>
        </g>
      ))}
      {/* Axes */}
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + PLOT_H} stroke="#999" strokeWidth={1} />
      <line x1={PAD.left} y1={PAD.top + PLOT_H} x2={W - PAD.right} y2={PAD.top + PLOT_H} stroke="#999" strokeWidth={1} />
      <text x={PAD.left + PLOT_W / 2} y={H - 12} textAnchor="middle" fontSize={13} fill="#333">Elapsed seconds since auction start</text>
      <text x={16} y={PAD.top + PLOT_H / 2} textAnchor="middle" fontSize={13} fill="#333" transform={`rotate(-90, 16, ${PAD.top + PLOT_H / 2})`}>Price</text>

      {/* One staircase per group */}
      {withData.map((s, i) => {
        const color = COLORS[i % COLORS.length]
        return (
          <g key={s.group_id}>
            <path d={stairPath(s.points)} fill="none" stroke={color} strokeWidth={2} />
            {s.points.map((p, j) => (
              <circle key={j} cx={xOf(p.t)} cy={yOf(p.price)} r={3} fill={color} />
            ))}
          </g>
        )
      })}

      {/* Legend */}
      {withData.map((s, i) => (
        <g key={`lg${s.group_id}`} transform={`translate(${PAD.left + 8}, ${PAD.top + 6 + i * 18})`}>
          <rect width={12} height={12} fill={COLORS[i % COLORS.length]} rx={2} />
          <text x={18} y={11} fontSize={12} fill="#333">Group {s.group_number ?? i + 1}</text>
        </g>
      ))}
    </svg>
  )
}
