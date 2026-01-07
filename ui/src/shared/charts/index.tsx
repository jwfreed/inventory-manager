import {
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChartData = Record<string, any>

interface BaseChartProps {
  data: ChartData[]
  height?: number
  margin?: { top?: number; right?: number; bottom?: number; left?: number }
}

interface LineChartProps extends BaseChartProps {
  xKey: string
  lines: Array<{
    key: string
    name: string
    color?: string
    strokeWidth?: number
  }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  xAxisFormatter?: (value: any) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  yAxisFormatter?: (value: any) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tooltipFormatter?: (value: any) => string
}

interface BarChartProps extends BaseChartProps {
  xKey: string
  bars: Array<{
    key: string
    name: string
    color?: string
  }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  xAxisFormatter?: (value: any) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  yAxisFormatter?: (value: any) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tooltipFormatter?: (value: any) => string
  layout?: 'horizontal' | 'vertical'
  stacked?: boolean
}

interface AreaChartProps extends BaseChartProps {
  xKey: string
  areas: Array<{
    key: string
    name: string
    color?: string
  }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  xAxisFormatter?: (value: any) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  yAxisFormatter?: (value: any) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tooltipFormatter?: (value: any) => string
  stacked?: boolean
}

// Custom tooltip component
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip(props: any) {
  const { active, payload, label, formatter } = props
  if (!active || !payload || !payload.length) return null

  return (
    <div className="bg-white border border-slate-200 shadow-lg rounded-lg p-3 text-sm">
      <p className="font-medium text-slate-900 mb-2">{label}</p>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {payload.map((entry: any, index: number) => (
        <div key={index} className="flex items-center gap-2 text-slate-700">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color as string }} />
          <span className="text-slate-600">{entry.name}:</span>
          <span className="font-medium">{formatter ? formatter(entry.value) : entry.value}</span>
        </div>
      ))}
    </div>
  )
}

export function SimpleLineChart({
  data,
  xKey,
  lines,
  height = 300,
  margin = { top: 5, right: 20, bottom: 5, left: 0 },
  xAxisFormatter,
  yAxisFormatter,
  tooltipFormatter,
}: LineChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={margin}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis
          dataKey={xKey}
          tick={{ fontSize: 12, fill: '#64748b' }}
          tickFormatter={xAxisFormatter}
          stroke="#cbd5e1"
        />
        <YAxis
          tick={{ fontSize: 12, fill: '#64748b' }}
          tickFormatter={yAxisFormatter}
          stroke="#cbd5e1"
        />
        <Tooltip content={<CustomTooltip formatter={tooltipFormatter} />} />
        <Legend
          wrapperStyle={{ fontSize: 12 }}
          iconType="line"
        />
        {lines.map((line) => (
          <Line
            key={line.key}
            type="monotone"
            dataKey={line.key}
            name={line.name}
            stroke={line.color || '#3b82f6'}
            strokeWidth={line.strokeWidth || 2}
            dot={{ fill: line.color || '#3b82f6', r: 4 }}
            activeDot={{ r: 6 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

export function SimpleBarChart({
  data,
  xKey,
  bars,
  height = 300,
  margin = { top: 5, right: 20, bottom: 5, left: 0 },
  xAxisFormatter,
  yAxisFormatter,
  tooltipFormatter,
  layout = 'horizontal',
  stacked = false,
}: BarChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={margin} layout={layout}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        {layout === 'horizontal' ? (
          <>
            <XAxis
              dataKey={xKey}
              tick={{ fontSize: 12, fill: '#64748b' }}
              tickFormatter={xAxisFormatter}
              stroke="#cbd5e1"
            />
            <YAxis
              tick={{ fontSize: 12, fill: '#64748b' }}
              tickFormatter={yAxisFormatter}
              stroke="#cbd5e1"
            />
          </>
        ) : (
          <>
            <XAxis
              type="number"
              tick={{ fontSize: 12, fill: '#64748b' }}
              tickFormatter={yAxisFormatter}
              stroke="#cbd5e1"
            />
            <YAxis
              type="category"
              dataKey={xKey}
              tick={{ fontSize: 12, fill: '#64748b' }}
              tickFormatter={xAxisFormatter}
              stroke="#cbd5e1"
            />
          </>
        )}
        <Tooltip content={<CustomTooltip formatter={tooltipFormatter} />} />
        <Legend
          wrapperStyle={{ fontSize: 12 }}
          iconType="rect"
        />
        {bars.map((bar) => (
          <Bar
            key={bar.key}
            dataKey={bar.key}
            name={bar.name}
            fill={bar.color || '#3b82f6'}
            stackId={stacked ? 'stack' : undefined}
            radius={[4, 4, 0, 0]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

export function SimpleAreaChart({
  data,
  xKey,
  areas,
  height = 300,
  margin = { top: 5, right: 20, bottom: 5, left: 0 },
  xAxisFormatter,
  yAxisFormatter,
  tooltipFormatter,
  stacked = false,
}: AreaChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={margin}>
        <defs>
          {areas.map((area) => (
            <linearGradient key={`gradient-${area.key}`} id={`color-${area.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={area.color || '#3b82f6'} stopOpacity={0.8} />
              <stop offset="95%" stopColor={area.color || '#3b82f6'} stopOpacity={0.1} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis
          dataKey={xKey}
          tick={{ fontSize: 12, fill: '#64748b' }}
          tickFormatter={xAxisFormatter}
          stroke="#cbd5e1"
        />
        <YAxis
          tick={{ fontSize: 12, fill: '#64748b' }}
          tickFormatter={yAxisFormatter}
          stroke="#cbd5e1"
        />
        <Tooltip content={<CustomTooltip formatter={tooltipFormatter} />} />
        <Legend
          wrapperStyle={{ fontSize: 12 }}
          iconType="rect"
        />
        {areas.map((area) => (
          <Area
            key={area.key}
            type="monotone"
            dataKey={area.key}
            name={area.name}
            stroke={area.color || '#3b82f6'}
            fill={`url(#color-${area.key})`}
            fillOpacity={1}
            stackId={stacked ? 'stack' : undefined}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}
