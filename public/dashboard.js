'use strict';

const shortUrl = document.getElementById('short-url');
const copy = document.getElementById('copy');

async function copyShortUrl() {
  shortUrl.select();
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(shortUrl.value);
    return true;
  }
  return document.execCommand('copy');
}

if (copy) {
  let resetTimer;

  copy.addEventListener('click', async () => {
    let copied = false;
    try {
      copied = await copyShortUrl();
    } catch {
    }
    copy.textContent = copied ? 'Copied' : 'Press Ctrl+C';
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  });

  copy.hidden = false;
}

const createForm = document.querySelector('.create');
const fileInput = document.getElementById('file');
const fileTooBig = document.getElementById('file-too-big');
const createSubmit = document.getElementById('create-submit');
let creating = false;

function fileIsTooBig() {
  const [file] = fileInput.files;
  return Boolean(file) && file.size > Number(createForm.dataset.maxBytes);
}

if (createForm) {
  fileInput.addEventListener('change', () => { fileTooBig.hidden = !fileIsTooBig(); });

  createForm.addEventListener('submit', (event) => {
    const kind = createForm.elements.kind.value;
    if (creating || (kind === 'file' && fileIsTooBig())) {
      event.preventDefault();
      return;
    }
    creating = true;
    createSubmit.setAttribute('aria-disabled', 'true');
    createSubmit.textContent = kind === 'file' ? 'Uploading' : 'Creating';
  });
}
