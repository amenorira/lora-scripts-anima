/* Shared pointer and keyboard inspection for charts rebuilt with x-html. */
document.addEventListener('alpine:init', () => {
  Alpine.data('previewChart', sample => {
    const charts = new WeakMap();
    let content, data, steps;
    let progress = 0;
    let frame = null;
    let queuedMarkup, clientX, clientY;

    const chartNodes = () => {
      const markup = content.firstElementChild;
      if (!markup) return null;
      if (charts.has(markup)) return charts.get(markup);
      const plot = content.querySelector('[data-chart-plot]');
      const nodes = plot && {
        plot,
        line: plot.querySelector('[data-chart-indicator]'),
        values: content.querySelectorAll('[data-chart-value]'),
        readout: content.querySelector('[data-chart-readout]'),
      };
      charts.set(markup, nodes);
      return nodes;
    };

    const hide = chart => {
      if (!chart || chart.line.style.display === 'none') return;
      chart.line.style.display = 'none';
      chart.readout?.classList.remove('is-visible');
    };

    const cancelFrame = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      queuedMarkup = null;
    };

    const inspect = (chart, position) => {
      progress = steps ? Math.round(position * steps) / steps : position;
      const values = sample(data, progress);
      if (!values) return;

      const left = `${Number((progress * 100).toFixed(2))}%`;
      if (chart.line.style.left !== left) chart.line.style.left = left;
      if (chart.line.style.display === 'none') {
        chart.line.style.display = 'block';
        chart.readout?.classList.add('is-visible');
      }
      chart.values.forEach((node, index) => {
        if (node.textContent !== values[index]) node.textContent = values[index];
      });
    };

    const paint = () => {
      frame = null;
      const current = queuedMarkup;
      queuedMarkup = null;
      // x-html also replaces the nodes when only the locale changes.
      if (current !== content.firstElementChild) return;
      const chart = chartNodes();
      if (!chart) return;
      const { width, left, right, top, bottom } = chart.plot.getBoundingClientRect();
      if (!width || clientX < left || clientX > right || clientY < top || clientY > bottom) {
        hide(chart);
        return;
      }
      inspect(chart, Math.max(0, Math.min(1, (clientX - left) / width)));
    };

    return {
      init() { content = this.$el.firstElementChild; },
      destroy() { cancelFrame(); },
      setChartData(value, totalSteps) {
        this.leaveChart();
        data = value;
        steps = totalSteps > 0 ? totalSteps : 0;
      },
      moveChart(event) {
        if (!data) return;
        clientX = event.clientX;
        clientY = event.clientY;
        queuedMarkup = content.firstElementChild;
        if (frame === null) frame = requestAnimationFrame(paint);
      },
      leaveChart() {
        cancelFrame();
        hide(charts.get(content.firstElementChild));
      },
      keyChart(event) {
        const { key } = event;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
        event.preventDefault();
        cancelFrame();
        const chart = data && chartNodes();
        if (!chart) return;
        const increment = steps ? Math.max(1, Math.round(steps * .01)) / steps : .01;
        const next = key === 'Home' ? 0 : key === 'End' ? 1
          : Math.max(0, Math.min(1, progress + (key === 'ArrowRight' ? increment : -increment)));
        inspect(chart, next);
      },
    };
  });
});
