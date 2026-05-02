<script setup>
import { computed } from 'vue'
import { Line } from 'vue-chartjs'

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

const props = defineProps({
  labels: { type: Array, required: true },
  datasets: { type: Array, required: true },
})

const text = '#dee2e6'
const grid = 'rgba(255,255,255,0.06)'

const chartData = computed(() => ({
  labels: props.labels,
  datasets: props.datasets.map((d, i) => ({
    label: d.ip,
    data: d.data,
    borderColor: PALETTE[i % PALETTE.length],
    backgroundColor: 'transparent',
    tension: 0.25,
    pointRadius: 0,
  })),
}))

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: {
      labels: { color: text, boxWidth: 12 },
    },
    tooltip: {
      callbacks: {
        title(items) {
          const i = items[0]?.dataIndex
          return props.labels[i] ?? ''
        },
        label(ctx) {
          return `${ctx.dataset.label}: ${ctx.raw} req. lentas`
        },
      },
    },
  },
  scales: {
    x: {
      ticks: { color: text, maxRotation: 45, autoSkip: true, maxTicksLimit: 14 },
      grid: { color: grid },
    },
    y: {
      title: { display: true, text: 'Requisições lentas (contagem)', color: text },
      ticks: { color: text, precision: 0 },
      grid: { color: grid },
    },
  },
}))
</script>

<template>
  <Line :data="chartData" :options="chartOptions" />
</template>
