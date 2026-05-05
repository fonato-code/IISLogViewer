/**
 * Parser e agregações IIS — sem módulos ES (uso via window.IisLogCore).
 */
;(function () {
  const IP4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

  function estimateLineCount(text) {
    let n = 0
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) n++
    }
    if (text.length && text.charCodeAt(text.length - 1) !== 10) n++
    return n
  }

  function parseFieldsDirective(line) {
    const m = line.match(/^#\s*Fields:\s*(.+)$/i)
    if (!m) return null
    return m[1].trim().split(/\s+/).filter(Boolean)
  }

  /** Parte variável entre colunas fixas iniciais e o bloco final a partir de sc-status. */
  function splitUaRefererMiddle(middleTokens) {
    if (!middleTokens.length) return ['', '']
    const refTok = middleTokens[middleTokens.length - 1]
    let refStart = middleTokens.length - 1
    if (refTok && refTok !== '-' && !/^https?:\/\//i.test(refTok)) {
      let found = -1
      for (let j = middleTokens.length - 1; j >= 0; j--) {
        if (middleTokens[j] === '-' || /^https?:\/\//i.test(middleTokens[j])) {
          found = j
          break
        }
      }
      if (found === -1) return null
      refStart = found
    }
    const ua = middleTokens.slice(0, refStart).join(' ')
    const referer = middleTokens.slice(refStart).join(' ')
    return [ua, referer]
  }

  function looksLikeIpToken(s) {
    if (!s) return false
    return IP4.test(s) || s.includes(':')
  }

  function parseLine(line, fields) {
    if (!line) return null
    const trimmed = line.replace(/^\uFEFF/, '')
    if (trimmed.startsWith('#')) return null

    const tokens = trimmed.split(' ')
    const n = fields.length
    const iUa = fields.indexOf('cs(User-Agent)')
    const iRef = fields.indexOf('cs(Referer)')
    const iSc = fields.indexOf('sc-status')
    if (iSc < 0) return null

    const tailCount = n - iSc
    const headFieldEnd = iUa >= 0 ? iUa : iSc
    if (tokens.length < headFieldEnd + tailCount) return null
    const tailVals = tokens.slice(-tailCount)
    if (tailVals.length !== tailCount) return null

    const rest = tokens.slice(0, tokens.length - tailCount)

    if (rest.length < headFieldEnd) return null
    const headTokens = rest.slice(0, headFieldEnd)
    const middleTokens = rest.slice(headFieldEnd)

    let ua = ''
    let referer = ''
    if (iUa >= 0) {
      if (iRef > iUa) {
        const pair = splitUaRefererMiddle(middleTokens)
        if (!pair) return null
        ;[ua, referer] = pair
      } else {
        ua = middleTokens.join(' ')
      }
    } else if (middleTokens.length) {
      return null
    }

    if (headTokens.length !== headFieldEnd) return null

    const si = fields.indexOf('s-ip')
    const ci = fields.indexOf('c-ip')
    if (si >= 0 && si < headFieldEnd && !looksLikeIpToken(headTokens[si])) return null
    if (ci >= 0 && ci < headFieldEnd && !looksLikeIpToken(headTokens[ci])) return null

    const row = {}
    for (let fi = 0; fi < n; fi++) {
      const name = fields[fi]
      if (fi >= iSc) {
        row[name] = tailVals[fi - iSc]
      } else if (iUa >= 0 && fi < iUa) {
        row[name] = headTokens[fi]
      } else if (iUa < 0 && fi < iSc) {
        row[name] = headTokens[fi]
      } else if (fi === iUa && iUa >= 0) {
        row[name] = ua
      } else if (fi === iRef && iRef >= 0) {
        row[name] = referer
      } else {
        return null
      }
    }

    return normalizeRow(row)
  }

  function normalizeRow(row) {
    const date = row.date
    const time = row.time
    if (!date || !time) return null

    /** IIS grava data/hora em UTC (GMT); sem sufixo o JS interpretaria como horário local. */
    const timestamp = Date.parse(`${date}T${time.trim()}Z`)
    const timeTaken = parseInt(row['time-taken'], 10)
    const scStatus = parseInt(row['sc-status'], 10)
    const rawSub = row['sc-substatus']
    const subParsed =
      rawSub === undefined || rawSub === '' || rawSub == null
        ? 0
        : parseInt(String(rawSub).trim(), 10)
    const substatus = Number.isFinite(subParsed) ? subParsed : 0
    if (!Number.isFinite(timeTaken) || !Number.isFinite(timestamp)) return null

    return {
      timestamp,
      date,
      time,
      method: row['cs-method'] || '',
      stem: row['cs-uri-stem'] || '',
      query: row['cs-uri-query'] || '',
      clientIp: row['c-ip'] || '',
      status: scStatus,
      substatus,
      timeTaken,
      bytesSent: parseInt(row['sc-bytes'], 10) || 0,
      bytesIn: parseInt(row['cs-bytes'], 10) || 0,
      userAgent: row['cs(User-Agent)'] || '',
      referer: row['cs(Referer)'] || '',
    }
  }

  async function parseIisLogText(text, options) {
    const chunkSize = options.chunkSize ?? 12_000
    const onProgress = options.onProgress ?? (() => {})
    const maxRows = options.maxRows ?? 350_000
    const sampleEvery = Math.max(1, options.sampleEvery | 0 || 1)

    const lines = text.split(/\r?\n/)
    let fields = null
    const rows = []
    let i = 0
    let lineNum = 0
    const total = lines.length

    const flushChunk = () =>
      new Promise((resolve) => {
        const end = Math.min(i + chunkSize, total)
        for (; i < end; i++) {
          const raw = lines[i]
          if (!raw) continue
          const line = raw.replace(/^\uFEFF/, '')
          if (/^#\s*fields:/i.test(line)) {
            fields = parseFieldsDirective(line)
            continue
          }
          if (line.startsWith('#') || !fields) continue
          lineNum++
          if (sampleEvery > 1 && lineNum % sampleEvery !== 0) continue
          const row = parseLine(line, fields)
          if (row) {
            rows.push(row)
            if (rows.length >= maxRows) {
              i = total
              break
            }
          }
        }
        onProgress({
          parsed: rows.length,
          lineIndex: i,
          totalLines: total,
          lineNum,
          sampled: sampleEvery > 1,
        })
        queueMicrotask(resolve)
      })

    while (i < total && rows.length < maxRows) {
      await flushChunk()
    }

    if (!fields) {
      throw new Error('Cabeçalho #Fields não encontrado no arquivo.')
    }

    const need = ['date', 'time', 'cs-method', 'cs-uri-stem', 'c-ip', 'time-taken', 'sc-status']
    const missing = need.filter((k) => !fields.includes(k))
    return {
      rows,
      fields,
      missingFields: missing,
      truncated: rows.length >= maxRows,
      sampleEvery,
    }
  }

  function bucketKey(ts, bucketMs) {
    return Math.floor(ts / bucketMs) * bucketMs
  }

  function suggestBucketMs(minTs, maxTs, targetBuckets = 120) {
    const span = Math.max(maxTs - minTs, 60_000)
    const raw = span / targetBuckets
    const steps = [1000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 3_600_000]
    return steps.find((s) => s >= raw) ?? steps[steps.length - 1]
  }

  function timelineBuckets(rows, bucketMs) {
    const map = new Map()
    for (const r of rows) {
      const k = bucketKey(r.timestamp, bucketMs)
      let b = map.get(k)
      if (!b) {
        b = { sum: 0, max: 0, min: Number.POSITIVE_INFINITY, count: 0 }
        map.set(k, b)
      }
      b.sum += r.timeTaken
      b.max = Math.max(b.max, r.timeTaken)
      b.min = Math.min(b.min, r.timeTaken)
      b.count += 1
    }
    const keys = [...map.keys()].sort((a, b) => a - b)
    return keys.map((k) => {
      const b = map.get(k)
      const minMs = b.count && Number.isFinite(b.min) ? b.min : 0
      return {
        t: k,
        avg: b.count ? Math.round(b.sum / b.count) : 0,
        max: b.max,
        min: minMs,
        count: b.count,
      }
    })
  }

  function topEndpoints(rows, limit = 15, stemKeyFn) {
    const keyStem = typeof stemKeyFn === 'function' ? stemKeyFn : (r) => r.stem
    const map = new Map()
    for (const r of rows) {
      const stem = keyStem(r)
      const key = `${r.method} ${stem}`
      let e = map.get(key)
      if (!e) {
        e = { key, method: r.method, stem, sum: 0, max: 0, count: 0 }
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

  function topClientIps(rows, limit = 12) {
    const map = new Map()
    for (const r of rows) {
      map.set(r.clientIp, (map.get(r.clientIp) || 0) + 1)
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([ip]) => ip)
  }

  function ipSlowTimeline(rows, bucketMs, ips, slowThresholdMs) {
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
    const datasets = ips.map((ip) => {
      const data = labels.map((t) => map.get(`${t}|${ip}`) || 0)
      return { ip, data }
    })
    return { labels, datasets }
  }

  function statusMix(rows) {
    const map = new Map()
    for (const r of rows) {
      map.set(r.status, (map.get(r.status) || 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }

  /** Contagem por `sc-substatus` para linhas com `sc-status` = mainStatus. */
  function statusSubMix(rows, mainStatus) {
    const target = mainStatus | 0
    const map = new Map()
    for (const r of rows) {
      if ((r.status | 0) !== target) continue
      const sub = Number.isFinite(Number(r.substatus)) ? Number(r.substatus) : 0
      map.set(sub, (map.get(sub) || 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
  }

  window.IisLogCore = {
    estimateLineCount,
    parseIisLogText,
    suggestBucketMs,
    timelineBuckets,
    topEndpoints,
    topClientIps,
    ipSlowTimeline,
    statusMix,
    statusSubMix,
  }
})()
