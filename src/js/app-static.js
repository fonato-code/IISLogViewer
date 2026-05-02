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

  const { createApp, ref, shallowRef, computed, watch, nextTick, reactive } = Vue

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

  function endpointStateKey(appKey, relStem) {
    return `${appKey}::${relStem}`
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
      /** Aplicação escolhida na tabela de endpoints do modal (valor = applicationOptions.name, APP_NONE permitido) */
      const modalEndpointApp = ref('')
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
            const ak = appKeyFromStem(stem)
            const rel = relativeStem(stem, appSeg)
            endpointSeen.add(endpointStateKey(ak, rel))
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
        const ak = appKeyFromStem(stem)
        const rel = relativeStem(stem, appSeg)
        const k = endpointStateKey(ak, rel)
        return endpointStemIncluded[k] !== false
      }

      const discoveredStaticExtensions = computed(() => {
        const map = new Map()
        for (const r of rows.value) {
          const ext = getStemExtension(r.stem)
          if (!isStaticAssetRow(r.stem, ext)) continue
          map.set(ext, (map.get(ext) || 0) + 1)
        }
        return [...map.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([ext, count]) => ({ ext, count }))
      })

      const modalEndpointList = computed(() => {
        const app = modalEndpointApp.value
        if (!app) return []
        const map = new Map()
        for (const r of rows.value) {
          const stem = r.stem
          const ext = getStemExtension(stem)
          if (isStaticAssetRow(stem, ext)) continue
          const ak = appKeyFromStem(stem)
          if (ak !== app) continue
          const appSeg = stemApplication(stem)
          const rel = relativeStem(stem, appSeg)
          map.set(rel, (map.get(rel) || 0) + 1)
        }
        return [...map.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([relStem, count]) => ({
            relStem,
            count,
            stateKey: endpointStateKey(app, relStem),
          }))
      })

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

      const timelineCanvas = ref(null)
      const endpointCanvas = ref(null)
      const slowIpCanvas = ref(null)

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
        const c1 = timelineCanvas.value
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
        const c2 = endpointCanvas.value
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
        const c3 = slowIpCanvas.value
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
        modalEndpointApp.value = ''
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
        modalEndpointApp.value = ''
        destroyCharts()
      }

      function openStemModal() {
        stemModalOpen.value = true
        if (!modalEndpointApp.value && applicationFilter.value) {
          modalEndpointApp.value = applicationFilter.value
        }
      }

      function closeStemModal() {
        stemModalOpen.value = false
      }

      function toggleAllStaticExts(on) {
        for (const row of discoveredStaticExtensions.value) {
          staticExtIncluded[row.ext] = on
        }
      }

      function toggleAllModalEndpoints(on) {
        for (const row of modalEndpointList.value) {
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
        staticExtIncluded,
        endpointStemIncluded,
        discoveredStaticExtensions,
        modalEndpointList,
        stemFilterExcludedCount,
        openStemModal,
        closeStemModal,
        toggleAllStaticExts,
        toggleAllModalEndpoints,
        resetStemFiltersToDefault,
        fileInputRef,
        dragOver,
        timelineCanvas,
        endpointCanvas,
        slowIpCanvas,
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
