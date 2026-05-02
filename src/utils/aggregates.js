function bucketKey(ts, bucketMs) {
  return Math.floor(ts / bucketMs) * bucketMs
}

export function suggestBucketMs(minTs, maxTs, targetBuckets = 120) {
  const span = Math.max(maxTs - minTs, 60_000)
  const raw = span / targetBuckets
  const steps = [1000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 3_600_000]
  return steps.find((s) => s >= raw) ?? steps[steps.length - 1]
}

export function timelineBuckets(rows, bucketMs) {
  const map = new Map()
  for (const r of rows) {
    const k = bucketKey(r.timestamp, bucketMs)
    let b = map.get(k)
    if (!b) {
      b = { sum: 0, max: 0, count: 0 }
      map.set(k, b)
    }
    b.sum += r.timeTaken
    b.max = Math.max(b.max, r.timeTaken)
    b.count += 1
  }
  const keys = [...map.keys()].sort((a, b) => a - b)
  return keys.map((k) => {
    const b = map.get(k)
    return {
      t: k,
      avg: b.count ? Math.round(b.sum / b.count) : 0,
      max: b.max,
      count: b.count,
    }
  })
}

export function topEndpoints(rows, limit = 15) {
  const map = new Map()
  for (const r of rows) {
    const key = `${r.method} ${r.stem}`
    let e = map.get(key)
    if (!e) {
      e = { key, method: r.method, stem: r.stem, sum: 0, max: 0, count: 0 }
      map.set(key, e)
    }
    e.sum += r.timeTaken
    e.max = Math.max(e.max, r.timeTaken)
    e.count += 1
  }
  return [...map.values()]
    .map((e) => ({
      ...e,
      avg: Math.round(e.sum / e.count),
    }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, limit)
}

export function topClientIps(rows, limit = 12) {
  const map = new Map()
  for (const r of rows) {
    map.set(r.clientIp, (map.get(r.clientIp) || 0) + 1)
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ip]) => ip)
}

export function ipSlowTimeline(rows, bucketMs, ips, slowThresholdMs) {
  const set = new Set(ips)
  const map = new Map()
  for (const r of rows) {
    if (!set.has(r.clientIp)) continue
    if (r.timeTaken < slowThresholdMs) continue
    const k = bucketKey(r.timestamp, bucketMs)
    const ik = `${k}|${r.clientIp}`
    map.set(ik, (map.get(ik) || 0) + 1)
  }
  const bucketSet = new Set()
  for (const key of map.keys()) {
    bucketSet.add(Number(key.split('|')[0]))
  }
  const labels = [...bucketSet].sort((a, b) => a - b)
  const datasets = ips.map((ip, idx) => {
    const data = labels.map((t) => map.get(`${t}|${ip}`) || 0)
    return { ip, data }
  })
  return { labels, datasets }
}

export function statusMix(rows) {
  const map = new Map()
  for (const r of rows) {
    map.set(r.status, (map.get(r.status) || 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}
