<script setup>
import { computed } from 'vue'
import { Line } from 'vue-chartjs'

const props = defineProps({
  labels: { type: Array, required: true },
  avgMs: { type: Array, required: true },
  maxMs: { type: Array, required: true },
})

const text = '#dee2e6'
const grid = 'rgba(255,255,255,0.06)'

const chartData = computed(() => ({
  labels: props.labels,
  datasets: [
    {
      label: 'Média (ms)',
      data: props.avgMs,
      borderColor: 'rgb(54, 162, 235)',
      backgroundColor: 'rgba(54, 162, 235, 0.15)',
      fill: true,
      tension: 0.2,
      pointRadius: 0,
    },
    {
      label: 'Máximo (ms)',
      data: props.maxMs,
      borderColor: 'rgb(255, 159, 64)',
      backgroundColor: 'transparent',
      tension: 0.2,
      pointRadius: 0,
    },
  ],
}))

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: {
      labels: { color: text },
    },
    tooltip: {
      callbacks: {
        title(items) {
          const i = items[0]?.dataIndex
          return props.labels[i] ?? ''
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
      title: { display: true, text: 'time-taken (ms)', color: text },
      ticks: { color: text },
      grid: { color: grid },
    },
  },
}))
</script>

<template>
  <Line :data="chartData" :options="chartOptions" />
</template>
