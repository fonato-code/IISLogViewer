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

  const { createApp, ref, shallowRef, computed, watch, nextTick } = Vue

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

  createApp({
    setup() {
      const rows = shallowRef([])
      const loading = ref(false)
      const progress = ref(0)
      const errorMsg = ref('')
      const meta = ref(null)

      const slowThresholdMs = ref(400)
      const ipFilter = ref('')

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
        const list = rows.value
        const ip = ipFilter.value.trim()
        if (!ip) return list
        return list.filter((r) => r.clientIp.includes(ip))
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
        [stats, timelineSeries, endpointChart, slowIpChart, slowThresholdMs, ipFilter],
        () => {
          updateCharts()
        },
        { flush: 'post' },
      )

      async function loadFromText(text, filename) {
        errorMsg.value = ''
        loading.value = true
        progress.value = 0
        rows.value = []
        meta.value = null
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
        }
      }

      async function consumeFile(file) {
        if (!file) return
        errorMsg.value = ''
        const name = file.name || 'arquivo'

        try {
          if (name.toLowerCase().endsWith('.zip')) {
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
              return
            }
            await loadFromText(chunks.join('\n'), name)
            return
          }

          if (name.toLowerCase().endsWith('.log')) {
            const text = await file.text()
            await loadFromText(text, name)
            return
          }

          errorMsg.value = 'Envie um arquivo .zip (com logs .log) ou um .log único.'
        } catch (e) {
          errorMsg.value = e?.message || String(e)
          loading.value = false
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
        destroyCharts()
      }

      return {
        rows,
        loading,
        progress,
        errorMsg,
        meta,
        slowThresholdMs,
        ipFilter,
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
