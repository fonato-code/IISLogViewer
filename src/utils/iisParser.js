/**
 * Parser para logs W3C estendidos do IIS (#Fields dinâmico).
 */

const IP4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

export function estimateLineCount(text) {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++
  }
  if (text.length && text.charCodeAt(text.length - 1) !== 10) n++
  return n
}

function parseFieldsDirective(line) {
  const m = line.match(/^#Fields:\s*(.+)$/i)
  if (!m) return null
  return m[1].trim().split(/\s+/).filter(Boolean)
}

function parseLine(line, fields) {
  if (!line || line.startsWith('#')) return null
  const tokens = line.split(' ')
  const n = fields.length
  if (tokens.length < 9 + 6) return null

  const tail = 6
  const statusIdx = tokens.length - tail
  const tailVals = tokens.slice(statusIdx)
  if (!tailVals.every((t, i) => i < 3 || /^-?\d+$/.test(t))) return null

  const refTok = tokens[statusIdx - 1]
  let refStart = statusIdx - 1
  if (refTok && refTok !== '-' && !/^https?:\/\//i.test(refTok)) {
    let found = -1
    for (let j = statusIdx - 1; j >= 9; j--) {
      if (tokens[j] === '-' || /^https?:\/\//i.test(tokens[j])) {
        found = j
        break
      }
    }
    if (found === -1) return null
    refStart = found
  }

  const ua = tokens.slice(9, refStart).join(' ')
  const referer = tokens.slice(refStart, statusIdx).join(' ')
  const head = tokens.slice(0, 9)

  if (!IP4.test(head[2]) || !IP4.test(head[8])) return null

  const values = [...head, ua, referer, ...tailVals]
  if (values.length !== n) return null

  const row = {}
  fields.forEach((f, i) => {
    row[f] = values[i]
  })
  return normalizeRow(row)
}

function normalizeRow(row) {
  const date = row.date
  const time = row.time
  if (!date || !time) return null

  const timestamp = Date.parse(`${date}T${time}`)
  const timeTaken = parseInt(row['time-taken'], 10)
  const scStatus = parseInt(row['sc-status'], 10)
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
    timeTaken,
    bytesSent: parseInt(row['sc-bytes'], 10) || 0,
    bytesIn: parseInt(row['cs-bytes'], 10) || 0,
    userAgent: row['cs(User-Agent)'] || '',
    referer: row['cs(Referer)'] || '',
  }
}

/**
 * @param {string} text
 * @param {{ chunkSize?: number, onProgress?: Function, maxRows?: number, sampleEvery?: number }} options
 */
export async function parseIisLogText(text, options = {}) {
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
        const line = lines[i]
        if (!line) continue
        if (line.startsWith('#Fields:')) {
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
