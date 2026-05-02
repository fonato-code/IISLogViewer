<script setup>
import { computed } from 'vue'
import { Bar } from 'vue-chartjs'

const props = defineProps({
  labels: { type: Array, required: true },
  values: { type: Array, required: true },
})

const text = '#dee2e6'
const grid = 'rgba(255,255,255,0.06)'

const chartData = computed(() => ({
  labels: props.labels,
  datasets: [
    {
      label: 'Média ms',
      data: props.values,
      backgroundColor: 'rgba(153, 102, 255, 0.55)',
      borderColor: 'rgb(153, 102, 255)',
      borderWidth: 1,
    },
  ],
}))

const chartOptions = computed(() => ({
  indexAxis: 'y',
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        label(ctx) {
          return `Tempo médio: ${ctx.raw} ms`
        },
      },
    },
  },
  scales: {
    x: {
      title: { display: true, text: 'Média time-taken (ms)', color: text },
      ticks: { color: text },
      grid: { color: grid },
    },
    y: {
      ticks: { color: text, font: { size: 10 } },
      grid: { display: false },
    },
  },
}))
</script>

<template>
  <Bar :data="chartData" :options="chartOptions" />
</template>
