import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const refCanvas = document.getElementById('ref-canvas');
const refImage = document.getElementById('ref-image');
const dragOverlay = document.getElementById('drag-overlay');
const paneLeft = document.getElementById('pane-left');
const pageLeft = document.getElementById('page-left');

let currentFile = null;
let getDims = null;
let onProjectCreated = null;

export function initUpload(getPageDimensions, projectCallback) {
  getDims = getPageDimensions;
  onProjectCreated = projectCallback;

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });

  let dragCounter = 0;

  paneLeft.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dragOverlay.classList.add('active');
  });

  paneLeft.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dragOverlay.classList.remove('active');
    }
  });

  paneLeft.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  paneLeft.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.classList.remove('active');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
}

async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'pdf' || file.type === 'application/pdf') {
    const buf = await file.arrayBuffer();
    currentFile = { type: 'pdf', data: buf };
    await renderPdf(buf);
  } else if (ext === 'png' || file.type === 'image/png') {
    const url = URL.createObjectURL(file);
    currentFile = { type: 'png', data: url };
    renderImage(url);
  } else {
    console.warn('Unsupported file type:', ext);
    return;
  }

  await createProjectAndUpload(file);
}

async function createProjectAndUpload(file) {
  try {
    const { dpi, pageSize } = getDims();
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, pageSize, dpi }),
    });
    const { projectId } = await res.json();

    const form = new FormData();
    form.append('file', file);
    await fetch(`/api/projects/${projectId}/upload-reference`, {
      method: 'POST',
      body: form,
    });

    if (onProjectCreated) onProjectCreated(projectId);
  } catch (err) {
    console.error('Failed to create project:', err);
  }
}

async function renderPdf(buffer) {
  const { dpi } = getDims();
  const scale = dpi / 72;

  hideAll();

  const pdf = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale });

  refCanvas.width = Math.round(viewport.width);
  refCanvas.height = Math.round(viewport.height);

  pageLeft.style.width = `${refCanvas.width}px`;
  pageLeft.style.height = `${refCanvas.height}px`;

  refCanvas.classList.add('visible');

  const ctx = refCanvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  dropZone.classList.add('hidden');
}

function renderImage(objectUrl) {
  hideAll();

  const { width, height } = getDims();
  pageLeft.style.width = `${width}px`;
  pageLeft.style.height = `${height}px`;

  refImage.src = objectUrl;
  refImage.classList.add('visible');
  dropZone.classList.add('hidden');
}

function hideAll() {
  refCanvas.classList.remove('visible');
  refImage.classList.remove('visible');
  refCanvas.width = 0;
  refCanvas.height = 0;
}

export async function rerenderCurrent(getPageDimensions) {
  getDims = getPageDimensions;
  if (!currentFile) return;

  if (currentFile.type === 'pdf') {
    await renderPdf(currentFile.data);
  } else if (currentFile.type === 'png') {
    const { width, height } = getDims();
    pageLeft.style.width = `${width}px`;
    pageLeft.style.height = `${height}px`;
  }
}
