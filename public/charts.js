'use strict';

document.querySelectorAll('.chart').forEach((chart) => {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  chart.append(tip);

  const showTip = (event) => {
    const hit = event.target.closest('[data-tip]');
    tip.hidden = !hit;
    if (!hit) return;
    tip.textContent = hit.dataset.tip;
    const area = chart.getBoundingClientRect();
    const bar = hit.getBoundingClientRect();
    const centre = bar.left + bar.width / 2 - area.left;
    const left = Math.min(Math.max(centre - tip.offsetWidth / 2, 0), area.width - tip.offsetWidth);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(event.clientY - area.top - tip.offsetHeight - 10, 0)}px`;
  };

  chart.addEventListener('pointermove', showTip);
  chart.addEventListener('pointerdown', showTip);
  chart.addEventListener('pointerleave', () => { tip.hidden = true; });
});

document.querySelectorAll('[data-auto-submit]').forEach((select) => {
  select.addEventListener('change', () => select.form.requestSubmit());
});
