/**
 * 抽卡欧皇度
 *
 * 按出金概率模型（官方公示基础概率 + 软保底），计算与你获得同样数量UP（或五星）的玩家中，
 * 花费抽数比你多的玩家占比，即运气超过了多少玩家
 */
import lodash from "lodash"
import fs from "node:fs"
import gsCfg from "./gsCfg.js"

const distCache = {}

/** 卷积，结果只保留下标 0~limit */
function conv(a, b, limit) {
  const ret = new Array(Math.min(a.length + b.length - 1, limit + 1)).fill(0)
  for (let i = 0; i < a.length && i <= limit; i++) {
    if (!a[i]) continue
    for (let j = 0; j < b.length && i + j <= limit; j++) {
      ret[i + j] += a[i] * b[j]
    }
  }
  return ret
}

/** 标准正态分布累积概率 */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2)
  const p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z > 0 ? 1 - p : p
}

const clamp = num => Math.min(100, Math.max(0, num))

export default class GachaLuck {
  static getCfg() {
    const cfg = gsCfg.getdefSet("gacha", "luck") || {}
    // 未创建用户配置时不去读取，避免报错
    if (fs.existsSync(gsCfg.getFilePath("gacha", "luck", "config"))) {
      return { ...cfg, ...(gsCfg.getYaml("gacha", "luck", "config") || {}) }
    }
    return cfg
  }

  /** 单个五星所需抽数的概率分布 f[i] */
  static getFiveDist(m) {
    const key = `five:${m.base},${m.soft},${m.step},${m.hard}`
    if (!distCache[key]) {
      const f = [0]
      let survive = 1
      for (let i = 1; i <= m.hard; i++) {
        const p = i >= m.hard ? 1 : Math.min(1, m.base + Math.max(0, i - m.soft + 1) * m.step)
        f[i] = survive * p
        survive *= 1 - p
      }
      distCache[key] = f
    }
    return distCache[key]
  }

  /** 单个UP所需抽数的概率分布：小保底不歪直接出UP，歪了再抽一个大保底 */
  static getUpDist(m) {
    const key = `up:${m.base},${m.soft},${m.step},${m.hard},${m.upRate}`
    if (!distCache[key]) {
      const f = GachaLuck.getFiveDist(m)
      const ff = conv(f, f, m.hard * 2)
      distCache[key] = ff.map((v, i) => (f[i] || 0) * m.upRate + v * (1 - m.upRate))
    }
    return distCache[key]
  }

  static getExpect(dist) {
    return lodash.sum(dist.map((p, i) => p * i))
  }

  /** 获得 num 个目标花费 used 抽时，运气超过的玩家比例（0~100） */
  static getPercent(dist, num, used) {
    if (!(num > 0) || !(used > 0)) return false
    if (num > 50) {
      // 样本较大时用正态近似，避免精确计算耗时过长
      const mean = GachaLuck.getExpect(dist)
      const variance = lodash.sum(dist.map((p, i) => p * (i - mean) * (i - mean)))
      return clamp((1 - normCdf((used - num * mean) / Math.sqrt(num * variance))) * 100)
    }
    let total = [1]
    for (let i = 0; i < num; i++) {
      total = conv(total, dist, used)
    }
    let below = 0
    for (let i = 0; i < used && i < total.length; i++) {
      below += total[i]
    }
    return clamp((1 - below - (total[used] || 0) / 2) * 100)
  }

  /** 小保底不歪次数的二项分布百分位 */
  static getWinPercent(num, win, rate) {
    if (!(num > 0)) return false
    let below = 0
    let equal = 0
    let c = 1 // 组合数 C(num, k)
    for (let k = 0; k <= num; k++) {
      if (k > 0) c = (c * (num - k + 1)) / k
      const p = c * Math.pow(rate, k) * Math.pow(1 - rate, num - k)
      if (k < win) below += p
      else if (k === win) equal = p
    }
    return clamp((below + equal / 2) * 100)
  }

  /**
   * @param data.game gs / sr
   * @param data.type 卡池类型
   * @param data.upNum UP数量
   * @param data.upUsed 获得这些UP花费的抽数
   * @param data.fiveNum 五星数量
   * @param data.fiveUsed 获得这些五星花费的抽数
   * @param data.smallNum 小保底次数
   * @param data.smallWin 小保底不歪次数
   */
  static get(data) {
    const cfg = GachaLuck.getCfg()
    const m = cfg?.model?.[data.game]?.[data.type]
    if (!cfg.enable || !m) return false

    const fiveDist = GachaLuck.getFiveDist(m)
    const fivePercent = GachaLuck.getPercent(fiveDist, data.fiveNum, data.fiveUsed)
    if (fivePercent === false) return false

    const ret = {
      isUpPool: false,
      fiveAvg: (data.fiveUsed / data.fiveNum).toFixed(1),
      fiveExpect: GachaLuck.getExpect(fiveDist).toFixed(1),
      fivePercent: fivePercent.toFixed(1),
    }
    let percent = fivePercent
    let sample = data.fiveNum

    if (m.upRate > 0) {
      const upDist = GachaLuck.getUpDist(m)
      const upPercent = GachaLuck.getPercent(upDist, data.upNum, data.upUsed)
      // 还没有出过UP时，按出金评级
      if (upPercent !== false) {
        percent = upPercent
        sample = data.upNum
        const winPercent = GachaLuck.getWinPercent(data.smallNum, data.smallWin, m.upRate)
        Object.assign(ret, {
          isUpPool: true,
          upAvg: (data.upUsed / data.upNum).toFixed(1),
          upExpect: GachaLuck.getExpect(upDist).toFixed(1),
          upRate: Math.round(m.upRate * 100),
          winPercent: winPercent === false ? false : winPercent.toFixed(1),
        })
      }
    }

    const levels = cfg.levels || []
    const level = levels.find(ds => percent >= ds.min) || levels[levels.length - 1]
    if (!level) return false

    return {
      ...level,
      ...ret,
      percent: percent.toFixed(1),
      fewSample: sample < (cfg.minSample || 0),
    }
  }
}
