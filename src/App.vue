<script setup>
import { ref, shallowRef, computed } from 'vue'
import JSZip from 'jszip'
import { parseIisLogText, estimateLineCount } from './utils/iisParser.js'
import {
  suggestBucketMs,
  timelineBuckets,
  topEndpoints,
  topClientIps,
  ipSlowTimeline,
  statusMix,
} from './utils/aggregates.js'
import TimelineChart from './components/TimelineChart.vue'
import EndpointAvgChart from './components/EndpointAvgChart.vue'
import SlowIpChart from './components/SlowIpChart.vue'

const rows = shallowRef([])
const loading = ref(false)
const progress = ref(0)
const errorMsg = ref('')
const meta = ref(null)

const slowThresholdMs = ref(400)
const ipFilter = ref('')

const fileInputRef = ref(null)
const dragOver = ref(false)

function fmtBucket(ts) {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
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

async function loadFromText(text, filename) {
  errorMsg.value = ''
  loading.value = true
  progress.value = 0
  rows.value = []
  meta.value = null

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

function prevent(e) {
  e.preventDefault()
}

function clearData() {
  rows.value = []
  meta.value = null
  errorMsg.value = ''
}
</script>

<template>
  <div class="min-vh-100 d-flex flex-column">
    <nav class="navbar navbar-expand-lg border-bottom bg-body-tertiary mb-3">
      <div class="container-fluid">
        <span class="navbar-brand mb-0 h1 text-primary">
          <i class="fas fa-chart-line me-2" aria-hidden="true"></i>
          IIS Log Viewer
        </span>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <button type="button" class="btn btn-primary btn-sm" :disabled="loading" @click="onPickClick">
            <i class="fas fa-file-archive me-1" aria-hidden="true"></i>
            Importar ZIP / LOG
          </button>
          <button v-if="rows.length" type="button" class="btn btn-outline-secondary btn-sm" @click="clearData">
            Limpar
          </button>
        </div>
      </div>
    </nav>

    <main class="container-fluid flex-grow-1 pb-5 px-3">
      <input
        ref="fileInputRef"
        type="file"
        class="d-none"
        accept=".zip,.log"
        @change="onFileInput"
      />

      <div
        class="drop-zone p-5 mb-4 text-center"
        :class="{ dragover: dragOver }"
        @dragenter.prevent="dragOver = true"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
      >
        <p class="mb-2 text-secondary">
          Arraste um ZIP com arquivos <code>.log</code> do IIS ou um único <code>.log</code>.
        </p>
        <button type="button" class="btn btn-outline-primary" :disabled="loading" @click="onPickClick">
          Escolher arquivo
        </button>
      </div>

      <div v-if="loading" class="mb-4">
        <div class="d-flex justify-content-between small text-secondary mb-1">
          <span>Lendo e interpretando linhas…</span>
          <span>{{ progress }}%</span>
        </div>
        <div class="progress" style="height: 6px">
          <div class="progress-bar progress-bar-striped progress-bar-animated" :style="{ width: progress + '%' }" />
        </div>
      </div>

      <div v-if="errorMsg" class="alert alert-danger" role="alert">
        {{ errorMsg }}
      </div>

      <div v-if="meta && !loading" class="alert alert-secondary py-2 small mb-4" role="status">
        <strong>{{ meta.filename }}</strong>
        — linhas (aprox.): {{ meta.totalLines.toLocaleString('pt-BR') }} · parseadas:
        {{ meta.parsed.toLocaleString('pt-BR') }}
        <span v-if="meta.sampleEvery > 1" class="text-warning ms-1">
          · amostragem 1/{{ meta.sampleEvery }} (arquivo grande)
        </span>
        <span v-if="meta.truncated" class="text-warning ms-1"> · truncado no limite de linhas</span>
        <span v-if="meta.missingFields?.length" class="text-danger ms-1">
          · campos ausentes: {{ meta.missingFields.join(', ') }}
        </span>
      </div>

      <template v-if="stats">
        <div class="row g-3 mb-4">
          <div class="col-6 col-md-3">
            <div class="card bg-body-tertiary border-secondary h-100">
              <div class="card-body py-3">
                <div class="text-secondary small">Requisições (filtro atual)</div>
                <div class="fs-4">{{ stats.count.toLocaleString('pt-BR') }}</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-md-3">
            <div class="card bg-body-tertiary border-secondary h-100">
              <div class="card-body py-3">
                <div class="text-secondary small">Tempo médio</div>
                <div class="fs-4">{{ stats.avgMs }} ms</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-md-3">
            <div class="card bg-body-tertiary border-secondary h-100">
              <div class="card-body py-3">
                <div class="text-secondary small">Pico (max)</div>
                <div class="fs-4">{{ stats.maxMs }} ms</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-md-3">
            <div class="card bg-body-tertiary border-secondary h-100">
              <div class="card-body py-3">
                <div class="text-secondary small">Intervalo</div>
                <div class="small">{{ fmtBucket(stats.minTs) }} → {{ fmtBucket(stats.maxTs) }}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="row g-3 mb-4 align-items-end">
          <div class="col-md-4">
            <label class="form-label small mb-1">Lentidão ≥ (ms) — gráfico por IP e tabela</label>
            <input v-model.number="slowThresholdMs" type="number" min="0" step="50" class="form-control form-control-sm" />
          </div>
          <div class="col-md-5">
            <label class="form-label small mb-1">Filtrar IP cliente (contém)</label>
            <input v-model="ipFilter" type="search" class="form-control form-control-sm" placeholder="ex: 200.195." />
          </div>
          <div class="col-md-3 small text-secondary">
            Janela temporal dos gráficos: ~{{ (bucketMs / 1000).toFixed(0) }}s
          </div>
        </div>

        <div class="row g-4 mb-4">
          <div class="col-lg-8">
            <div class="card bg-body-tertiary border-secondary chart-card h-100">
              <div class="card-header border-secondary">Linha do tempo — média e pico de <code>time-taken</code></div>
              <div class="card-body" style="height: 340px">
                <TimelineChart
                  v-if="timelineSeries"
                  :labels="timelineSeries.labels"
                  :avg-ms="timelineSeries.avgMs"
                  :max-ms="timelineSeries.maxMs"
                />
              </div>
            </div>
          </div>
          <div class="col-lg-4">
            <div class="card bg-body-tertiary border-secondary h-100">
              <div class="card-header border-secondary">HTTP status</div>
              <div class="card-body">
                <ul class="list-unstyled mb-0 small">
                  <li v-for="[code, n] in statusBreakdown" :key="code" class="d-flex justify-content-between py-1 border-bottom border-secondary">
                    <span><code>{{ code }}</code></span>
                    <span>{{ n.toLocaleString('pt-BR') }}</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div class="row g-4 mb-4">
          <div class="col-lg-6">
            <div class="card bg-body-tertiary border-secondary chart-card h-100">
              <div class="card-header border-secondary">Endpoints com maior tempo médio (cs-uri-stem)</div>
              <div class="card-body" style="height: 380px">
                <EndpointAvgChart
                  v-if="endpointChart"
                  :labels="endpointChart.labels"
                  :values="endpointChart.values"
                />
              </div>
            </div>
          </div>
          <div class="col-lg-6">
            <div class="card bg-body-tertiary border-secondary chart-card h-100">
              <div class="card-header border-secondary">
                IPs com mais requisições lentas (≥ {{ slowThresholdMs }} ms), ao longo do tempo
              </div>
              <div class="card-body" style="height: 380px">
                <SlowIpChart
                  v-if="slowIpChart"
                  :labels="slowIpChart.labels"
                  :datasets="slowIpChart.datasets"
                />
                <p v-else class="text-secondary small mb-0">Sem requisições acima do limite no recorte atual.</p>
              </div>
            </div>
          </div>
        </div>

        <div class="card bg-body-tertiary border-secondary">
          <div class="card-header border-secondary">
            Requisições mais lentas (≥ {{ slowThresholdMs }} ms) — até 200 linhas
          </div>
          <div class="card-body p-0">
            <div class="table-responsive" style="max-height: 420px">
              <table class="table table-sm table-hover table-striped mb-0 table-sticky-head">
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>IP</th>
                    <th>Método</th>
                    <th>Stem</th>
                    <th>Status</th>
                    <th class="text-end">ms</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, idx) in slowTable" :key="idx">
                    <td class="text-nowrap small">{{ fmtBucket(r.timestamp) }}</td>
                    <td class="small"><code>{{ r.clientIp }}</code></td>
                    <td class="small">{{ r.method }}</td>
                    <td class="small text-truncate" style="max-width: 280px" :title="r.stem">{{ r.stem }}</td>
                    <td class="small">{{ r.status }}</td>
                    <td class="text-end small">{{ r.timeTaken }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </template>

      <p v-else-if="!loading" class="text-secondary small">
        Dica: o formato segue o cabeçalho <code>#Fields</code> do IIS (ex.: <code>time-taken</code>,
        <code>cs-uri-stem</code>, <code>c-ip</code>). Arquivos muito grandes usam amostragem automática para manter a UI fluida.
      </p>
    </main>
  </div>
</template>
