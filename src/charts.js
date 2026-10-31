'use strict';

const { CHART_HEIGHT, CHART_PLOT_HEIGHT, HEATMAP_ROW_HEIGHT, WEEKDAYS } = require('./config');
const { formatCount, formatDate, plural } = require('./format');

function chartMax(highest) {
  if (highest <= 2) return 2;
  const magnitude = 10 ** Math.floor(Math.log10(highest));
  return [2, 4, 6, 10].map((step) => step * magnitude).find((top) => top >= highest);
}

function clicksChartHtml(days) {
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const labelEvery = Math.max(Math.ceil(days.length / 30) * 7, 7);
  if (total === 0) return '<p class="empty chart-empty">No clicks yet. They will show here once someone opens a short link.</p>';

  const busiest = days.reduce((top, day) => (day.count > top.count ? day : top));
  const top = chartMax(busiest.count);
  const yFor = (count) => CHART_PLOT_HEIGHT - (count / top) * CHART_PLOT_HEIGHT;
  const column = 100 / days.length;
  const ticks = [top, top / 2, 0];

  const yLabels = ticks.map((tick) => `<text x="36" y="${Math.max(yFor(tick) + 4, 11)}">${formatCount(tick)}</text>`);
  const grid = ticks.map((tick) => {
    const y = Math.min(yFor(tick) + 0.5, CHART_PLOT_HEIGHT - 0.5);
    return `<line x1="0" x2="100%" y1="${y}" y2="${y}"/>`;
  });
  const columns = days.map((day, index) => {
    const height = day.count ? Math.max((day.count / top) * CHART_PLOT_HEIGHT, 3) : 0;
    const bar = height ? `<rect class="chart-bar" x="${(index + 0.15) * column}%" y="${CHART_PLOT_HEIGHT - height}" width="${column * 0.7}%" height="${height + 4}" rx="3"/>` : '';
    return `<g class="chart-column">${bar}<rect class="chart-hit" x="${index * column}%" y="0" width="${column}%" height="${CHART_PLOT_HEIGHT}" data-tip="${formatDate(day.date)}: ${plural(day.count, 'click')}"/></g>`;
  });
  const xLabels = days.flatMap((day, index) => {
    if ((days.length - 1 - index) % labelEvery !== 0) return [];
    const label = (x, anchor) => `<text x="${x}" y="${CHART_HEIGHT - 6}" text-anchor="${anchor}">${formatDate(day.date)}</text>`;
    if (index === days.length - 1) return label('100%', 'end');
    if (index < labelEvery) return label(`${index * column}%`, 'start');
    return label(`${(index + 0.5) * column}%`, 'middle');
  });

  const summary = `Clicks per day for the last ${days.length} days: ${plural(total, 'click')} in total. Busiest day was ${formatDate(busiest.date)} with ${plural(busiest.count, 'click')}.`;
  return `<div class="chart">
        <svg class="chart-y" width="40" height="${CHART_HEIGHT}" aria-hidden="true">${yLabels.join('')}</svg>
        <svg class="chart-plot" width="100%" height="${CHART_HEIGHT}" role="img" aria-label="${summary}">
          <g class="chart-grid">${grid.join('')}</g>
          <svg width="100%" height="${CHART_PLOT_HEIGHT}">${columns.join('')}</svg>
          <g class="chart-x">${xLabels.join('')}</g>
        </svg>
      </div>`;
}

function weekChangeNote(week, previousWeek) {
  const change = week - previousWeek;
  if (change === 0) return 'Same as previous 7 days';
  return `${change > 0 ? '+' : '−'}${formatCount(Math.abs(change))} vs previous 7 days`;
}

function hourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function busiestSlot(grid) {
  let best = { count: 0, weekday: 0, hour: 0 };
  grid.forEach((row, weekday) => row.forEach((count, hour) => {
    if (count > best.count) best = { count, weekday, hour };
  }));
  return best;
}

function heatmapHtml(grid) {
  const best = busiestSlot(grid);
  if (best.count === 0) return '<p class="empty chart-empty">Nothing yet. This shows which days and hours get the most clicks.</p>';
  const column = 100 / 24;
  const plotHeight = HEATMAP_ROW_HEIGHT * 7;
  const totalHeight = plotHeight + 24;
  const cells = [];
  grid.forEach((row, weekday) => row.forEach((count, hour) => {
    const y = weekday * HEATMAP_ROW_HEIGHT;
    const tip = `${WEEKDAYS[weekday]} ${hourLabel(hour)}: ${plural(count, 'click')}`;
    const opacity = count ? (0.2 + 0.8 * (count / best.count)).toFixed(2) : '1';
    cells.push(`<rect class="${count ? 'heat-cell' : 'heat-empty'}" x="${hour * column}%" y="${y}" width="${column * 0.92}%" height="${HEATMAP_ROW_HEIGHT - 2}" rx="2" fill-opacity="${opacity}" data-tip="${tip}"/>`);
  }));
  const days = WEEKDAYS.map((day, index) => `<text x="36" y="${index * HEATMAP_ROW_HEIGHT + 15}">${day}</text>`);
  const times = [0, 6, 12, 18].map((hour) => `<text x="${hour * column}%" y="${totalHeight - 6}">${hourLabel(hour)}</text>`);
  const summary = `Clicks by day of week and hour. Busiest is ${WEEKDAYS[best.weekday]} at ${hourLabel(best.hour)} with ${plural(best.count, 'click')}.`;
  return `<div class="chart heatmap">
            <svg class="chart-y" width="40" height="${totalHeight}" aria-hidden="true">${days.join('')}</svg>
            <svg class="chart-plot" width="100%" height="${totalHeight}" role="img" aria-label="${summary}">${cells.join('')}<g class="chart-x">${times.join('')}</g></svg>
          </div>`;
}

function statHtml(label, value, note) {
  return `<div class="stat">
              <dt>${label}</dt>
              <dd class="stat-value">${value}</dd>
              <dd class="stat-note">${note}</dd>
            </div>`;
}

function changeNote(current, previous, unit) {
  const change = current - previous;
  if (change === 0) return `Same as previous ${unit}`;
  return `${change > 0 ? '+' : '−'}${formatCount(Math.abs(change))} vs previous ${unit}`;
}

module.exports = {
  busiestSlot,
  changeNote,
  clicksChartHtml,
  heatmapHtml,
  hourLabel,
  statHtml,
  weekChangeNote,
};
