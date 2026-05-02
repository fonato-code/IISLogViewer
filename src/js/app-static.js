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

  const { createApp, ref, shallowRef, computed, watch, nextTick, reactive, unref, onUnmounted } =
    Vue

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

  function equalizeRowCells(row) {
    const n = row.length
    if (!n) return
    const base = Math.floor(12 / n)
    let rem = 12 % n
    for (let i = 0; i < n; i++) {
      row[i].colSpan = base + (i < rem ? 1 : 0)
    }
  }

  function createDefaultDashboardLayout() {
    return [
      [
        { uid: genDashboardUid(), type: WIDGET_TYPES.STAT_COUNT, colSpan: 3 },
        { uid: genDashboardUid(), type: WIDGET_TYPES.STAT_AVG, colSpan: 3 },
        { uid: genDashboardUid(), type: WIDGET_TYPES.STAT_MAX, colSpan: 3 },
        { uid: genDashboardUid(), type: WIDGET_TYPES.STAT_RANGE, colSpan: 3 },
      ],
      [
        { uid: genDashboardUid(), type: WIDGET_TYPES.CHART_TIMELINE, colSpan: 8, heightPx: 340 },
        { uid: genDashboardUid(), type: WIDGET_TYPES.CHART_STATUS, colSpan: 4, heightPx: 340 },
      ],
      [
        { uid: genDashboardUid(), type: WIDGET_TYPES.CHART_ENDPOINTS, colSpan: 6, heightPx: 380 },
        { uid: genDashboardUid(), type: WIDGET_TYPES.CHART_IPS, colSpan: 6, heightPx: 380 },
      ],
      [{ uid: genDashboardUid(), type: WIDGET_TYPES.TABLE_SLOW, colSpan: 12, heightPx: 420 }],
    ]
  }

  /** Lista plana legada (uma entrada por tipo). */
  function normalizeFlatWidgets(arr) {
    if (!Array.isArray(arr)) return []
    const seen = new Set()
    const out = []
    for (const x of arr) {
      if (!x || !ALLOWED_WIDGET_TYPES.has(x.type)) continue
      if (seen.has(x.type)) continue
      seen.add(x.type)
      const colSpan = clampDim(parseInt(x.colSpan, 10) || 6, 1, 12)
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

  function migrateFlatToRows(flat) {
    const rows = []
    let cur = []
    let sum = 0
    for (const w of flat) {
      const span = clampDim(w.colSpan, 1, 12)
      if (sum + span > 12 && cur.length) {
        rows.push(cur)
        cur = []
        sum = 0
      }
      cur.push({ ...w, colSpan: span })
      sum += span
    }
    if (cur.length) rows.push(cur)
    for (const r of rows) {
      const s = r.reduce((a, b) => a + b.colSpan, 0)
      if (s !== 12) equalizeRowCells(r)
    }
    return rows
  }

  /** Aceita `{ rows }`, lista plana legada ou JSON antigo com array plano. */
  function normalizeStoredLayout(parsed) {
    if (!parsed) return null
    let candidateRows = null
    if (parsed.rows && Array.isArray(parsed.rows)) {
      candidateRows = parsed.rows
    } else if (Array.isArray(parsed)) {
      const flat = normalizeFlatWidgets(parsed)
      if (flat.length) candidateRows = migrateFlatToRows(flat)
    }
    if (!candidateRows || !candidateRows.length) return null

    const seen = new Set()
    const out = []
    for (const row of candidateRows) {
      if (!Array.isArray(row)) continue
      const nr = []
      for (const x of row) {
        if (!x || !ALLOWED_WIDGET_TYPES.has(x.type)) continue
        if (seen.has(x.type)) continue
        seen.add(x.type)
        const colSpan = clampDim(parseInt(x.colSpan, 10) || 1, 1, 12)
        let heightPx
        if (x.heightPx != null && Number.isFinite(Number(x.heightPx))) {
          heightPx = clampDim(Number(x.heightPx), 120, 1600)
        }
        nr.push({
          uid: typeof x.uid === 'string' ? x.uid : genDashboardUid(),
          type: x.type,
          colSpan,
          heightPx,
        })
      }
      if (!nr.length) continue
      const sum = nr.reduce((s, w) => s + w.colSpan, 0)
      if (sum !== 12) equalizeRowCells(nr)
      out.push(nr)
    }
    return out.length ? out : null
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

      const layoutRows = ref([])
      /** Só com isto ativo: arrastar cartões, faixas de inserção, resize horizontal e painel de ajuda. */
      const layoutEditMode = ref(false)
      /** Durante drag do cabeçalho de um widget: `{ uid }`. */
      const layoutDragState = ref(null)
      /** Preview da zona sob o cursor: inserir na linha ou trocar no cartão. */
      const layoutDropHint = ref(null)

      const addWidgetLabels = {
        [WIDGET_TYPES.STAT_COUNT]: 'Requisições',
        [WIDGET_TYPES.STAT_AVG]: 'Tempo médio',
        [WIDGET_TYPES.STAT_MAX]: 'Pico (max)',
        [WIDGET_TYPES.STAT_RANGE]: 'Intervalo',
        [WIDGET_TYPES.CHART_TIMELINE]: 'Linha do tempo',
        [WIDGET_TYPES.CHART_STATUS]: 'HTTP status',
        [WIDGET_TYPES.CHART_ENDPOINTS]: 'Endpoints',
        [WIDGET_TYPES.CHART_IPS]: 'IPs lentos',
        [WIDGET_TYPES.TABLE_SLOW]: 'Req. lentas',
      }

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

      function dashboardWidgetCount() {
        return layoutRows.value.reduce((n, r) => n + r.length, 0)
      }

      function findWidgetPos(uid) {
        for (let ri = 0; ri < layoutRows.value.length; ri++) {
          const ci = layoutRows.value[ri].findIndex((w) => w.uid === uid)
          if (ci !== -1) return { ri, ci }
        }
        return null
      }

      function typeOnDashboard(type) {
        for (const row of layoutRows.value) {
          if (row.some((w) => w.type === type)) return true
        }
        return false
      }

      const missingWidgetTypes = computed(() =>
        Object.values(WIDGET_TYPES).filter((t) => !typeOnDashboard(t)),
      )

      function cloneRows() {
        return layoutRows.value.map((r) => r.map((w) => ({ ...w })))
      }

      function commitRows(rows) {
        layoutRows.value = rows
      }

      function onDashboardWidgetDragStart(ev, uid) {
        if (!layoutEditMode.value) {
          ev.preventDefault()
          return
        }
        layoutDragState.value = { uid }
        layoutDropHint.value = null
        ev.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'widget', uid }))
        ev.dataTransfer.effectAllowed = 'move'
      }

      function onDashboardWidgetDragEnd() {
        layoutDragState.value = null
        layoutDropHint.value = null
      }

      function insertDropWouldNoop(uid, targetRi, insertIdx) {
        const src = findWidgetPos(uid)
        if (!src) return false
        return src.ri === targetRi && (insertIdx === src.ci || insertIdx === src.ci + 1)
      }

      function dropHintInsert(ri, insertIdx) {
        const h = layoutDropHint.value
        return !!(h && h.mode === 'insert' && h.ri === ri && h.insertIdx === insertIdx)
      }

      function dropHintSwap(ri, ci) {
        const h = layoutDropHint.value
        return !!(h && h.mode === 'swap' && h.ri === ri && h.ci === ci)
      }

      /** Faixa lateral: inserir na linha (redistribui colunas). */
      function onInsertStripDragOver(ev, ri, insertIdx) {
        if (!layoutEditMode.value || !layoutDragState.value) return
        const uid = layoutDragState.value.uid
        if (insertDropWouldNoop(uid, ri, insertIdx)) {
          ev.preventDefault()
          ev.stopPropagation()
          ev.dataTransfer.dropEffect = 'none'
          layoutDropHint.value = null
          return
        }
        ev.preventDefault()
        ev.stopPropagation()
        ev.dataTransfer.dropEffect = 'move'
        layoutDropHint.value = { mode: 'insert', ri, insertIdx }
      }

      /** Centro do cartão: trocar lugar com o bloco alvo. */
      function onSwapZoneDragOver(ev, ri, ci) {
        if (!layoutEditMode.value || !layoutDragState.value) return
        const uid = layoutDragState.value.uid
        const src = findWidgetPos(uid)
        if (src && src.ri === ri && src.ci === ci) {
          ev.preventDefault()
          ev.dataTransfer.dropEffect = 'none'
          layoutDropHint.value = null
          return
        }
        ev.preventDefault()
        ev.stopPropagation()
        ev.dataTransfer.dropEffect = 'move'
        layoutDropHint.value = { mode: 'swap', ri, ci }
      }

      /** Áreas estreitas nas laterais: inserir na linha e redistribuir larguras. */
      function onInsertDrop(ev, targetRi, insertIdx) {
        if (!layoutEditMode.value) return
        ev.preventDefault()
        ev.stopPropagation()
        layoutDropHint.value = null
        const data = parseDragPayload(ev)
        if (data.kind !== 'widget' || !data.uid) return

        const uid = data.uid
        const src = findWidgetPos(uid)
        if (!src) return

        let rows = cloneRows()
        const moving = rows[src.ri][src.ci]

        const sameCell = src.ri === targetRi && (insertIdx === src.ci || insertIdx === src.ci + 1)
        if (sameCell) return

        rows[src.ri].splice(src.ci, 1)
        const emptied = rows[src.ri].length === 0
        if (emptied) {
          rows.splice(src.ri, 1)
        } else {
          equalizeRowCells(rows[src.ri])
        }

        let tr = targetRi
        if (emptied && src.ri < tr) tr -= 1

        let ti = insertIdx
        if (!emptied && src.ri === targetRi && src.ci < insertIdx) ti -= 1

        if (tr < 0) tr = 0
        if (tr >= rows.length) {
          rows.push([moving])
          equalizeRowCells(rows[rows.length - 1])
          commitRows(rows)
          return
        }

        ti = clampDim(ti, 0, rows[tr].length)
        rows[tr].splice(ti, 0, moving)
        equalizeRowCells(rows[tr])
        commitRows(rows)
      }

      /** Centro do cartão: troca de lugar (inclui largura / posição). */
      function onSwapDrop(ev, targetRi, targetCi) {
        if (!layoutEditMode.value) return
        ev.preventDefault()
        ev.stopPropagation()
        layoutDropHint.value = null
        const data = parseDragPayload(ev)
        if (data.kind !== 'widget' || !data.uid) return
        const src = findWidgetPos(data.uid)
        if (!src) return
        if (src.ri === targetRi && src.ci === targetCi) return

        const rows = cloneRows()
        const a = rows[src.ri][src.ci]
        const b = rows[targetRi][targetCi]
        rows[src.ri][src.ci] = b
        rows[targetRi][targetCi] = a
        commitRows(rows)
      }

      function removeDashboardWidget(uid) {
        const pos = findWidgetPos(uid)
        if (!pos) return
        const rows = cloneRows()
        rows[pos.ri].splice(pos.ci, 1)
        if (rows[pos.ri].length === 0) rows.splice(pos.ri, 1)
        else equalizeRowCells(rows[pos.ri])
        commitRows(rows)
      }

      function addDashboardWidget(type) {
        if (!ALLOWED_WIDGET_TYPES.has(type) || typeOnDashboard(type)) return
        const rows = cloneRows()
        rows.push([
          {
            uid: genDashboardUid(),
            type,
            colSpan: 12,
            heightPx: defaultWidgetHeight(type),
          },
        ])
        commitRows(rows)
      }

      function onAddWidgetChange(ev) {
        const t = ev.target.value
        if (t) addDashboardWidget(t)
        ev.target.value = ''
      }

      function resetDashboardLayout() {
        layoutRows.value = createDefaultDashboardLayout()
      }

      function initDashboardLayout() {
        try {
          const raw = localStorage.getItem(DASHBOARD_STORAGE_KEY)
          if (raw) {
            const norm = normalizeStoredLayout(JSON.parse(raw))
            if (norm && norm.length) {
              layoutRows.value = norm
              return
            }
          }
        } catch (_) {}
        layoutRows.value = createDefaultDashboardLayout()
      }

      function persistDashboardLayout() {
        try {
          localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify({ rows: layoutRows.value }))
        } catch (_) {}
      }

      /** Borda direita do widget ci: ajusta limite na grade de 12 colunas (par com vizinho). */
      function startColResize(ev, ri, ci) {
        if (!layoutEditMode.value) return
        ev.preventDefault()
        ev.stopPropagation()
        const rowEl = ev.target.closest('[data-dashboard-row]')
        if (!rowEl) return

        const row = layoutRows.value[ri]
        if (!row || row.length < 2) return

        let leftIdx
        let rightIdx
        if (ci < row.length - 1) {
          leftIdx = ci
          rightIdx = ci + 1
        } else {
          leftIdx = ci - 1
          rightIdx = ci
        }

        const left = row[leftIdx]
        const right = row[rightIdx]
        const total = left.colSpan + right.colSpan
        const minL = 1
        const maxL = total - 1

        function prefixCols(idx) {
          let s = 0
          for (let i = 0; i < idx; i++) s += row[i].colSpan
          return s
        }

        const rowRect = rowEl.getBoundingClientRect()
        const grid = rowRect.width / 12

        function onMove(e) {
          const rel = e.clientX - rowRect.left
          let snapped = Math.round(rel / grid)
          const pref = prefixCols(leftIdx)
          snapped = clampDim(snapped, pref + minL, pref + maxL)
          const newL = snapped - pref
          const newR = total - newL
          left.colSpan = newL
          right.colSpan = newR
        }

        function onUp() {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          persistDashboardLayout()
          nextTick(() => updateCharts())
        }

        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }

      function startWidgetResize(ev, uid) {
        if (!layoutEditMode.value) return
        const item = layoutRows.value.flat().find((i) => i.uid === uid)
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
        layoutEditMode,
        (on) => {
          document.body.classList.toggle('iis-layout-arranging', !!on)
        },
        { immediate: true },
      )

      onUnmounted(() => {
        document.body.classList.remove('iis-layout-arranging')
      })

      watch(
        [stats, timelineSeries, endpointChart, slowIpChart, slowThresholdMs, ipFilter, applicationFilter],
        () => {
          updateCharts()
        },
        { flush: 'post' },
      )

      watch(
        layoutRows,
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
          if (!dashboardWidgetCount()) initDashboardLayout()
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
        layoutRows.value = []
        layoutEditMode.value = false
        layoutDragState.value = null
        layoutDropHint.value = null
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
        layoutRows,
        layoutEditMode,
        layoutDragState,
        dropHintInsert,
        dropHintSwap,
        addWidgetLabels,
        missingWidgetTypes,
        dashboardWidgetTitles,
        bindChartCanvas,
        onDashboardWidgetDragStart,
        onDashboardWidgetDragEnd,
        onInsertStripDragOver,
        onSwapZoneDragOver,
        onInsertDrop,
        onSwapDrop,
        removeDashboardWidget,
        addDashboardWidget,
        onAddWidgetChange,
        resetDashboardLayout,
        startColResize,
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
