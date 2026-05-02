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

  const {
    createApp,
    ref,
    shallowRef,
    computed,
    watch,
    nextTick,
    reactive,
    unref,
    onUnmounted,
  } = Vue

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

  /** Fatias no gráfico de pizza por IP; o restante vira “Outros”. */
  const PIE_IP_MAX_SLICES = 22
  const PIE_APP_MIN_REQUESTS = 100
  const USER_AGENT_TABLE_MAX_ROWS = 400
  /** Margem antes/depois do bucket clicado no detalhamento temporal (ms). */
  const REQUEST_DETAIL_MARGIN_MS = 5 * 60 * 1000

  /**
   * @param {number} current 1-based
   * @param {number} totalPages
   * @returns {Array<number | 'ellipsis'>}
   */
  function pagerWindow(current, totalPages) {
    const tp = Math.max(1, totalPages | 0)
    const c = Math.min(Math.max(1, current | 0), tp)
    if (tp <= 9) return Array.from({ length: tp }, (_, i) => i + 1)
    const set = new Set([1, tp, c - 1, c, c + 1])
    for (const p of [...set]) {
      if (p < 1 || p > tp) set.delete(p)
    }
    const sorted = [...set].sort((a, b) => a - b)
    /** @type {Array<number | 'ellipsis'>} */
    const out = []
    let prev = 0
    for (const p of sorted) {
      if (prev && p - prev > 1) out.push('ellipsis')
      out.push(p)
      prev = p
    }
    return out
  }

  function pieSliceColors(count) {
    const out = []
    for (let i = 0; i < count; i++) out.push(PALETTE[i % PALETTE.length])
    return out
  }

  /** Motor comum aos browsers Chromium (Chrome, Edge, Opera, etc.). */
  const UA_BASE_CHROMIUM = 'Chromium'

  /**
   * Deriva colunas a partir de cs(User-Agent) (heurística; UAs truncados no log podem perder o SO explícito).
   */
  function parseUserAgentDetails(raw) {
    const ua = raw == null ? '' : String(raw).trim()
    const dash = { browser: '—', version: '—', base: '—', os: '—', type: '—' }
    if (!ua || ua === '(vazio)') return dash

    let browser = 'Outro / desconhecido'
    let version = '—'
    let base = '—'
    let os = '—'
    let type = 'Desktop'
    let m

    if (/iPad\b/i.test(ua) && !/Mobile/i.test(ua)) type = 'Tablet'
    else if (/iPad|Tablet/i.test(ua)) type = 'Tablet'
    else if (/Mobile|iPhone|iPod|Android.*Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) type = 'Mobile'

    const win64 = /Win64|WOW64|x64|amd64/i.test(ua)
    if (/Windows NT 10\.0/i.test(ua)) os = win64 ? 'Windows 10/11 (64-bit)' : 'Windows 10/11'
    else if (/Windows NT 6\.3/i.test(ua)) os = win64 ? 'Windows 8.1 (64-bit)' : 'Windows 8.1'
    else if (/Windows NT 6\.2/i.test(ua)) os = win64 ? 'Windows 8 (64-bit)' : 'Windows 8'
    else if (/Windows NT 6\.1/i.test(ua)) os = win64 ? 'Windows 7 (64-bit)' : 'Windows 7'
    else if (/Windows NT 6\.0/i.test(ua)) os = 'Windows Vista'
    else if (/Windows NT 5\.1/i.test(ua)) os = 'Windows XP'
    else if (/Windows NT 10\b/i.test(ua)) os = win64 ? 'Windows 10/11 (64-bit)' : 'Windows 10/11'
    else if (/Windows NT/i.test(ua)) os = 'Windows'
    else if ((m = ua.match(/Android ([\d.]+)/i))) os = `Android ${m[1]}`
    else if ((m = ua.match(/CPU (?:iPhone )?OS ([\d_]+)/i))) os = `iOS ${m[1].replace(/_/g, '.')}`
    else if ((m = ua.match(/Mac OS X ([\d_]+)/i))) os = `macOS ${m[1].replace(/_/g, '.')}`
    else if (/CrOS/i.test(ua)) os = 'Chrome OS'
    else if (/Linux|X11/i.test(ua)) os = win64 ? 'Linux (64-bit)' : 'Linux'

    /** Edge Android usa token EdgA/, não Edg/. */
    if ((m = ua.match(/\bEdgA\/([\d.]+)/i))) {
      browser = 'Microsoft Edge (Android)'
      version = m[1]
      base = UA_BASE_CHROMIUM
      if (os === '—' && (m = ua.match(/Android ([\d.]+)/i))) os = `Android ${m[1]}`
      type = 'Mobile'
    } else if ((m = ua.match(/\bEdg\/([\d.]+)/i))) {
      browser = 'Microsoft Edge'
      version = m[1]
      base = UA_BASE_CHROMIUM
    } else if ((m = ua.match(/\bOPR\/([\d.]+)/i))) {
      browser = 'Opera'
      version = m[1]
      base = UA_BASE_CHROMIUM
    } else if ((m = ua.match(/\bSamsungBrowser\/([\d.]+)/i))) {
      browser = 'Samsung Internet'
      version = m[1]
      base = UA_BASE_CHROMIUM
    } else if ((m = ua.match(/\bFxiOS\/([\d.]+)/i))) {
      browser = 'Firefox (iOS)'
      version = m[1]
      base = 'Gecko'
    } else if ((m = ua.match(/\bFirefox\/([\d.]+)/i))) {
      browser = 'Mozilla Firefox'
      version = m[1]
      base = 'Gecko'
    } else if ((m = ua.match(/\b(?:MSIE |Trident\/.*rv:)([\d.]+)/i))) {
      browser = 'Internet Explorer'
      version = m[1]
      base = 'Trident'
    } else if ((m = ua.match(/\bEdge\/([\d.]+)/i))) {
      browser = 'Edge (legado)'
      version = m[1]
      base = 'EdgeHTML'
    } else if ((m = ua.match(/\bCriOS\/([\d.]+)/i))) {
      browser = 'Chrome (iOS)'
      version = m[1]
      base = UA_BASE_CHROMIUM
    } else if ((m = ua.match(/\bChrome\/([\d.]+)/i))) {
      browser = /Electron/i.test(ua)
        ? 'Electron'
        : /HeadlessChrome/i.test(ua)
          ? 'Headless Chrome'
          : /Chromium/i.test(ua)
            ? 'Chromium'
            : 'Google Chrome'
      version = m[1]
      base = UA_BASE_CHROMIUM
    } else if (
      (m = ua.match(/\bVersion\/([\d.]+)/i)) &&
      /\bSafari/i.test(ua) &&
      !/\b(?:Chrome|CriOS|Chromium)\b/i.test(ua)
    ) {
      browser = 'Safari'
      version = m[1]
      base = 'WebKit'
    } else if ((m = ua.match(/\bcurl\/([\d.]+)/i))) {
      browser = 'curl'
      version = m[1]
      base = '—'
    } else if ((m = ua.match(/\bPostmanRuntime\/([\d.]+)/i))) {
      browser = 'Postman'
      version = m[1]
      base = '—'
    }

    /** UA só com produto (sem “Mozilla/… (Windows…)”) — comum em agregações / logs truncados. */
    if (
      os === '—' &&
      type === 'Desktop' &&
      /\b(?:Chrome|Edg|Firefox|OPR|SamsungBrowser)\//i.test(ua) &&
      !/\b(?:Android|iPhone|iPad|iPod|Linux|X11|CrOS|Mac OS X|CPU (?:iPhone )?OS)\b/i.test(ua)
    ) {
      os = win64 || /WOW64|Win64/i.test(ua) ? 'Windows 10+ (inferido, 64-bit)' : 'Windows 10+ (inferido)'
    }

    return { browser, version, base, os, type }
  }

  /** Texto curto (pt-BR) para exibir ao lado do código em listagens de sc-status. */
  function httpStatusDescription(code) {
    const n = Number(code)
    if (!Number.isFinite(n) || n < 100 || n > 599) return 'Código inválido'
    const map = {
      100: 'Continue',
      101: 'Troca de protocolo',
      102: 'Processando',
      200: 'OK',
      201: 'Criado',
      202: 'Aceito',
      203: 'Informação não autoritativa',
      204: 'Sem conteúdo',
      205: 'Reset de conteúdo',
      206: 'Conteúdo parcial',
      207: 'Multi-status',
      208: 'Já reportado',
      226: 'IM usado',
      300: 'Múltiplas escolhas',
      301: 'Movido permanentemente',
      302: 'Encontrado',
      303: 'Ver outro',
      304: 'Não modificado',
      305: 'Usar proxy',
      307: 'Redirecionamento temporário',
      308: 'Redirecionamento permanente',
      400: 'Requisição inválida',
      401: 'Não autorizado',
      402: 'Pagamento necessário',
      403: 'Proibido',
      404: 'Não encontrado',
      405: 'Método não permitido',
      406: 'Não aceitável',
      407: 'Autenticação de proxy necessária',
      408: 'Tempo esgotado',
      409: 'Conflito',
      410: 'Removido',
      411: 'Comprimento necessário',
      413: 'Payload muito grande',
      414: 'URI muito longa',
      415: 'Tipo de mídia não suportado',
      416: 'Intervalo não satisfatório',
      417: 'Expectativa falhou',
      421: 'Requisição mal direcionada',
      422: 'Entidade não processável',
      423: 'Bloqueado',
      424: 'Dependência falhou',
      425: 'Muito cedo',
      426: 'Upgrade necessário',
      428: 'Pré-requisito necessário',
      429: 'Muitas requisições',
      431: 'Campos de cabeçalho muito grandes',
      451: 'Indisponível por motivos legais',
      500: 'Erro interno do servidor',
      501: 'Não implementado',
      502: 'Gateway inválido',
      503: 'Serviço indisponível',
      504: 'Tempo esgotado no gateway',
      505: 'Versão HTTP não suportada',
      507: 'Armazenamento insuficiente',
      508: 'Loop detectado',
      510: 'Não estendido',
      511: 'Autenticação de rede necessária',
    }
    if (map[n]) return map[n]
    const c = Math.floor(n / 100)
    if (c === 1) return 'Informativo'
    if (c === 2) return 'Sucesso'
    if (c === 3) return 'Redirecionamento'
    if (c === 4) return 'Erro do cliente'
    if (c === 5) return 'Erro do servidor'
    return 'Desconhecido'
  }

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
  const PARSE_SETTINGS_STORAGE_KEY = 'iis-log-viewer-parse-settings-v1'
  const ENDPOINT_GROUPS_STORAGE_KEY = 'iis-log-viewer-endpoint-groups-v1'
  const SESSION_FILTERS_STORAGE_KEY = 'iis-log-viewer-session-filters-v1'

  function readSessionFiltersPayload() {
    try {
      const raw = sessionStorage.getItem(SESSION_FILTERS_STORAGE_KEY)
      if (!raw) return null
      const data = JSON.parse(raw)
      return data && typeof data === 'object' ? data : null
    } catch (_) {
      return null
    }
  }

  /** Endpoints SignalR “barulho” — iniciam desmarcados no filtro stem. */
  function isDefaultExcludedSignalrRel(rel) {
    if (!rel || typeof rel !== 'string') return false
    const r = rel.startsWith('/') ? rel : `/${rel}`
    return (
      /^\/signalr\/signalr\/(abort|connect|hubs|negotiate|ping|poll|send|start)$/i.test(r) ||
      /^\/signalr\/(abort|connect|hubs|negotiate|ping|poll|send|start)$/i.test(r)
    )
  }

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
    TABLE_HEAVY_URI: 'table-heavy-uri',
    CHART_PIE_IP: 'chart-pie-ip',
    CHART_PIE_APP: 'chart-pie-app',
    TABLE_USER_AGENT: 'table-user-agent',
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
      [{ uid: genDashboardUid(), type: WIDGET_TYPES.TABLE_HEAVY_URI, colSpan: 12, heightPx: 480 }],
      [
        { uid: genDashboardUid(), type: WIDGET_TYPES.CHART_PIE_IP, colSpan: 6, heightPx: 340 },
        { uid: genDashboardUid(), type: WIDGET_TYPES.CHART_PIE_APP, colSpan: 6, heightPx: 340 },
      ],
      [{ uid: genDashboardUid(), type: WIDGET_TYPES.TABLE_USER_AGENT, colSpan: 12, heightPx: 400 }],
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
    if (type === WIDGET_TYPES.TABLE_HEAVY_URI) return 480
    if (type === WIDGET_TYPES.CHART_PIE_IP || type === WIDGET_TYPES.CHART_PIE_APP) return 340
    if (type === WIDGET_TYPES.TABLE_USER_AGENT) return 400
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

  function normalizeEndpointGroupPrefix(raw) {
    if (!raw || typeof raw !== 'string') return ''
    let s = raw.trim()
    if (!s) return ''
    if (!s.startsWith('/')) s = `/${s}`
    if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
    return s
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

      const requestDetailModalOpen = ref(false)
      const requestDetailHint = ref('')
      const requestDetailSnapshot = ref([])
      const requestDetailSearch = ref('')
      const requestDetailSearchDraft = ref('')
      const requestDetailPageSize = ref(10)
      const requestDetailPage = ref(1)
      const requestDetailSort = ref({ key: 'timestamp', dir: 'asc' })
      const requestDetailSortAtOpen = ref({ key: 'timestamp', dir: 'asc' })

      function openRequestDetailFromBucket(bucketStartMs, bucketMsVal, sourceLabel) {
        const t0 = bucketStartMs
        const bm = Math.max(1000, bucketMsVal | 0)
        const from = t0 - REQUEST_DETAIL_MARGIN_MS
        const to = t0 + bm + REQUEST_DETAIL_MARGIN_MS
        const rows = []
        for (const r of baseRows.value) {
          if (r.timestamp < from || r.timestamp > to) continue
          rows.push({ ...r, stemGrouped: displayStemForGroupedChart(r) })
        }
        rows.sort((a, b) => a.timestamp - b.timestamp)
        requestDetailSnapshot.value = rows
        requestDetailSearch.value = ''
        requestDetailSearchDraft.value = ''
        requestDetailPageSize.value = 10
        requestDetailPage.value = 1
        const initial = { key: 'timestamp', dir: 'asc' }
        requestDetailSort.value = { ...initial }
        requestDetailSortAtOpen.value = { ...initial }
        requestDetailHint.value =
          `${sourceLabel} · coluna ${fmtBucket(t0)} (bucket ~${Math.round(bm / 1000)}s) · janela: ${fmtBucket(from)} → ${fmtBucket(to)}`
        requestDetailModalOpen.value = true
      }

      function closeRequestDetailModal() {
        requestDetailModalOpen.value = false
        requestDetailSnapshot.value = []
      }

      function sortRequestDetailColumn(columnKey) {
        const cur = requestDetailSort.value
        if (cur.key !== columnKey) requestDetailSort.value = { key: columnKey, dir: 'asc' }
        else requestDetailSort.value = { key: columnKey, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
      }

      function resetRequestDetailSort() {
        const o = requestDetailSortAtOpen.value
        requestDetailSort.value = { key: o.key, dir: o.dir }
      }

      function applyRequestDetailSearch() {
        requestDetailSearch.value = requestDetailSearchDraft.value.trim().toLowerCase()
        requestDetailPage.value = 1
      }

      const requestDetailFilteredRows = computed(() => {
        if (!requestDetailModalOpen.value) return []
        const q = requestDetailSearch.value.trim().toLowerCase()
        const snap = requestDetailSnapshot.value
        if (!q) return snap.slice()
        return snap.filter((r) => {
          const hay = [
            fmtBucket(r.timestamp),
            r.clientIp,
            r.method,
            r.stemGrouped || '',
            r.stem || '',
            String(r.status),
            String(r.timeTaken),
            r.userAgent || '',
          ]
            .join(' ')
            .toLowerCase()
          return hay.indexOf(q) !== -1
        })
      })

      const requestDetailFilteredCount = computed(() => requestDetailFilteredRows.value.length)

      const requestDetailTotalPages = computed(() => {
        const n = requestDetailFilteredCount.value
        const ps = Math.max(1, requestDetailPageSize.value | 0)
        return Math.max(1, Math.ceil(n / ps))
      })

      const requestDetailSortedRows = computed(() => {
        const list = requestDetailFilteredRows.value.map((r) => ({ ...r }))
        const { key, dir } = requestDetailSort.value
        const m = dir === 'asc' ? 1 : -1
        list.sort((a, b) => {
          if (key === 'timestamp') return m * (a.timestamp - b.timestamp)
          if (key === 'clientIp') return m * a.clientIp.localeCompare(b.clientIp, 'pt-BR', { sensitivity: 'base' })
          if (key === 'method') return m * a.method.localeCompare(b.method, 'pt-BR', { sensitivity: 'base' })
          if (key === 'stemGrouped')
            return m * (a.stemGrouped || '').localeCompare(b.stemGrouped || '', 'pt-BR', { sensitivity: 'base' })
          if (key === 'status') return m * (Number(a.status) - Number(b.status))
          if (key === 'timeTaken') return m * (a.timeTaken - b.timeTaken)
          return 0
        })
        return list
      })

      const requestDetailPagedRows = computed(() => {
        const ps = Math.max(1, requestDetailPageSize.value | 0)
        const page = Math.max(1, requestDetailPage.value | 0)
        const all = requestDetailSortedRows.value
        const start = (page - 1) * ps
        return all.slice(start, start + ps)
      })

      const requestDetailPagerPages = computed(() =>
        pagerWindow(requestDetailPage.value, requestDetailTotalPages.value),
      )

      const requestDetailShowingFrom = computed(() => {
        const n = requestDetailFilteredCount.value
        if (!n) return 0
        return (requestDetailPage.value - 1) * Math.max(1, requestDetailPageSize.value | 0) + 1
      })

      const requestDetailShowingTo = computed(() => {
        const n = requestDetailFilteredCount.value
        if (!n) return 0
        return Math.min(n, requestDetailPage.value * Math.max(1, requestDetailPageSize.value | 0))
      })

      watch([requestDetailFilteredCount, requestDetailPageSize], () => {
        const maxP = requestDetailTotalPages.value
        if (requestDetailPage.value > maxP) requestDetailPage.value = maxP
        if (requestDetailPage.value < 1) requestDetailPage.value = 1
      })

      function requestDetailFirstPage() {
        requestDetailPage.value = 1
      }

      function requestDetailLastPage() {
        requestDetailPage.value = requestDetailTotalPages.value
      }

      function requestDetailSetPage(p) {
        if (typeof p !== 'number' || p < 1) return
        const maxP = requestDetailTotalPages.value
        requestDetailPage.value = Math.min(maxP, p)
      }

      function requestDetailPrevPage() {
        if (requestDetailPage.value > 1) requestDetailPage.value -= 1
      }

      function requestDetailNextPage() {
        const maxP = requestDetailTotalPages.value
        if (requestDetailPage.value < maxP) requestDetailPage.value += 1
      }

      function onRequestDetailPageSizeChange(ev) {
        const v = Number(ev?.target?.value)
        if (v === 10 || v === 20 || v === 50 || v === 100) {
          requestDetailPageSize.value = v
          requestDetailPage.value = 1
        }
      }

      const stemModalOpen = ref(false)
      /** Aplicação no modal: MODAL_APP_ALL = todas, ou nome de applicationOptions / APP_NONE */
      const modalEndpointApp = ref(MODAL_APP_ALL)
      /** Overlay “recalculando” após mudança de filtros (corpo da análise). */
      const filterRecomputing = ref(false)
      /** Overlay no widget TOP URIs ao mudar ordenação / agrupamento. */
      const heavyUriRecomputing = ref(false)

      function beginDeferredHeavyWork(run, which = 'filter') {
        const flag = which === 'heavyUri' ? heavyUriRecomputing : filterRecomputing
        flag.value = true
        requestAnimationFrame(() => {
          setTimeout(() => {
            try {
              run()
            } finally {
              nextTick(() => {
                flag.value = false
              })
            }
          }, 0)
        })
      }
      const staticExtIncluded = reactive({})
      const endpointStemIncluded = reactive({})

      function loadEndpointGroupsFromStorage() {
        try {
          const raw = localStorage.getItem(ENDPOINT_GROUPS_STORAGE_KEY)
          if (raw) {
            const arr = JSON.parse(raw)
            if (!Array.isArray(arr)) return []
            const out = []
            for (const x of arr) {
              if (!x || !x.prefix) continue
              const prefix = normalizeEndpointGroupPrefix(String(x.prefix))
              if (!prefix) continue
              out.push({
                id: typeof x.id === 'string' && x.id ? x.id : `g-${Math.random().toString(36).slice(2, 10)}`,
                prefix,
              })
            }
            return out
          }
        } catch (_) {}
        return []
      }

      const endpointGroups = ref(loadEndpointGroupsFromStorage())

      const sortedEndpointGroupPrefixes = computed(() =>
        [...endpointGroups.value]
          .map((g) => g.prefix)
          .filter(Boolean)
          .sort((a, b) => b.length - a.length),
      )

      function canonicalEndpointRel(stem) {
        if (!stem || stem === '-') return stem || '-'
        const appSeg = stemApplication(stem)
        const rel = relativeStem(stem, appSeg)
        for (const P of sortedEndpointGroupPrefixes.value) {
          if (!P) continue
          if (rel === P || rel.startsWith(P + '/')) return P
        }
        return rel
      }

      /** Stem exibido no gráfico de endpoints (agrupa filhos sob o prefixo). */
      function displayStemForGroupedChart(row) {
        const appSeg = stemApplication(row.stem)
        const canon = canonicalEndpointRel(row.stem)
        const relRaw = relativeStem(row.stem, appSeg)
        if (relRaw === canon) return row.stem
        if (!appSeg || appSeg === APP_NONE) return canon
        if (!canon || canon === '/') return `/${appSeg}`
        return `/${appSeg}${canon}`
      }

      function commitEndpointGroupsAndPersist(nextList) {
        beginDeferredHeavyWork(() => {
          endpointGroups.value = nextList
          try {
            localStorage.setItem(ENDPOINT_GROUPS_STORAGE_KEY, JSON.stringify(endpointGroups.value))
          } catch (_) {}
          mergeStemFilterDefaults()
          restoreSessionFiltersAfterMerge()
        }, 'filter')
      }

      const endpointGroupNewInput = ref('')
      const endpointGroupAdding = ref(false)
      const editingEndpointGroupId = ref(null)
      const editingEndpointGroupPrefix = ref('')

      function startAddEndpointGroup() {
        endpointGroupAdding.value = true
        endpointGroupNewInput.value = ''
      }

      function cancelAddEndpointGroup() {
        endpointGroupAdding.value = false
        endpointGroupNewInput.value = ''
      }

      function saveNewEndpointGroup() {
        const prefix = normalizeEndpointGroupPrefix(endpointGroupNewInput.value)
        if (!prefix) {
          cancelAddEndpointGroup()
          return
        }
        if (endpointGroups.value.some((g) => g.prefix === prefix)) {
          cancelAddEndpointGroup()
          return
        }
        commitEndpointGroupsAndPersist([
          ...endpointGroups.value,
          { id: `g-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`, prefix },
        ])
        cancelAddEndpointGroup()
      }

      function removeEndpointGroup(id) {
        if (editingEndpointGroupId.value === id) {
          editingEndpointGroupId.value = null
          editingEndpointGroupPrefix.value = ''
        }
        commitEndpointGroupsAndPersist(endpointGroups.value.filter((g) => g.id !== id))
      }

      function startEditEndpointGroup(g) {
        editingEndpointGroupId.value = g.id
        editingEndpointGroupPrefix.value = g.prefix
      }

      function cancelEditEndpointGroup() {
        editingEndpointGroupId.value = null
        editingEndpointGroupPrefix.value = ''
      }

      function saveEditEndpointGroup() {
        const id = editingEndpointGroupId.value
        if (!id) return
        const prefix = normalizeEndpointGroupPrefix(editingEndpointGroupPrefix.value)
        if (!prefix) {
          cancelEditEndpointGroup()
          return
        }
        const others = endpointGroups.value.filter((g) => g.id !== id).some((g) => g.prefix === prefix)
        if (others) {
          cancelEditEndpointGroup()
          return
        }
        commitEndpointGroupsAndPersist(
          endpointGroups.value.map((g) => (g.id === id ? { ...g, prefix } : g)),
        )
        cancelEditEndpointGroup()
      }

      function loadParseSettingsFromStorage() {
        try {
          const raw = localStorage.getItem(PARSE_SETTINGS_STORAGE_KEY)
          if (raw) {
            const o = JSON.parse(raw)
            return {
              samplingEnabled: o.samplingEnabled !== false,
              targetLines: clampDim(Number(o.targetLines) || 320_000, 10_000, 10_000_000),
              maxRows: clampDim(Number(o.maxRows) || 350_000, 50_000, 5_000_000),
            }
          }
        } catch (_) {}
        return { samplingEnabled: true, targetLines: 320_000, maxRows: 350_000 }
      }

      const parseSettingsInitial = loadParseSettingsFromStorage()
      const parseSamplingEnabled = ref(parseSettingsInitial.samplingEnabled)
      const parseTargetLines = ref(parseSettingsInitial.targetLines)
      const parseMaxRows = ref(parseSettingsInitial.maxRows)
      const parseSettingsModalOpen = ref(false)
      const parseSettingsDraft = reactive({
        samplingEnabled: parseSettingsInitial.samplingEnabled,
        targetLines: parseSettingsInitial.targetLines,
        maxRows: parseSettingsInitial.maxRows,
      })

      function openParseSettingsModal() {
        parseSettingsDraft.samplingEnabled = parseSamplingEnabled.value
        parseSettingsDraft.targetLines = parseTargetLines.value
        parseSettingsDraft.maxRows = parseMaxRows.value
        parseSettingsModalOpen.value = true
      }

      function closeParseSettingsModal() {
        parseSettingsModalOpen.value = false
      }

      function saveParseSettingsFromModal() {
        parseSamplingEnabled.value = !!parseSettingsDraft.samplingEnabled
        parseTargetLines.value = clampDim(Number(parseSettingsDraft.targetLines) || 320_000, 10_000, 10_000_000)
        parseMaxRows.value = clampDim(Number(parseSettingsDraft.maxRows) || 350_000, 50_000, 5_000_000)
        parseSettingsDraft.targetLines = parseTargetLines.value
        parseSettingsDraft.maxRows = parseMaxRows.value
        try {
          localStorage.setItem(
            PARSE_SETTINGS_STORAGE_KEY,
            JSON.stringify({
              samplingEnabled: parseSamplingEnabled.value,
              targetLines: parseTargetLines.value,
              maxRows: parseMaxRows.value,
            }),
          )
        } catch (_) {}
        parseSettingsModalOpen.value = false
      }

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
            endpointSeen.add(canonicalEndpointRel(stem))
          }
        }
        for (const ext of staticSeen) {
          if (!(ext in staticExtIncluded)) staticExtIncluded[ext] = false
        }
        Object.keys(staticExtIncluded).forEach((ext) => {
          if (!staticSeen.has(ext)) delete staticExtIncluded[ext]
        })
        for (const k of endpointSeen) {
          if (!(k in endpointStemIncluded)) {
            endpointStemIncluded[k] = !isDefaultExcludedSignalrRel(k)
          }
        }
        Object.keys(endpointStemIncluded).forEach((k) => {
          if (!endpointSeen.has(k)) delete endpointStemIncluded[k]
        })
      }

      let sessionFiltersPersistTimer = null
      function persistSessionFilters() {
        if (sessionFiltersPersistTimer) clearTimeout(sessionFiltersPersistTimer)
        sessionFiltersPersistTimer = setTimeout(() => {
          sessionFiltersPersistTimer = null
          try {
            let staticSnap = { ...staticExtIncluded }
            let endpointSnap = { ...endpointStemIncluded }
            if (!rows.value.length) {
              const prev = readSessionFiltersPayload()
              if (prev?.staticExtIncluded && typeof prev.staticExtIncluded === 'object')
                staticSnap = { ...prev.staticExtIncluded }
              if (prev?.endpointStemIncluded && typeof prev.endpointStemIncluded === 'object')
                endpointSnap = { ...prev.endpointStemIncluded }
            }
            sessionStorage.setItem(
              SESSION_FILTERS_STORAGE_KEY,
              JSON.stringify({
                staticExtIncluded: staticSnap,
                endpointStemIncluded: endpointSnap,
                ipFilter: ipFilter.value,
                applicationFilter: applicationFilter.value,
                slowThresholdMs: slowThresholdMs.value,
                modalEndpointApp: modalEndpointApp.value,
              }),
            )
          } catch (_) {}
        }, 80)
      }

      function restoreSessionFiltersAfterMerge() {
        const data = readSessionFiltersPayload()
        if (!data) return
        if (data.staticExtIncluded && typeof data.staticExtIncluded === 'object') {
          for (const [k, v] of Object.entries(data.staticExtIncluded)) {
            if (k in staticExtIncluded && typeof v === 'boolean') staticExtIncluded[k] = v
          }
        }
        if (data.endpointStemIncluded && typeof data.endpointStemIncluded === 'object') {
          for (const [k, v] of Object.entries(data.endpointStemIncluded)) {
            if (k in endpointStemIncluded && typeof v === 'boolean') endpointStemIncluded[k] = v
          }
        }
        if (typeof data.ipFilter === 'string') ipFilter.value = data.ipFilter
        if (typeof data.applicationFilter === 'string') applicationFilter.value = data.applicationFilter
        if (typeof data.slowThresholdMs === 'number' && Number.isFinite(data.slowThresholdMs))
          slowThresholdMs.value = data.slowThresholdMs
        if (typeof data.modalEndpointApp === 'string') modalEndpointApp.value = data.modalEndpointApp
      }

      function hydrateSessionFiltersUiOnly() {
        const data = readSessionFiltersPayload()
        if (!data) return
        if (typeof data.ipFilter === 'string') ipFilter.value = data.ipFilter
        if (typeof data.applicationFilter === 'string') applicationFilter.value = data.applicationFilter
        if (typeof data.slowThresholdMs === 'number' && Number.isFinite(data.slowThresholdMs))
          slowThresholdMs.value = data.slowThresholdMs
        if (typeof data.modalEndpointApp === 'string') modalEndpointApp.value = data.modalEndpointApp
      }

      hydrateSessionFiltersUiOnly()

      watch(ipFilter, persistSessionFilters)
      watch(applicationFilter, persistSessionFilters)
      watch(slowThresholdMs, persistSessionFilters)
      watch(modalEndpointApp, persistSessionFilters)
      watch(staticExtIncluded, persistSessionFilters, { deep: true })
      watch(endpointStemIncluded, persistSessionFilters, { deep: true })

      function rowPassesStemFilter(row) {
        const stem = row.stem
        const ext = getStemExtension(stem)
        if (isStaticAssetRow(stem, ext)) {
          return staticExtIncluded[ext] !== false
        }
        const canon = canonicalEndpointRel(stem)
        return endpointStemIncluded[canon] !== false
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
          const ak = appKeyFromStem(stem)
          const canon = canonicalEndpointRel(stem)
          if (app !== MODAL_APP_ALL && ak !== app) continue
          map.set(canon, (map.get(canon) || 0) + 1)
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

      const stemStaticTablePag = reactive({ page: 1, pageSize: 10, q: '', qDraft: '' })
      const stemEndpointTablePag = reactive({ page: 1, pageSize: 10, q: '', qDraft: '' })

      const stemStaticFiltered = computed(() => {
        const rows = sortedStaticModalRows.value
        const q = stemStaticTablePag.q.trim().toLowerCase()
        if (!q) return rows
        return rows.filter((r) => {
          const hay = `.${r.ext} ${r.count}`.toLowerCase()
          return hay.indexOf(q) !== -1
        })
      })
      const stemStaticTotalPages = computed(() =>
        Math.max(1, Math.ceil(stemStaticFiltered.value.length / Math.max(1, stemStaticTablePag.pageSize | 0))),
      )
      const stemStaticPaged = computed(() => {
        const ps = Math.max(1, stemStaticTablePag.pageSize | 0)
        const pg = Math.max(1, stemStaticTablePag.page | 0)
        const list = stemStaticFiltered.value
        return list.slice((pg - 1) * ps, (pg - 1) * ps + ps)
      })
      const stemStaticPagerPages = computed(() => pagerWindow(stemStaticTablePag.page, stemStaticTotalPages.value))
      const stemStaticShowingFrom = computed(() => {
        const n = stemStaticFiltered.value.length
        if (!n) return 0
        return (stemStaticTablePag.page - 1) * Math.max(1, stemStaticTablePag.pageSize | 0) + 1
      })
      const stemStaticShowingTo = computed(() => {
        const n = stemStaticFiltered.value.length
        if (!n) return 0
        return Math.min(n, stemStaticTablePag.page * Math.max(1, stemStaticTablePag.pageSize | 0))
      })

      const stemEndpointFiltered = computed(() => {
        const rows = sortedEndpointModalRows.value
        const q = stemEndpointTablePag.q.trim().toLowerCase()
        if (!q) return rows
        return rows.filter((r) => {
          const hay = `${r.relStem} ${r.count}`.toLowerCase()
          return hay.indexOf(q) !== -1
        })
      })
      const stemEndpointTotalPages = computed(() =>
        Math.max(1, Math.ceil(stemEndpointFiltered.value.length / Math.max(1, stemEndpointTablePag.pageSize | 0))),
      )
      const stemEndpointPaged = computed(() => {
        const ps = Math.max(1, stemEndpointTablePag.pageSize | 0)
        const pg = Math.max(1, stemEndpointTablePag.page | 0)
        const list = stemEndpointFiltered.value
        return list.slice((pg - 1) * ps, (pg - 1) * ps + ps)
      })
      const stemEndpointPagerPages = computed(() =>
        pagerWindow(stemEndpointTablePag.page, stemEndpointTotalPages.value),
      )
      const stemEndpointShowingFrom = computed(() => {
        const n = stemEndpointFiltered.value.length
        if (!n) return 0
        return (stemEndpointTablePag.page - 1) * Math.max(1, stemEndpointTablePag.pageSize | 0) + 1
      })
      const stemEndpointShowingTo = computed(() => {
        const n = stemEndpointFiltered.value.length
        if (!n) return 0
        return Math.min(n, stemEndpointTablePag.page * Math.max(1, stemEndpointTablePag.pageSize | 0))
      })

      function applyStemStaticSearch() {
        stemStaticTablePag.q = String(stemStaticTablePag.qDraft || '').trim().toLowerCase()
        stemStaticTablePag.page = 1
      }
      function applyStemEndpointSearch() {
        stemEndpointTablePag.q = String(stemEndpointTablePag.qDraft || '').trim().toLowerCase()
        stemEndpointTablePag.page = 1
      }
      function onStemStaticPageSizeChange(ev) {
        const v = Number(ev?.target?.value)
        if (v === 10 || v === 20 || v === 50 || v === 100) {
          stemStaticTablePag.pageSize = v
          stemStaticTablePag.page = 1
        }
      }
      function onStemEndpointPageSizeChange(ev) {
        const v = Number(ev?.target?.value)
        if (v === 10 || v === 20 || v === 50 || v === 100) {
          stemEndpointTablePag.pageSize = v
          stemEndpointTablePag.page = 1
        }
      }
      function stemStaticFirstPage() {
        stemStaticTablePag.page = 1
      }
      function stemStaticLastPage() {
        stemStaticTablePag.page = stemStaticTotalPages.value
      }
      function stemStaticSetPage(p) {
        if (typeof p !== 'number' || p < 1) return
        stemStaticTablePag.page = Math.min(stemStaticTotalPages.value, p)
      }
      function stemStaticPrevPage() {
        if (stemStaticTablePag.page > 1) stemStaticTablePag.page--
      }
      function stemStaticNextPage() {
        if (stemStaticTablePag.page < stemStaticTotalPages.value) stemStaticTablePag.page++
      }
      function stemEndpointFirstPage() {
        stemEndpointTablePag.page = 1
      }
      function stemEndpointLastPage() {
        stemEndpointTablePag.page = stemEndpointTotalPages.value
      }
      function stemEndpointSetPage(p) {
        if (typeof p !== 'number' || p < 1) return
        stemEndpointTablePag.page = Math.min(stemEndpointTotalPages.value, p)
      }
      function stemEndpointPrevPage() {
        if (stemEndpointTablePag.page > 1) stemEndpointTablePag.page--
      }
      function stemEndpointNextPage() {
        if (stemEndpointTablePag.page < stemEndpointTotalPages.value) stemEndpointTablePag.page++
      }

      watch(
        () => [stemStaticFiltered.value.length, stemStaticTablePag.pageSize],
        () => {
          const maxP = stemStaticTotalPages.value
          if (stemStaticTablePag.page > maxP) stemStaticTablePag.page = maxP
          if (stemStaticTablePag.page < 1) stemStaticTablePag.page = 1
        },
      )
      watch(
        () => [stemEndpointFiltered.value.length, stemEndpointTablePag.pageSize],
        () => {
          const maxP = stemEndpointTotalPages.value
          if (stemEndpointTablePag.page > maxP) stemEndpointTablePag.page = maxP
          if (stemEndpointTablePag.page < 1) stemEndpointTablePag.page = 1
        },
      )

      watch(
        () => discoveredStaticExtensions.value.length,
        () => {
          stemStaticTablePag.page = 1
        },
      )
      watch(
        () => modalEndpointList.value.length,
        () => {
          stemEndpointTablePag.page = 1
        },
      )

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
      /** `uid` do widget exibido em overlay de tela cheia (`null` = nenhum). */
      const expandedWidgetUid = ref(null)

      function onFullscreenEscapeKey(e) {
        if (e.key === 'Escape') expandedWidgetUid.value = null
      }

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
        [WIDGET_TYPES.TABLE_HEAVY_URI]: 'TOP URIs (time-taken)',
        [WIDGET_TYPES.CHART_PIE_IP]: 'Pizza — % req. por IP',
        [WIDGET_TYPES.CHART_PIE_APP]: 'Pizza — % req. por aplicação (≥100)',
        [WIDGET_TYPES.TABLE_USER_AGENT]: 'User-Agent',
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
        [WIDGET_TYPES.TABLE_HEAVY_URI]: 'TOP 200 cs-uri-stem — time-taken (min / máx / médio / qtd.)',
        [WIDGET_TYPES.CHART_PIE_IP]: 'Distribuição de requisições por IP cliente (% do total)',
        [WIDGET_TYPES.CHART_PIE_APP]:
          'Distribuição por aplicação (1º segmento) — só apps com ≥ 100 req.; % do total filtrado',
        [WIDGET_TYPES.TABLE_USER_AGENT]: 'Requisições por User-Agent (detalhado)',
      }

      const chartCanvasEls = { timeline: null, endpoint: null, slowIp: null, pieIp: null, pieApp: null }

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
      let chartPieIp = null
      let chartPieApp = null

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
        if (chartPieIp) {
          chartPieIp.destroy()
          chartPieIp = null
        }
        if (chartPieApp) {
          chartPieApp.destroy()
          chartPieApp = null
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
          bucketTs: b.map((x) => x.t),
          avgMs: b.map((x) => x.avg),
          maxMs: b.map((x) => x.max),
          counts: b.map((x) => x.count),
        }
      })

      const endpointChart = computed(() => {
        const list = baseRows.value
        if (!list.length) return null
        const top = topEndpoints(list, 14, (r) => displayStemForGroupedChart(r))
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
          bucketTs: raw.labels.slice(),
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
          .map((r) => ({
            ...r,
            stemGrouped: displayStemForGroupedChart(r),
          }))
      })

      /** Ordenação do bloco TOP URIs: `max` | `min` | `avg` | `count` */
      const heavyUriSortKey = ref('max')
      /** Se true, agrega pelo mesmo stem exibido no gráfico de endpoints (grupos do modal). */
      const heavyUriUseGrouping = ref(true)

      const heavyUriTop200 = computed(() => {
        const list = baseRows.value
        if (!list.length) return []
        const useGroup = heavyUriUseGrouping.value
        const map = new Map()
        for (const r of list) {
          const stem = useGroup ? displayStemForGroupedChart(r) : r.stem
          const key = `${r.method}\t${stem}`
          let e = map.get(key)
          if (!e) {
            e = { method: r.method, stem, sum: r.timeTaken, count: 1, min: r.timeTaken, max: r.timeTaken }
            map.set(key, e)
          } else {
            e.min = Math.min(e.min, r.timeTaken)
            e.max = Math.max(e.max, r.timeTaken)
            e.sum += r.timeTaken
            e.count += 1
          }
        }
        const arr = [...map.values()].map((e) => ({
          method: e.method,
          stem: e.stem,
          min: e.min,
          max: e.max,
          avg: Math.round(e.sum / e.count),
          count: e.count,
        }))
        const sk = heavyUriSortKey.value
        if (sk === 'min') arr.sort((a, b) => b.min - a.min)
        else if (sk === 'avg') arr.sort((a, b) => b.avg - a.avg)
        else if (sk === 'count') arr.sort((a, b) => b.count - a.count)
        else arr.sort((a, b) => b.max - a.max)
        return arr.slice(0, 200)
      })

      const pieIpChart = computed(() => {
        const list = baseRows.value
        if (!list.length) return null
        const total = list.length
        const map = new Map()
        for (const r of list) {
          const ip = r.clientIp || '(sem IP)'
          map.set(ip, (map.get(ip) || 0) + 1)
        }
        const arr = [...map.entries()].sort((a, b) => b[1] - a[1])
        const top = arr.slice(0, PIE_IP_MAX_SLICES)
        let rest = 0
        for (let i = PIE_IP_MAX_SLICES; i < arr.length; i++) rest += arr[i][1]
        const labels = top.map(([ip]) => (ip.length > 36 ? `${ip.slice(0, 34)}…` : ip))
        const data = top.map(([, c]) => c)
        if (rest > 0) {
          const nRest = arr.length - PIE_IP_MAX_SLICES
          labels.push(`Outros (${nRest} IP${nRest === 1 ? '' : 's'})`)
          data.push(rest)
        }
        const percents = data.map((c) => (100 * c) / total)
        return { labels, data, total, percents }
      })

      const pieAppChart = computed(() => {
        const list = baseRows.value
        if (!list.length) return null
        const total = list.length
        const map = new Map()
        for (const r of list) {
          const seg = stemApplication(r.stem)
          const key = seg || APP_NONE
          map.set(key, (map.get(key) || 0) + 1)
        }
        const filtered = [...map.entries()]
          .filter(([, c]) => c >= PIE_APP_MIN_REQUESTS)
          .sort((a, b) => b[1] - a[1])
        if (!filtered.length) return null
        const labels = filtered.map(([name]) =>
          String(name).length > 40 ? `${String(name).slice(0, 38)}…` : String(name),
        )
        const data = filtered.map(([, c]) => c)
        const percents = data.map((c) => (100 * c) / total)
        return { labels, data, total, percents }
      })

      const userAgentTable = computed(() => {
        const list = baseRows.value
        if (!list.length) return []
        const total = list.length
        const map = new Map()
        for (const r of list) {
          const ua = (r.userAgent || '').trim() || '(vazio)'
          map.set(ua, (map.get(ua) || 0) + 1)
        }
        return [...map.entries()]
          .map(([userAgent, count]) => {
            const det = parseUserAgentDetails(userAgent)
            return {
              userAgent,
              count,
              percent: (100 * count) / total,
              ...det,
            }
          })
          .sort((a, b) => b.count - a.count)
          .slice(0, USER_AGENT_TABLE_MAX_ROWS)
      })

      const uaTablePag = reactive({ page: 1, pageSize: 10, q: '', qDraft: '' })
      const heavyTablePag = reactive({ page: 1, pageSize: 10, q: '', qDraft: '' })
      const slowTablePag = reactive({ page: 1, pageSize: 10, q: '', qDraft: '' })

      const uaTableFiltered = computed(() => {
        const rows = userAgentTable.value
        const q = uaTablePag.q.trim().toLowerCase()
        if (!q) return rows
        return rows.filter((row) => {
          const hay = [row.browser, row.version, row.base, row.os, row.type, row.userAgent, String(row.count)]
            .join(' ')
            .toLowerCase()
          return hay.indexOf(q) !== -1
        })
      })
      const uaTableTotalPages = computed(() =>
        Math.max(1, Math.ceil(uaTableFiltered.value.length / Math.max(1, uaTablePag.pageSize | 0))),
      )
      const uaTablePaged = computed(() => {
        const ps = Math.max(1, uaTablePag.pageSize | 0)
        const pg = Math.max(1, uaTablePag.page | 0)
        const list = uaTableFiltered.value
        return list.slice((pg - 1) * ps, (pg - 1) * ps + ps)
      })
      const uaTablePagerPages = computed(() => pagerWindow(uaTablePag.page, uaTableTotalPages.value))
      const uaTableShowingFrom = computed(() => {
        const n = uaTableFiltered.value.length
        if (!n) return 0
        return (uaTablePag.page - 1) * Math.max(1, uaTablePag.pageSize | 0) + 1
      })
      const uaTableShowingTo = computed(() => {
        const n = uaTableFiltered.value.length
        if (!n) return 0
        return Math.min(n, uaTablePag.page * Math.max(1, uaTablePag.pageSize | 0))
      })

      const heavyTableFiltered = computed(() => {
        const rows = heavyUriTop200.value
        const q = heavyTablePag.q.trim().toLowerCase()
        if (!q) return rows
        return rows.filter((row) => {
          const hay = [row.method, row.stem, String(row.min), String(row.max), String(row.avg), String(row.count)]
            .join(' ')
            .toLowerCase()
          return hay.indexOf(q) !== -1
        })
      })
      const heavyTableTotalPages = computed(() =>
        Math.max(1, Math.ceil(heavyTableFiltered.value.length / Math.max(1, heavyTablePag.pageSize | 0))),
      )
      const heavyTablePaged = computed(() => {
        const ps = Math.max(1, heavyTablePag.pageSize | 0)
        const pg = Math.max(1, heavyTablePag.page | 0)
        const list = heavyTableFiltered.value
        return list.slice((pg - 1) * ps, (pg - 1) * ps + ps)
      })
      const heavyTablePagerPages = computed(() => pagerWindow(heavyTablePag.page, heavyTableTotalPages.value))
      const heavyTableShowingFrom = computed(() => {
        const n = heavyTableFiltered.value.length
        if (!n) return 0
        return (heavyTablePag.page - 1) * Math.max(1, heavyTablePag.pageSize | 0) + 1
      })
      const heavyTableShowingTo = computed(() => {
        const n = heavyTableFiltered.value.length
        if (!n) return 0
        return Math.min(n, heavyTablePag.page * Math.max(1, heavyTablePag.pageSize | 0))
      })

      const slowTableFiltered = computed(() => {
        const rows = slowTable.value
        const q = slowTablePag.q.trim().toLowerCase()
        if (!q) return rows
        return rows.filter((r) => {
          const hay = [
            fmtBucket(r.timestamp),
            r.clientIp,
            r.method,
            r.stemGrouped || '',
            r.stem || '',
            String(r.status),
            String(r.timeTaken),
          ]
            .join(' ')
            .toLowerCase()
          return hay.indexOf(q) !== -1
        })
      })
      const slowTableTotalPages = computed(() =>
        Math.max(1, Math.ceil(slowTableFiltered.value.length / Math.max(1, slowTablePag.pageSize | 0))),
      )
      const slowTablePaged = computed(() => {
        const ps = Math.max(1, slowTablePag.pageSize | 0)
        const pg = Math.max(1, slowTablePag.page | 0)
        const list = slowTableFiltered.value
        return list.slice((pg - 1) * ps, (pg - 1) * ps + ps)
      })
      const slowTablePagerPages = computed(() => pagerWindow(slowTablePag.page, slowTableTotalPages.value))
      const slowTableShowingFrom = computed(() => {
        const n = slowTableFiltered.value.length
        if (!n) return 0
        return (slowTablePag.page - 1) * Math.max(1, slowTablePag.pageSize | 0) + 1
      })
      const slowTableShowingTo = computed(() => {
        const n = slowTableFiltered.value.length
        if (!n) return 0
        return Math.min(n, slowTablePag.page * Math.max(1, slowTablePag.pageSize | 0))
      })

      function applyUaTableSearch() {
        uaTablePag.q = String(uaTablePag.qDraft || '').trim().toLowerCase()
        uaTablePag.page = 1
      }
      function onUaTablePageSizeChange(ev) {
        const v = Number(ev?.target?.value)
        if (v === 10 || v === 20 || v === 50 || v === 100) {
          uaTablePag.pageSize = v
          uaTablePag.page = 1
        }
      }
      function uaTableFirstPage() {
        uaTablePag.page = 1
      }
      function uaTableLastPage() {
        uaTablePag.page = uaTableTotalPages.value
      }
      function uaTableSetPage(p) {
        if (typeof p !== 'number' || p < 1) return
        uaTablePag.page = Math.min(uaTableTotalPages.value, p)
      }
      function uaTablePrevPage() {
        if (uaTablePag.page > 1) uaTablePag.page--
      }
      function uaTableNextPage() {
        if (uaTablePag.page < uaTableTotalPages.value) uaTablePag.page++
      }

      function applyHeavyTableSearch() {
        heavyTablePag.q = String(heavyTablePag.qDraft || '').trim().toLowerCase()
        heavyTablePag.page = 1
      }
      function onHeavyTablePageSizeChange(ev) {
        const v = Number(ev?.target?.value)
        if (v === 10 || v === 20 || v === 50 || v === 100) {
          heavyTablePag.pageSize = v
          heavyTablePag.page = 1
        }
      }
      function heavyTableFirstPage() {
        heavyTablePag.page = 1
      }
      function heavyTableLastPage() {
        heavyTablePag.page = heavyTableTotalPages.value
      }
      function heavyTableSetPage(p) {
        if (typeof p !== 'number' || p < 1) return
        heavyTablePag.page = Math.min(heavyTableTotalPages.value, p)
      }
      function heavyTablePrevPage() {
        if (heavyTablePag.page > 1) heavyTablePag.page--
      }
      function heavyTableNextPage() {
        if (heavyTablePag.page < heavyTableTotalPages.value) heavyTablePag.page++
      }

      function applySlowTableSearch() {
        slowTablePag.q = String(slowTablePag.qDraft || '').trim().toLowerCase()
        slowTablePag.page = 1
      }
      function onSlowTablePageSizeChange(ev) {
        const v = Number(ev?.target?.value)
        if (v === 10 || v === 20 || v === 50 || v === 100) {
          slowTablePag.pageSize = v
          slowTablePag.page = 1
        }
      }
      function slowTableFirstPage() {
        slowTablePag.page = 1
      }
      function slowTableLastPage() {
        slowTablePag.page = slowTableTotalPages.value
      }
      function slowTableSetPage(p) {
        if (typeof p !== 'number' || p < 1) return
        slowTablePag.page = Math.min(slowTableTotalPages.value, p)
      }
      function slowTablePrevPage() {
        if (slowTablePag.page > 1) slowTablePag.page--
      }
      function slowTableNextPage() {
        if (slowTablePag.page < slowTableTotalPages.value) slowTablePag.page++
      }

      watch(
        () => [uaTableFiltered.value.length, uaTablePag.pageSize],
        () => {
          const maxP = uaTableTotalPages.value
          if (uaTablePag.page > maxP) uaTablePag.page = maxP
          if (uaTablePag.page < 1) uaTablePag.page = 1
        },
      )
      watch(
        () => [heavyTableFiltered.value.length, heavyTablePag.pageSize],
        () => {
          const maxP = heavyTableTotalPages.value
          if (heavyTablePag.page > maxP) heavyTablePag.page = maxP
          if (heavyTablePag.page < 1) heavyTablePag.page = 1
        },
      )
      watch(
        () => [slowTableFiltered.value.length, slowTablePag.pageSize],
        () => {
          const maxP = slowTableTotalPages.value
          if (slowTablePag.page > maxP) slowTablePag.page = maxP
          if (slowTablePag.page < 1) slowTablePag.page = 1
        },
      )

      watch(
        () => rows.value.length,
        () => {
          uaTablePag.page = 1
        },
      )
      watch(
        () => [rows.value.length, heavyUriSortKey.value, heavyUriUseGrouping.value],
        () => {
          heavyTablePag.page = 1
        },
      )
      watch(
        () => [rows.value.length, slowThresholdMs.value],
        () => {
          slowTablePag.page = 1
        },
      )

      function setHeavyUriSort(key) {
        if (key !== 'max' && key !== 'min' && key !== 'avg' && key !== 'count') return
        if (heavyUriSortKey.value === key) return
        beginDeferredHeavyWork(() => {
          heavyUriSortKey.value = key
        }, 'heavyUri')
      }

      function setHeavyUriUseGrouping(val) {
        const v = !!val
        if (heavyUriUseGrouping.value === v) return
        beginDeferredHeavyWork(() => {
          heavyUriUseGrouping.value = v
        }, 'heavyUri')
      }

      function onIpFilterChange(val) {
        const s = val == null ? '' : String(val)
        if (s === ipFilter.value) return
        beginDeferredHeavyWork(() => {
          ipFilter.value = s
        }, 'filter')
      }

      function onApplicationFilterChange(val) {
        const s = val == null ? '' : String(val)
        if (s === applicationFilter.value) return
        beginDeferredHeavyWork(() => {
          applicationFilter.value = s
        }, 'filter')
      }

      function onSlowThresholdChange(ev) {
        const raw = Number(ev?.target?.value)
        const v = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : slowThresholdMs.value
        if (v === slowThresholdMs.value) return
        beginDeferredHeavyWork(() => {
          slowThresholdMs.value = v
        }, 'filter')
      }

      function onModalEndpointAppChange(val) {
        const s = val == null ? '' : String(val)
        if (s === modalEndpointApp.value) return
        beginDeferredHeavyWork(() => {
          modalEndpointApp.value = s
        }, 'filter')
      }

      function onStaticExtIncludedChange(ext, checked) {
        beginDeferredHeavyWork(() => {
          staticExtIncluded[ext] = checked
        }, 'filter')
      }

      function onEndpointStemIncludedChange(stateKey, checked) {
        beginDeferredHeavyWork(() => {
          endpointStemIncluded[stateKey] = checked
        }, 'filter')
      }

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
              onHover: (e, els, ch) => {
                const c = ch?.canvas
                if (!c) return
                if (layoutEditMode.value) {
                  c.style.cursor = 'default'
                  return
                }
                c.style.cursor = els?.length ? 'pointer' : 'default'
              },
              onClick: (e, els, ch) => {
                if (layoutEditMode.value) return
                let idx = els?.[0]?.index
                if (idx == null) {
                  const found = ch.getElementsAtEventForMode(e, 'index', { intersect: false }, true)
                  idx = found?.[0]?.index
                }
                if (idx == null || idx < 0) return
                const series = timelineSeries.value
                const bm = bucketMs.value
                if (!series?.bucketTs || idx >= series.bucketTs.length) return
                openRequestDetailFromBucket(series.bucketTs[idx], bm, 'Linha do tempo')
              },
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
              onHover: (e, els, ch) => {
                const c = ch?.canvas
                if (!c) return
                if (layoutEditMode.value) {
                  c.style.cursor = 'default'
                  return
                }
                c.style.cursor = els?.length ? 'pointer' : 'default'
              },
              onClick: (e, els, ch) => {
                if (layoutEditMode.value) return
                let idx = els?.[0]?.index
                if (idx == null) {
                  const found = ch.getElementsAtEventForMode(e, 'index', { intersect: false }, true)
                  idx = found?.[0]?.index
                }
                if (idx == null || idx < 0) return
                const sic = slowIpChart.value
                const bm = bucketMs.value
                if (!sic?.bucketTs || idx >= sic.bucketTs.length) return
                openRequestDetailFromBucket(sic.bucketTs[idx], bm, 'IPs com mais requisições lentas')
              },
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

        const pieIp = pieIpChart.value
        const cPieIp = chartCanvasEls.pieIp
        if (chartPieIp) {
          chartPieIp.destroy()
          chartPieIp = null
        }
        if (cPieIp && pieIp) {
          const bg = pieSliceColors(pieIp.labels.length)
          chartPieIp = new Chart(cPieIp, {
            type: 'pie',
            data: {
              labels: pieIp.labels,
              datasets: [
                {
                  data: pieIp.data,
                  backgroundColor: bg,
                  borderColor: 'rgba(26, 29, 32, 0.9)',
                  borderWidth: 1,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: {
                  position: 'right',
                  labels: { color: textColor, boxWidth: 12, font: { size: 10 } },
                },
                tooltip: {
                  callbacks: {
                    label(ctx) {
                      const i = ctx.dataIndex
                      const n = pieIp.data[i]
                      const p = pieIp.percents[i]
                      const pct = Number.isFinite(p)
                        ? p.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : '—'
                      return `${n.toLocaleString('pt-BR')} req. (${pct}% do total)`
                    },
                  },
                },
              },
            },
          })
        }

        const pieApp = pieAppChart.value
        const cPieApp = chartCanvasEls.pieApp
        if (chartPieApp) {
          chartPieApp.destroy()
          chartPieApp = null
        }
        if (cPieApp && pieApp) {
          const bg = pieSliceColors(pieApp.labels.length)
          chartPieApp = new Chart(cPieApp, {
            type: 'pie',
            data: {
              labels: pieApp.labels,
              datasets: [
                {
                  data: pieApp.data,
                  backgroundColor: bg,
                  borderColor: 'rgba(26, 29, 32, 0.9)',
                  borderWidth: 1,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: {
                  position: 'right',
                  labels: { color: textColor, boxWidth: 12, font: { size: 10 } },
                },
                tooltip: {
                  callbacks: {
                    label(ctx) {
                      const i = ctx.dataIndex
                      const n = pieApp.data[i]
                      const p = pieApp.percents[i]
                      const pct = Number.isFinite(p)
                        ? p.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : '—'
                      return `${n.toLocaleString('pt-BR')} req. (${pct}% do total)`
                    },
                  },
                },
              },
            },
          })
        }
      }

      function fmtPercent(n) {
        if (!Number.isFinite(n)) return '—'
        return `${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`
      }

      watch(
        layoutEditMode,
        (on) => {
          document.body.classList.toggle('iis-layout-arranging', !!on)
        },
        { immediate: true },
      )

      watch(expandedWidgetUid, (uid) => {
        document.body.style.overflow = uid ? 'hidden' : ''
        if (uid) {
          window.addEventListener('keydown', onFullscreenEscapeKey)
        } else {
          window.removeEventListener('keydown', onFullscreenEscapeKey)
        }
        nextTick(() => {
          chartTimeline?.resize()
          chartEndpoint?.resize()
          chartSlowIp?.resize()
          chartPieIp?.resize()
          chartPieApp?.resize()
        })
      })

      function toggleWidgetFullscreen(uid) {
        expandedWidgetUid.value = expandedWidgetUid.value === uid ? null : uid
      }

      function closeWidgetFullscreen() {
        expandedWidgetUid.value = null
      }

      function onRequestDetailEscapeKey(e) {
        if (e.key === 'Escape' && requestDetailModalOpen.value) closeRequestDetailModal()
      }

      watch(requestDetailModalOpen, (open) => {
        if (open) window.addEventListener('keydown', onRequestDetailEscapeKey)
        else window.removeEventListener('keydown', onRequestDetailEscapeKey)
      })

      onUnmounted(() => {
        document.body.classList.remove('iis-layout-arranging')
        document.body.style.overflow = ''
        window.removeEventListener('keydown', onFullscreenEscapeKey)
        window.removeEventListener('keydown', onRequestDetailEscapeKey)
      })

      watch(
        [
          stats,
          timelineSeries,
          endpointChart,
          slowIpChart,
          pieIpChart,
          pieAppChart,
          slowThresholdMs,
          ipFilter,
          applicationFilter,
        ],
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
        clearStemFilters()
        stemModalOpen.value = false
        modalEndpointApp.value = MODAL_APP_ALL
        destroyCharts()

        try {
          const totalLines = estimateLineCount(text)
          const sampleEvery =
            !parseSamplingEnabled.value || totalLines <= parseTargetLines.value
              ? 1
              : Math.ceil(totalLines / parseTargetLines.value)

          const result = await parseIisLogText(text, {
            sampleEvery,
            maxRows: parseMaxRows.value,
            onProgress(p) {
              progress.value = Math.min(99, Math.round((100 * p.lineIndex) / p.totalLines))
            },
          })

          rows.value = result.rows
          mergeStemFilterDefaults()
          restoreSessionFiltersAfterMerge()
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
        expandedWidgetUid.value = null
        try {
          localStorage.removeItem(DASHBOARD_STORAGE_KEY)
        } catch (_) {}
        try {
          sessionStorage.removeItem(SESSION_FILTERS_STORAGE_KEY)
        } catch (_) {}
        filterRecomputing.value = false
        heavyUriRecomputing.value = false
        destroyCharts()
      }

      function openStemModal() {
        stemModalOpen.value = true
        stemStaticTablePag.page = 1
        stemStaticTablePag.q = ''
        stemStaticTablePag.qDraft = ''
        stemEndpointTablePag.page = 1
        stemEndpointTablePag.q = ''
        stemEndpointTablePag.qDraft = ''
      }

      function closeStemModal() {
        stemModalOpen.value = false
        cancelAddEndpointGroup()
        cancelEditEndpointGroup()
      }

      function toggleAllStaticExts(on) {
        beginDeferredHeavyWork(() => {
          for (const row of sortedStaticModalRows.value) {
            staticExtIncluded[row.ext] = on
          }
        }, 'filter')
      }

      function toggleAllModalEndpoints(on) {
        beginDeferredHeavyWork(() => {
          for (const row of sortedEndpointModalRows.value) {
            endpointStemIncluded[row.stateKey] = on
          }
        }, 'filter')
      }

      function resetStemFiltersToDefault() {
        beginDeferredHeavyWork(() => {
          mergeStemFilterDefaults()
          for (const row of discoveredStaticExtensions.value) {
            staticExtIncluded[row.ext] = false
          }
          Object.keys(endpointStemIncluded).forEach((k) => {
            endpointStemIncluded[k] = !isDefaultExcludedSignalrRel(k)
          })
        }, 'filter')
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
        endpointGroups,
        endpointGroupNewInput,
        endpointGroupAdding,
        editingEndpointGroupId,
        editingEndpointGroupPrefix,
        startAddEndpointGroup,
        cancelAddEndpointGroup,
        saveNewEndpointGroup,
        removeEndpointGroup,
        startEditEndpointGroup,
        saveEditEndpointGroup,
        cancelEditEndpointGroup,
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
        stemStaticTablePag,
        stemStaticFiltered,
        stemStaticPaged,
        stemStaticPagerPages,
        stemStaticShowingFrom,
        stemStaticShowingTo,
        stemStaticTotalPages,
        applyStemStaticSearch,
        onStemStaticPageSizeChange,
        stemStaticFirstPage,
        stemStaticLastPage,
        stemStaticSetPage,
        stemStaticPrevPage,
        stemStaticNextPage,
        stemEndpointTablePag,
        stemEndpointFiltered,
        stemEndpointPaged,
        stemEndpointPagerPages,
        stemEndpointShowingFrom,
        stemEndpointShowingTo,
        stemEndpointTotalPages,
        applyStemEndpointSearch,
        onStemEndpointPageSizeChange,
        stemEndpointFirstPage,
        stemEndpointLastPage,
        stemEndpointSetPage,
        stemEndpointPrevPage,
        stemEndpointNextPage,
        openStemModal,
        closeStemModal,
        requestDetailModalOpen,
        requestDetailHint,
        requestDetailSnapshot,
        requestDetailSearch,
        requestDetailSearchDraft,
        applyRequestDetailSearch,
        requestDetailPageSize,
        requestDetailPage,
        requestDetailSort,
        requestDetailFilteredCount,
        requestDetailTotalPages,
        requestDetailPagedRows,
        requestDetailPagerPages,
        requestDetailShowingFrom,
        requestDetailShowingTo,
        sortRequestDetailColumn,
        resetRequestDetailSort,
        requestDetailFirstPage,
        requestDetailLastPage,
        requestDetailSetPage,
        requestDetailPrevPage,
        requestDetailNextPage,
        onRequestDetailPageSizeChange,
        closeRequestDetailModal,
        toggleAllStaticExts,
        toggleAllModalEndpoints,
        resetStemFiltersToDefault,
        parseSamplingEnabled,
        parseTargetLines,
        parseMaxRows,
        parseSettingsModalOpen,
        parseSettingsDraft,
        openParseSettingsModal,
        closeParseSettingsModal,
        saveParseSettingsFromModal,
        layoutRows,
        layoutEditMode,
        layoutDragState,
        dropHintInsert,
        dropHintSwap,
        expandedWidgetUid,
        toggleWidgetFullscreen,
        closeWidgetFullscreen,
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
        pieIpChart,
        pieAppChart,
        statusBreakdown,
        slowTable,
        slowTablePag,
        slowTableFiltered,
        slowTablePaged,
        slowTablePagerPages,
        slowTableTotalPages,
        slowTableShowingFrom,
        slowTableShowingTo,
        applySlowTableSearch,
        onSlowTablePageSizeChange,
        slowTableFirstPage,
        slowTableLastPage,
        slowTableSetPage,
        slowTablePrevPage,
        slowTableNextPage,
        userAgentTable,
        uaTablePag,
        uaTableFiltered,
        uaTablePaged,
        uaTablePagerPages,
        uaTableTotalPages,
        uaTableShowingFrom,
        uaTableShowingTo,
        applyUaTableSearch,
        onUaTablePageSizeChange,
        uaTableFirstPage,
        uaTableLastPage,
        uaTableSetPage,
        uaTablePrevPage,
        uaTableNextPage,
        heavyTablePag,
        heavyTableFiltered,
        heavyTablePaged,
        heavyTablePagerPages,
        heavyTableTotalPages,
        heavyTableShowingFrom,
        heavyTableShowingTo,
        applyHeavyTableSearch,
        onHeavyTablePageSizeChange,
        heavyTableFirstPage,
        heavyTableLastPage,
        heavyTableSetPage,
        heavyTablePrevPage,
        heavyTableNextPage,
        heavyUriSortKey,
        heavyUriUseGrouping,
        heavyUriTop200,
        setHeavyUriSort,
        setHeavyUriUseGrouping,
        filterRecomputing,
        heavyUriRecomputing,
        onIpFilterChange,
        onApplicationFilterChange,
        onSlowThresholdChange,
        onModalEndpointAppChange,
        onStaticExtIncludedChange,
        onEndpointStemIncludedChange,
        fmtPercent,
        httpStatusDescription,
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
