;(function () {
  const {
    estimateLineCount,
    parseIisLogText,
    suggestBucketMs,
    timelineBuckets,
    topEndpoints,
    topClientIps,
    ipSlowTimeline,
    statusMix,
  } = window.IisLogCore

  const { createApp, ref, shallowRef, computed, watch, nextTick, reactive, unref } = Vue

  const PALETTE = [
    'rgb(255, 99, 132)',
    'rgb(54, 162, 235)',
    'rgb(255, 206, 86)',
    'rgb(75, 192, 192)',
    'rgb(153, 102, 255)',
    'rgb(255, 159, 64)',
    'rgb(199, 199, 199)',
    'rgb(83, 102, 255)',
  ]

  if (typeof Chart !== 'undefined') {
    Chart.defaults.color = '#dee2e6'
    Chart.defaults.borderColor = 'rgba(255,255,255,0.08)'
  }

  /** Primeiro segmento de cs-uri-stem (ex.: /TOR_EPR_PARANA/... → TOR_EPR_PARANA) */
  function stemApplication(stem) {
    if (!stem || stem === '-') return ''
    const parts = stem.split('/').filter(Boolean)
    return parts[0] || ''
  }

  const APP_NONE = '(sem pasta raiz)'

  /** Valor do select de aplicação no modal: listar stems de todas as aplicações. */
  const MODAL_APP_ALL = '__ALL__'

  const DASHBOARD_STORAGE_KEY = 'iis-log-viewer-dashboard-layout-v1'

  const WIDGET_TYPES = {
    STAT_COUNT: 'stat-count',
    STAT_AVG: 'stat-avg',
    STAT_MAX: 'stat-max',
    STAT_RANGE: 'stat-range',
    CHART_TIMELINE: 'chart-timeline',
    CHART_STATUS: 'chart-status',
    CHART_ENDPOINTS: 'chart-endpoints',
    CHART_IPS: 'chart-ips',
    TABLE_SLOW: 'table-slow',
  }

  const ALLOWED_WIDGET_TYPES = new Set(Object.values(WIDGET_TYPES))

  function genDashboardUid() {
    return `w-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
  }

  function clampDim(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n))
  }

  function createDefaultDashboardLayout() {
    return [
      { uid: genDashboardUid(), type: WIDGET_TYPES.STAT_COUNT, colSpan: 3 },
      { uid: genDashboardUid(), type: WIDGET_TYPES.STAT_AVG, colSpan: 3 },
      { uid: genDashboardUid(), type: WIDGET_TYPES.STAT_MAX, colSpan: 3 },
      { uid: genDashboardUid(), type: WIDGET_TYPES.STAT_RANGE, colSpan: 3 },
      { uid: genDashboardUid(), type: WIDGET_TYPES.CHART_TIMELINE, colSpan: 8, heightPx: 340 },
      { uid: genDashboardUid(), type: WIDGET_TYPES.CHART_STATUS, colSpan: 4, heightPx: 340 },
      { uid: genDashboardUid(), type: WIDGET_TYPES.CHART_ENDPOINTS, colSpan: 6, heightPx: 380 },
      { uid: genDashboardUid(), type: WIDGET_TYPES.CHART_IPS, colSpan: 6, heightPx: 380 },
      { uid: genDashboardUid(), type: WIDGET_TYPES.TABLE_SLOW, colSpan: 12, heightPx: 420 },
    ]
  }

  function normalizeDashboardLayout(arr) {
    if (!Array.isArray(arr)) return []
    const seen = new Set()
    const out = []
    for (const x of arr) {
      if (!x || !ALLOWED_WIDGET_TYPES.has(x.type)) continue
      if (seen.has(x.type)) continue
      seen.add(x.type)
      const colSpan = clampDim(parseInt(x.colSpan, 10) || 6, 3, 12)
      let heightPx
      if (x.heightPx != null && Number.isFinite(Number(x.heightPx))) {
        heightPx = clampDim(Number(x.heightPx), 120, 1600)
      }
      out.push({
        uid: typeof x.uid === 'string' ? x.uid : genDashboardUid(),
        type: x.type,
        colSpan,
        heightPx,
      })
    }
    return out
  }

  function defaultWidgetHeight(type) {
    if (type === WIDGET_TYPES.CHART_TIMELINE || type === WIDGET_TYPES.CHART_STATUS) return 340
    if (type === WIDGET_TYPES.CHART_ENDPOINTS || type === WIDGET_TYPES.CHART_IPS) return 380
    if (type === WIDGET_TYPES.TABLE_SLOW) return 420
    return 220
  }

  /** Páginas / handlers dinâmicos — não entram no agrupamento “arquivo estático”. */
  const PAGE_EXTENSIONS = new Set([
    'html',
    'htm',
    'aspx',
    'asp',
    'php',
    'cshtml',
    'vbhtml',
    'jsp',
    'jspx',
    'do',
    'ashx',
    'asmx',
    'svc',
    'axd',
  ])

  /** Recursos estáticos (por extensão) — tabela 1 do modal. */
  const STATIC_ASSET_EXTENSIONS = new Set([
    'js',
    'mjs',
    'cjs',
    'css',
    'scss',
    'less',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'svg',
    'webp',
    'ico',
    'bmp',
    'woff',
    'woff2',
    'ttf',
    'eot',
    'otf',
    'pdf',
    'map',
    'txt',
    'zip',
    'gz',
    'rar',
    '7z',
    'mp4',
    'webm',
    'mp3',
    'wav',
    'csv',
    'xls',
    'xlsx',
    'xlsm',
    'cur',
    'swf',
    'wasm',
  ])

  function getStemExtension(stem) {
    if (!stem || stem === '-') return ''
    const parts = stem.split('/').filter(Boolean)
    const last = parts[parts.length - 1] || ''
    const dot = last.lastIndexOf('.')
    if (dot <= 0 || dot === last.length - 1) return ''
    return last.slice(dot + 1).toLowerCase()
  }

  function isStaticAssetRow(stem, ext) {
    if (!ext) return false
    if (PAGE_EXTENSIONS.has(ext)) return false
    return STATIC_ASSET_EXTENSIONS.has(ext)
  }

  function appKeyFromStem(stem) {
    const s = stemApplication(stem)
    return s || APP_NONE
  }

  function relativeStem(stem, appSeg) {
    if (!stem || stem === '-') return stem || '-'
    const raw = stem.startsWith('/') ? stem : `/${stem}`
    const parts = raw.split('/').filter(Boolean)
    if (!parts.length) return '/'
    if (appSeg && parts[0] === appSeg) {
      const rest = parts.slice(1)
      return rest.length ? `/${rest.join('/')}` : '/'
    }
    return raw
  }

  createApp({
    setup() {
      const rows = shallowRef([])
      const loading = ref(false)
      const progress = ref(0)
      const loadingHint = ref('')
      const errorMsg = ref('')
      const meta = ref(null)

      const slowThresholdMs = ref(400)
      /** IP selecionado; vazio = todos */
      const ipFilter = ref('')
      /** Nome da aplicação (1º segmento) ou APP_NONE; vazio = todas */
      const applicationFilter = ref('')

      const applicationOptions = computed(() => {
        const list = rows.value
        if (!list.length) return []
        const map = new Map()
        for (const r of list) {
          const seg = stemApplication(r.stem)
          const key = seg || APP_NONE
          map.set(key, (map.get(key) || 0) + 1)
        }
        return [...map.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      })

      const clientIpOptions = computed(() => {
        const list = rows.value
        if (!list.length) return []
        const map = new Map()
        for (const r of list) {
          map.set(r.clientIp, (map.get(r.clientIp) || 0) + 1)
        }
        return [...map.entries()]
          .map(([ip, count]) => ({ ip, count }))
          .sort((a, b) => b.count - a.count || a.ip.localeCompare(b.ip))
      })

      const stemModalOpen = ref(false)
      /** Aplicação no modal: MODAL_APP_ALL = todas, ou nome de applicationOptions / APP_NONE */
      const modalEndpointApp = ref(MODAL_APP_ALL)
      const staticExtIncluded = reactive({})
      const endpointStemIncluded = reactive({})

      function clearStemFilters() {
        Object.keys(staticExtIncluded).forEach((k) => delete staticExtIncluded[k])
        Object.keys(endpointStemIncluded).forEach((k) => delete endpointStemIncluded[k])
      }

      function mergeStemFilterDefaults() {
        const staticSeen = new Set()
        const endpointSeen = new Set()
        for (const r of rows.value) {
          const stem = r.stem
          const ext = getStemExtension(stem)
          if (isStaticAssetRow(stem, ext)) {
            staticSeen.add(ext)
          } else {
            const appSeg = stemApplication(stem)
            const rel = relativeStem(stem, appSeg)
            endpointSeen.add(rel)
          }
        }
        for (const ext of staticSeen) {
          if (!(ext in staticExtIncluded)) staticExtIncluded[ext] = true
        }
        Object.keys(staticExtIncluded).forEach((ext) => {
          if (!staticSeen.has(ext)) delete staticExtIncluded[ext]
        })
        for (const k of endpointSeen) {
          if (!(k in endpointStemIncluded)) endpointStemIncluded[k] = true
        }
        Object.keys(endpointStemIncluded).forEach((k) => {
          if (!endpointSeen.has(k)) delete endpointStemIncluded[k]
        })
      }

      function rowPassesStemFilter(row) {
        const stem = row.stem
        const ext = getStemExtension(stem)
        if (isStaticAssetRow(stem, ext)) {
          return staticExtIncluded[ext] !== false
        }
        const appSeg = stemApplication(stem)
        const rel = relativeStem(stem, appSeg)
        return endpointStemIncluded[rel] !== false
      }

      const discoveredStaticExtensions = computed(() => {
        const map = new Map()
        for (const r of rows.value) {
          const ext = getStemExtension(r.stem)
          if (!isStaticAssetRow(r.stem, ext)) continue
          map.set(ext, (map.get(ext) || 0) + 1)
        }
        return [...map.entries()].map(([ext, count]) => ({ ext, count }))
      })

      const staticModalSort = ref({ key: 'count', dir: 'desc' })
      const endpointModalSort = ref({ key: 'count', dir: 'desc' })

      const sortedStaticModalRows = computed(() => {
        const list = discoveredStaticExtensions.value.map((r) => ({ ...r }))
        const { key, dir } = staticModalSort.value
        const m = dir === 'asc' ? 1 : -1
        list.sort((a, b) => {
          if (key === 'ext') return m * a.ext.localeCompare(b.ext, 'pt-BR', { sensitivity: 'base' })
          return m * (a.count - b.count)
        })
        return list
      })

      const modalEndpointList = computed(() => {
        const app = modalEndpointApp.value
        const map = new Map()
        for (const r of rows.value) {
          const stem = r.stem
          const ext = getStemExtension(stem)
          if (isStaticAssetRow(stem, ext)) continue
          const appSeg = stemApplication(stem)
          const ak = appKeyFromStem(stem)
          const rel = relativeStem(stem, appSeg)
          if (app !== MODAL_APP_ALL && ak !== app) continue
          map.set(rel, (map.get(rel) || 0) + 1)
        }
        return [...map.entries()].map(([relStem, count]) => ({
          relStem,
          count,
          /** Chave global do filtro: mesmo caminho sem app vale para todas as aplicações */
          stateKey: relStem,
        }))
      })

      const sortedEndpointModalRows = computed(() => {
        const list = modalEndpointList.value.map((r) => ({ ...r }))
        const { key, dir } = endpointModalSort.value
        const m = dir === 'asc' ? 1 : -1
        list.sort((a, b) => {
          if (key === 'relStem') return m * a.relStem.localeCompare(b.relStem, 'pt-BR', { sensitivity: 'base' })
          return m * (a.count - b.count)
        })
        return list
      })

      function faSortClass(sortRef, columnKey) {
        const cur = unref(sortRef)
        if (!cur || cur.key !== columnKey) return 'fas fa-sort text-secondary opacity-50'
        return cur.dir === 'asc' ? 'fas fa-sort-up' : 'fas fa-sort-down'
      }

      function sortStaticModalColumn(columnKey) {
        const cur = staticModalSort.value
        if (cur.key !== columnKey) staticModalSort.value = { key: columnKey, dir: 'asc' }
        else staticModalSort.value = { key: columnKey, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
      }

      function sortEndpointModalColumn(columnKey) {
        const cur = endpointModalSort.value
        if (cur.key !== columnKey) endpointModalSort.value = { key: columnKey, dir: 'asc' }
        else endpointModalSort.value = { key: columnKey, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
      }

      const stemFilterExcludedCount = computed(() => {
        let n = 0
        for (const ext of Object.keys(staticExtIncluded)) {
          if (staticExtIncluded[ext] === false) n++
        }
        for (const k of Object.keys(endpointStemIncluded)) {
          if (endpointStemIncluded[k] === false) n++
        }
        return n
      })

      const fileInputRef = ref(null)
      const dragOver = ref(false)

      const layoutItems = ref([])
      const dashboardDropHover = ref(null)
      const colSpanOptions = [3, 4, 6, 8, 9, 12]

      const paletteWidgetDefs = [
        { type: WIDGET_TYPES.STAT_COUNT, shortLabel: 'Requisições' },
        { type: WIDGET_TYPES.STAT_AVG, shortLabel: 'Tempo médio' },
        { type: WIDGET_TYPES.STAT_MAX, shortLabel: 'Pico (max)' },
        { type: WIDGET_TYPES.STAT_RANGE, shortLabel: 'Intervalo' },
        { type: WIDGET_TYPES.CHART_TIMELINE, shortLabel: 'Linha do tempo' },
        { type: WIDGET_TYPES.CHART_STATUS, shortLabel: 'HTTP status' },
        { type: WIDGET_TYPES.CHART_ENDPOINTS, shortLabel: 'Endpoints' },
        { type: WIDGET_TYPES.CHART_IPS, shortLabel: 'IPs lentos' },
        { type: WIDGET_TYPES.TABLE_SLOW, shortLabel: 'Req. lentas' },
      ]

      const dashboardWidgetTitles = {
        [WIDGET_TYPES.STAT_COUNT]: 'Requisições (filtro atual)',
        [WIDGET_TYPES.STAT_AVG]: 'Tempo médio',
        [WIDGET_TYPES.STAT_MAX]: 'Pico (max)',
        [WIDGET_TYPES.STAT_RANGE]: 'Intervalo',
        [WIDGET_TYPES.CHART_TIMELINE]: 'Linha do tempo — média e pico de time-taken',
        [WIDGET_TYPES.CHART_STATUS]: 'HTTP status',
        [WIDGET_TYPES.CHART_ENDPOINTS]: 'Endpoints com maior tempo médio (cs-uri-stem)',
        [WIDGET_TYPES.CHART_IPS]: 'IPs com mais requisições lentas (limiar ms)',
        [WIDGET_TYPES.TABLE_SLOW]: 'Requisições mais lentas — tabela',
      }

      const chartCanvasEls = { timeline: null, endpoint: null, slowIp: null }

      function bindChartCanvas(kind, el) {
        const prev = chartCanvasEls[kind]
        chartCanvasEls[kind] = el || null
        if (prev !== chartCanvasEls[kind]) nextTick(() => updateCharts())
      }

      function parseDragPayload(ev) {
        try {
          return JSON.parse(ev.dataTransfer.getData('text/plain') || '{}')
        } catch {
          return {}
        }
      }

      function onDashboardPaletteDragStart(ev, type) {
        ev.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'palette', type }))
        ev.dataTransfer.effectAllowed = 'copy'
      }

      function onDashboardWidgetDragStart(ev, uid) {
        ev.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'widget', uid }))
        ev.dataTransfer.effectAllowed = 'move'
      }

      function onDashboardSlotDragEnd() {
        dashboardDropHover.value = null
      }

      function onDashboardSlotDrop(ev, slotIndex) {
        ev.preventDefault()
        dashboardDropHover.value = null
        const data = parseDragPayload(ev)
        const idx = clampDim(slotIndex, 0, layoutItems.value.length)
        if (data.kind === 'palette' && ALLOWED_WIDGET_TYPES.has(data.type)) {
          if (layoutItems.value.some((i) => i.type === data.type)) return
          layoutItems.value.splice(idx, 0, {
            uid: genDashboardUid(),
            type: data.type,
            colSpan: String(data.type).startsWith('stat-') ? 3 : 6,
            heightPx: defaultWidgetHeight(data.type),
          })
          return
        }
        if (data.kind === 'widget' && data.uid) {
          const cur = layoutItems.value.findIndex((i) => i.uid === data.uid)
          if (cur === -1) return
          const [item] = layoutItems.value.splice(cur, 1)
          let insertAt = idx
          if (cur < idx) insertAt -= 1
          insertAt = clampDim(insertAt, 0, layoutItems.value.length)
          layoutItems.value.splice(insertAt, 0, item)
        }
      }

      function removeDashboardWidget(uid) {
        const i = layoutItems.value.findIndex((x) => x.uid === uid)
        if (i !== -1) layoutItems.value.splice(i, 1)
      }

      function setWidgetColSpan(uid, span) {
        const it = layoutItems.value.find((x) => x.uid === uid)
        if (it) it.colSpan = clampDim(span, 3, 12)
      }

      function resetDashboardLayout() {
        layoutItems.value = createDefaultDashboardLayout()
      }

      function isWidgetOnDashboard(type) {
        return layoutItems.value.some((i) => i.type === type)
      }

      function initDashboardLayout() {
        try {
          const raw = localStorage.getItem(DASHBOARD_STORAGE_KEY)
          if (raw) {
            const norm = normalizeDashboardLayout(JSON.parse(raw))
            if (norm.length) {
              layoutItems.value = norm
              return
            }
          }
        } catch (_) {}
        layoutItems.value = createDefaultDashboardLayout()
      }

      function persistDashboardLayout() {
        try {
          localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(layoutItems.value))
        } catch (_) {}
      }

      function startWidgetResize(ev, uid) {
        const item = layoutItems.value.find((i) => i.uid === uid)
        if (!item) return
        const startY = ev.clientY
        const base = item.heightPx ?? defaultWidgetHeight(item.type)
        function onMove(e) {
          item.heightPx = clampDim(base + (e.clientY - startY), 160, 1200)
        }
        function onUp() {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }

      let chartTimeline = null
      let chartEndpoint = null
      let chartSlowIp = null

      function fmtBucket(ts) {
        return new Date(ts).toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      }

      function destroyCharts() {
        if (chartTimeline) {
          chartTimeline.destroy()
          chartTimeline = null
        }
        if (chartEndpoint) {
          chartEndpoint.destroy()
          chartEndpoint = null
        }
        if (chartSlowIp) {
          chartSlowIp.destroy()
          chartSlowIp = null
        }
      }

      const baseRows = computed(() => {
        let list = rows.value
        const ip = ipFilter.value.trim()
        if (ip) list = list.filter((r) => r.clientIp === ip)
        const app = applicationFilter.value
        if (app) {
          list = list.filter((r) => {
            const seg = stemApplication(r.stem)
            const key = seg || APP_NONE
            return key === app
          })
        }
        return list.filter(rowPassesStemFilter)
      })

      const stats = computed(() => {
        const list = baseRows.value
        if (!list.length) return null
        let sum = 0
        let max = 0
        let minTs = list[0].timestamp
        let maxTs = list[0].timestamp
        for (const r of list) {
          sum += r.timeTaken
          max = Math.max(max, r.timeTaken)
          minTs = Math.min(minTs, r.timestamp)
          maxTs = Math.max(maxTs, r.timestamp)
        }
        return {
          count: list.length,
          avgMs: Math.round(sum / list.length),
          maxMs: max,
          minTs,
          maxTs,
        }
      })

      const bucketMs = computed(() => {
        const s = stats.value
        if (!s) return 60_000
        return suggestBucketMs(s.minTs, s.maxTs, 100)
      })

      const timelineSeries = computed(() => {
        const list = baseRows.value
        if (!list.length) return null
        const b = timelineBuckets(list, bucketMs.value)
        return {
          labels: b.map((x) => fmtBucket(x.t)),
          avgMs: b.map((x) => x.avg),
          maxMs: b.map((x) => x.max),
          counts: b.map((x) => x.count),
        }
      })

      const endpointChart = computed(() => {
        const list = baseRows.value
        if (!list.length) return null
        const top = topEndpoints(list, 14)
        return {
          labels: top.map((e) => (e.stem.length > 56 ? `${e.stem.slice(0, 54)}…` : e.stem)),
          values: top.map((e) => e.avg),
          detail: top,
        }
      })

      const slowIpChart = computed(() => {
        const list = baseRows.value
        if (!list.length) return null
        const ips = topClientIps(list, 8)
        const raw = ipSlowTimeline(list, bucketMs.value, ips, slowThresholdMs.value)
        if (!raw.labels.length) return null
        return {
          labels: raw.labels.map(fmtBucket),
          datasets: raw.datasets,
        }
      })

      const statusBreakdown = computed(() => {
        const list = baseRows.value
        if (!list.length) return []
        return statusMix(list).slice(0, 8)
      })

      const slowTable = computed(() => {
        const list = baseRows.value
        const th = slowThresholdMs.value
        return [...list]
          .filter((r) => r.timeTaken >= th)
          .sort((a, b) => b.timeTaken - a.timeTaken)
          .slice(0, 200)
      })

      async function updateCharts() {
        await nextTick()
        const textColor = '#dee2e6'
        const grid = 'rgba(255,255,255,0.06)'

        if (!stats.value || typeof Chart === 'undefined') {
          destroyCharts()
          return
        }

        const s = timelineSeries.value
        const c1 = chartCanvasEls.timeline
        if (chartTimeline) {
          chartTimeline.destroy()
          chartTimeline = null
        }
        if (c1 && s) {
          chartTimeline = new Chart(c1, {
            type: 'line',
            data: {
              labels: s.labels,
              datasets: [
                {
                  label: 'Média (ms)',
                  data: s.avgMs,
                  borderColor: 'rgb(54, 162, 235)',
                  backgroundColor: 'rgba(54, 162, 235, 0.15)',
                  fill: true,
                  tension: 0.2,
                  pointRadius: 0,
                },
                {
                  label: 'Máximo (ms)',
                  data: s.maxMs,
                  borderColor: 'rgb(255, 159, 64)',
                  backgroundColor: 'transparent',
                  tension: 0.2,
                  pointRadius: 0,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              interaction: { mode: 'index', intersect: false },
              plugins: {
                legend: { labels: { color: textColor } },
              },
              scales: {
                x: {
                  ticks: { color: textColor, maxRotation: 45, autoSkip: true, maxTicksLimit: 14 },
                  grid: { color: grid },
                },
                y: {
                  title: { display: true, text: 'time-taken (ms)', color: textColor },
                  ticks: { color: textColor },
                  grid: { color: grid },
                },
              },
            },
          })
        }

        const ec = endpointChart.value
        const c2 = chartCanvasEls.endpoint
        if (chartEndpoint) {
          chartEndpoint.destroy()
          chartEndpoint = null
        }
        if (c2 && ec) {
          chartEndpoint = new Chart(c2, {
            type: 'bar',
            data: {
              labels: ec.labels,
              datasets: [
                {
                  label: 'Média ms',
                  data: ec.values,
                  backgroundColor: 'rgba(153, 102, 255, 0.55)',
                  borderColor: 'rgb(153, 102, 255)',
                  borderWidth: 1,
                },
              ],
            },
            options: {
              indexAxis: 'y',
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: {
                  title: { display: true, text: 'Média time-taken (ms)', color: textColor },
                  ticks: { color: textColor },
                  grid: { color: grid },
                },
                y: {
                  ticks: { color: textColor, font: { size: 10 } },
                  grid: { display: false },
                },
              },
            },
          })
        }

        const sic = slowIpChart.value
        const c3 = chartCanvasEls.slowIp
        if (chartSlowIp) {
          chartSlowIp.destroy()
          chartSlowIp = null
        }
        if (c3 && sic) {
          chartSlowIp = new Chart(c3, {
            type: 'line',
            data: {
              labels: sic.labels,
              datasets: sic.datasets.map((d, i) => ({
                label: d.ip,
                data: d.data,
                borderColor: PALETTE[i % PALETTE.length],
                backgroundColor: 'transparent',
                tension: 0.25,
                pointRadius: 0,
              })),
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              interaction: { mode: 'index', intersect: false },
              plugins: {
                legend: { labels: { color: textColor, boxWidth: 12 } },
              },
              scales: {
                x: {
                  ticks: { color: textColor, maxRotation: 45, autoSkip: true, maxTicksLimit: 14 },
                  grid: { color: grid },
                },
                y: {
                  title: { display: true, text: 'Requisições lentas (contagem)', color: textColor },
                  ticks: { color: textColor, precision: 0 },
                  grid: { color: grid },
                },
              },
            },
          })
        }
      }

      watch(
        [stats, timelineSeries, endpointChart, slowIpChart, slowThresholdMs, ipFilter, applicationFilter],
        () => {
          updateCharts()
        },
        { flush: 'post' },
      )

      watch(
        layoutItems,
        () => {
          persistDashboardLayout()
          nextTick(() => updateCharts())
        },
        { deep: true, flush: 'post' },
      )

      async function loadFromText(text, filename) {
        errorMsg.value = ''
        loading.value = true
        progress.value = 0
        loadingHint.value =
          'Analisando linhas do log. Em arquivos grandes isso pode levar vários minutos — a página não travou.'
        rows.value = []
        meta.value = null
        ipFilter.value = ''
        applicationFilter.value = ''
        clearStemFilters()
        stemModalOpen.value = false
        modalEndpointApp.value = MODAL_APP_ALL
        destroyCharts()

        try {
          const totalLines = estimateLineCount(text)
          const targetRows = 320_000
          const sampleEvery = totalLines > targetRows ? Math.ceil(totalLines / targetRows) : 1

          const result = await parseIisLogText(text, {
            sampleEvery,
            onProgress(p) {
              progress.value = Math.min(99, Math.round((100 * p.lineIndex) / p.totalLines))
            },
          })

          rows.value = result.rows
          mergeStemFilterDefaults()
          if (!layoutItems.value.length) initDashboardLayout()
          meta.value = {
            filename,
            totalLines,
            parsed: result.rows.length,
            sampleEvery: result.sampleEvery,
            truncated: result.truncated,
            missingFields: result.missingFields,
          }
        } catch (e) {
          errorMsg.value = e?.message || String(e)
        } finally {
          loading.value = false
          progress.value = 100
          loadingHint.value = ''
        }
      }

      async function consumeFile(file) {
        if (!file) return
        errorMsg.value = ''
        const name = file.name || 'arquivo'

        try {
          if (name.toLowerCase().endsWith('.zip')) {
            loading.value = true
            progress.value = 0
            loadingHint.value = 'Lendo o ZIP e extraindo os arquivos .log…'
            const zip = await JSZip.loadAsync(file)
            const chunks = []
            const paths = Object.keys(zip.files).sort()
            for (const path of paths) {
              const entry = zip.files[path]
              if (entry.dir) continue
              if (!/\.log$/i.test(path)) continue
              chunks.push(await entry.async('string'))
            }
            if (!chunks.length) {
              errorMsg.value = 'Nenhum arquivo .log encontrado dentro do ZIP.'
              loading.value = false
              loadingHint.value = ''
              return
            }
            await loadFromText(chunks.join('\n'), name)
            return
          }

          if (name.toLowerCase().endsWith('.log')) {
            loading.value = true
            progress.value = 0
            loadingHint.value = 'Lendo o arquivo de log…'
            const text = await file.text()
            await loadFromText(text, name)
            return
          }

          errorMsg.value = 'Envie um arquivo .zip (com logs .log) ou um .log único.'
        } catch (e) {
          errorMsg.value = e?.message || String(e)
          loading.value = false
          loadingHint.value = ''
        }
      }

      function onPickClick() {
        fileInputRef.value?.click()
      }

      function onFileInput(e) {
        const f = e.target.files?.[0]
        consumeFile(f)
        e.target.value = ''
      }

      function onDrop(e) {
        dragOver.value = false
        const f = e.dataTransfer?.files?.[0]
        consumeFile(f)
      }

      function clearData() {
        rows.value = []
        meta.value = null
        errorMsg.value = ''
        ipFilter.value = ''
        applicationFilter.value = ''
        clearStemFilters()
        stemModalOpen.value = false
        modalEndpointApp.value = MODAL_APP_ALL
        layoutItems.value = []
        try {
          localStorage.removeItem(DASHBOARD_STORAGE_KEY)
        } catch (_) {}
        destroyCharts()
      }

      function openStemModal() {
        stemModalOpen.value = true
      }

      function closeStemModal() {
        stemModalOpen.value = false
      }

      function toggleAllStaticExts(on) {
        for (const row of sortedStaticModalRows.value) {
          staticExtIncluded[row.ext] = on
        }
      }

      function toggleAllModalEndpoints(on) {
        for (const row of sortedEndpointModalRows.value) {
          endpointStemIncluded[row.stateKey] = on
        }
      }

      function resetStemFiltersToDefault() {
        mergeStemFilterDefaults()
        for (const row of discoveredStaticExtensions.value) {
          staticExtIncluded[row.ext] = true
        }
        Object.keys(endpointStemIncluded).forEach((k) => {
          endpointStemIncluded[k] = true
        })
      }

      return {
        rows,
        loading,
        loadingHint,
        progress,
        errorMsg,
        meta,
        slowThresholdMs,
        ipFilter,
        applicationFilter,
        applicationOptions,
        clientIpOptions,
        stemModalOpen,
        modalEndpointApp,
        modalAppAll: MODAL_APP_ALL,
        staticExtIncluded,
        endpointStemIncluded,
        discoveredStaticExtensions,
        modalEndpointList,
        sortedStaticModalRows,
        sortedEndpointModalRows,
        staticModalSort,
        endpointModalSort,
        stemFilterExcludedCount,
        faSortClass,
        sortStaticModalColumn,
        sortEndpointModalColumn,
        openStemModal,
        closeStemModal,
        toggleAllStaticExts,
        toggleAllModalEndpoints,
        resetStemFiltersToDefault,
        layoutItems,
        paletteWidgetDefs,
        dashboardWidgetTitles,
        dashboardDropHover,
        colSpanOptions,
        bindChartCanvas,
        onDashboardPaletteDragStart,
        onDashboardWidgetDragStart,
        onDashboardSlotDrop,
        onDashboardSlotDragEnd,
        removeDashboardWidget,
        setWidgetColSpan,
        resetDashboardLayout,
        isWidgetOnDashboard,
        startWidgetResize,
        fileInputRef,
        dragOver,
        stats,
        bucketMs,
        timelineSeries,
        endpointChart,
        slowIpChart,
        statusBreakdown,
        slowTable,
        fmtBucket,
        loadFromText,
        consumeFile,
        onPickClick,
        onFileInput,
        onDrop,
        clearData,
      }
    },
  }).mount('#app')
})()
