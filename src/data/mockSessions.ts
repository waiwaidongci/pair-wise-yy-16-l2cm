import type { CurveTemplate, FiringPoint, KilnSession, LegacyKilnSession } from '../types/firing'
import { createActualSamples } from '../utils/curve'

// 旧窑次数据没有修订号：points 直接产出无 rev 的结构，
// 由 store 载入时调用 ensureRevisions 按现有内容补齐。
function points(values: Array<[number, number]>, prefix: string) {
  return values.map(([timeMin, tempC], index) => ({
    id: `point-${prefix}-${index}`,
    timeMin,
    tempC,
  })) as unknown as FiringPoint[]
}

function templatePoints(values: Array<[number, number]>) {
  return values.map(([timeMin, tempC]) => ({ timeMin, tempC }))
}

export const MOCK_TEMPLATES: CurveTemplate[] = [
  {
    id: 'template-celadon',
    name: '青瓷标准烧成',
    clay: '青瓷泥',
    glaze: '天青釉',
    peakTempC: 1260,
    description: '慢速氧化升温，1260 ℃ 保温 25 分钟，300–700 ℃ 区间缓冷。',
    points: templatePoints([
      [0, 22],
      [90, 520],
      [120, 520],
      [240, 980],
      [300, 980],
      [410, 1260],
      [435, 1260],
      [720, 80],
    ]),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'template-stoneware',
    name: '炻器高温还原',
    clay: '炻器泥',
    glaze: '柴烧落灰釉',
    peakTempC: 1285,
    description: '前段稳定脱水，后段提升升温速率，峰值保温 20 分钟后自然缓冷。',
    points: templatePoints([
      [0, 24],
      [65, 460],
      [100, 460],
      [235, 1000],
      [285, 1000],
      [385, 1285],
      [405, 1285],
      [680, 90],
    ]),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'template-crystal',
    name: '结晶釉控温曲线',
    clay: '高白泥',
    glaze: '结晶釉',
    peakTempC: 1210,
    description: '达到峰值后快速降至析晶温度，并保留 50 分钟晶体生长平台。',
    points: templatePoints([
      [0, 20],
      [85, 520],
      [115, 520],
      [230, 1040],
      [275, 1040],
      [370, 1210],
      [425, 1080],
      [475, 1080],
      [620, 80],
    ]),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'template-raku',
    name: '乐烧快速烧成',
    clay: '粗陶泥',
    glaze: '乐烧釉',
    peakTempC: 980,
    description: '短周期快速升温至 980 ℃，出窑后迅速还原冷却。',
    points: templatePoints([
      [0, 20],
      [35, 380],
      [55, 720],
      [85, 980],
      [100, 980],
      [115, 120],
    ]),
    updatedAt: new Date().toISOString(),
  },
]

const sessionDefinitions: Array<{
  id: string
  name: string
  kiln: string
  clay: string
  glaze: string
  firedAt: string
  status: KilnSession['status']
  pointValues: Array<[number, number]>
  offset: number
}> = [
  {
    id: 'kiln-session-20261002',
    name: '青瓷三号窑次',
    kiln: '气窑 3 号',
    clay: '青瓷泥',
    glaze: '天青釉',
    firedAt: '2026-10-02 18:30',
    status: 'completed',
    pointValues: [
      [0, 22],
      [82, 480],
      [115, 480],
      [220, 930],
      [280, 930],
      [395, 1260],
      [420, 1260],
      [700, 85],
    ],
    offset: 3,
  },
  {
    id: 'kiln-session-20260928',
    name: '柴烧六号窑次',
    kiln: '柴窑 6 号',
    clay: '炻器泥',
    glaze: '柴烧落灰釉',
    firedAt: '2026-09-28 09:10',
    status: 'review',
    pointValues: [
      [0, 26],
      [70, 520],
      [95, 520],
      [235, 1000],
      [270, 1000],
      [370, 1285],
      [390, 1285],
      [650, 95],
    ],
    offset: -4,
  },
  {
    id: 'kiln-session-20260920',
    name: '结晶釉试验窑次',
    kiln: '电窑 1 号',
    clay: '高白泥',
    glaze: '结晶釉',
    firedAt: '2026-09-20 14:00',
    status: 'draft',
    pointValues: [
      [0, 20],
      [78, 520],
      [105, 520],
      [220, 1040],
      [255, 1040],
      [340, 1210],
      [380, 1080],
      [420, 1080],
      [560, 80],
    ],
    offset: 6,
  },
]

export function createMockSessions(): LegacyKilnSession[] {
  return sessionDefinitions.map((definition, index) => {
    const sessionPoints = points(definition.pointValues, definition.id)
    return {
      id: definition.id,
      name: definition.name,
      kiln: definition.kiln,
      clay: definition.clay,
      glaze: definition.glaze,
      firedAt: definition.firedAt,
      status: definition.status,
      timeOffsetMin: definition.offset,
      points: sessionPoints,
      actualSamples: createActualSamples(sessionPoints, index + 3),
    } as unknown as LegacyKilnSession
  })
}
