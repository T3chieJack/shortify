'use strict';

const sharedText = document.getElementById('shared-text');
const copyText = document.getElementById('copy-text');
let resetTimer;

async function copySharedText() {
  window.getSelection().selectAllChildren(sharedText);
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(sharedText.textContent);
    return true;
  }
  return document.execCommand('copy');
}

copyText.addEventListener('click', async () => {
  let copied = false;
  try {
    copied = await copySharedText();
  } catch {
  }
  copyText.textContent = copied ? 'Copied' : 'Press Ctrl+C';
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => { copyText.textContent = 'Copy'; }, 2000);
});

copyText.hidden = false;
