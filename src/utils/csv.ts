import type { FiringSample } from '../types/firing'

/** CSV \u89E3\u6790\u51FA\u7684\u91C7\u6837\u5C1A\u672A\u5206\u914D\u4FEE\u8BA2\u53F7\uFF0C\u5BFC\u5165 store \u65F6\u7EDF\u4E00\u8D4B rev */
type ParsedSample = Omit<FiringSample, 'rev'>

export function parseTemperatureCsv(content: string): ParsedSample[] {
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map((value) => value.trim().toLowerCase())
  const timeIndex = headers.findIndex((header) =>
    ['time', 'minute', 'minutes', '时间', '分钟', '经过时间'].includes(header),
  )
  const tempIndex = headers.findIndex((header) =>
    ['temp', 'temperature', 'temperature_c', '温度', '温度c', '实测温度'].includes(header),
  )
  const actualTimeIndex = timeIndex >= 0 ? timeIndex : 0
  const actualTempIndex = tempIndex >= 0 ? tempIndex : 1
  return lines.slice(1).flatMap((line, index) => {
    const values = line.split(',')
    const rawTime = values[actualTimeIndex]?.trim() ?? ''
    const rawTemp = values[actualTempIndex]?.trim() ?? ''
    const timeValue = Number(rawTime)
    const tempValue = Number(rawTemp)
    if (Number.isNaN(timeValue) || Number.isNaN(tempValue)) return []
    const isTimecode = rawTime.includes(':')
    const timeMin = isTimecode
      ? rawTime.split(':').reduce((total, value) => total * 60 + Number(value), 0) / 60
      : timeValue
    return [
      {
        id: `csv-${Date.now()}-${index}`,
        timeMin: Number(timeMin.toFixed(2)),
        tempC: tempValue,
      },
    ]
  })
}

export function downloadText(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
