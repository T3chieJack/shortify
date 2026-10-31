'use strict';

const selectAll = document.getElementById('select-all');
const rowChecks = [...document.querySelectorAll('.row-check')];
const selectedCount = document.getElementById('selected-count');
const bulkCopy = document.getElementById('bulk-copy');
const bulkDelete = document.getElementById('bulk-delete');
const bulkEdit = document.getElementById('bulk-edit');
const resultCount = selectedCount ? selectedCount.textContent : '';

async function copyToClipboard(text) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const area = document.createElement('textarea');
  area.value = text;
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  return copied;
}

async function copyWithFeedback(button, text) {
  const label = button.dataset.label || button.textContent;
  button.dataset.label = label;
  let copied = false;
  try {
    copied = await copyToClipboard(text);
  } catch {
  }
  button.textContent = copied ? 'Copied' : 'Could not copy';
  clearTimeout(button.resetTimer);
  button.resetTimer = setTimeout(() => { button.textContent = label; }, 2000);
}

function updateSelection() {
  const checked = rowChecks.filter((check) => check.checked);
  const count = checked.length;
  selectedCount.textContent = count ? `${count} selected` : resultCount;
  bulkDelete.disabled = count === 0;
  bulkEdit.disabled = count === 0;
  bulkCopy.disabled = count === 0;
  if (selectAll) {
    selectAll.checked = count > 0 && count === rowChecks.length;
    selectAll.indeterminate = count > 0 && count < rowChecks.length;
  }
}

if (selectedCount) {
  rowChecks.forEach((check) => check.addEventListener('change', updateSelection));

  if (selectAll) {
    selectAll.hidden = false;
    selectAll.addEventListener('change', () => {
      rowChecks.forEach((check) => { check.checked = selectAll.checked; });
      updateSelection();
    });
  }

  bulkCopy.hidden = false;
  bulkCopy.addEventListener('click', () => {
    const urls = rowChecks.filter((check) => check.checked).map((check) => check.dataset.url);
    copyWithFeedback(bulkCopy, urls.join('\n'));
  });

  document.querySelectorAll('.row-copy').forEach((button) => {
    button.hidden = false;
    button.addEventListener('click', () => copyWithFeedback(button, button.dataset.url));
  });

  updateSelection();
}

document.querySelectorAll('[data-auto-submit]').forEach((select) => {
  select.addEventListener('change', () => select.form.requestSubmit());
});
