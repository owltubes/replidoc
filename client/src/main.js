import './style.css';
import { initUpload, rerenderCurrent } from './upload.js';

const PAGE_SPECS = { a4: { wIn: 8.27, hIn: 11.69 } };
const PANE_PAD = 24;

// ── DOM ─────────────────────────────────────────────────

const dpiSelect = document.getElementById('dpi');
const pageSizeSelect = document.getElementById('page-size');
const pageLeft = document.getElementById('page-left');
const pageRight = document.getElementById('page-right');
const scrollLeft = document.getElementById('scroll-left');
const scrollRight = document.getElementById('scroll-right');

const iframe = document.getElementById('preview-iframe');
const rightActions = document.getElementById('right-actions');
const btnEdit = document.getElementById('btn-edit');
const btnSave = document.getElementById('btn-save');
const editorPanel = document.getElementById('editor-panel');
const editorHtml = document.getElementById('editor-html');
const editorCss = document.getElementById('editor-css');
const editorTabs = document.querySelectorAll('.editor-tab');

const jobTypeSelect = document.getElementById('job-type');
const fidelityGroup = document.getElementById('fidelity-group');
const fidelityBtns = document.querySelectorAll('.fidelity-btn');

const btnInstructions = document.getElementById('btn-instructions');
const instructionsPanel = document.getElementById('instructions-panel');
const instructionTextarea = document.getElementById('instruction-textarea');
const instructionSave = document.getElementById('instruction-save');
const instructionStatus = document.getElementById('instruction-status');

const btnSubmit = document.getElementById('btn-submit');
const submitStatus = document.getElementById('submit-status');

// ── State ───────────────────────────────────────────────

let currentProjectId = null;
let currentJobType = 'htmlcss';
let currentFidelity = 'high';
let savedInstructions = { htmlcss: '', image: '' };
let hasReference = false;

// ── Page geometry ───────────────────────────────────────

function getPageSpec() {
  return PAGE_SPECS[pageSizeSelect.value];
}

function getPageDimensions() {
  const spec = getPageSpec();
  const dpi = Number(dpiSelect.value);
  return {
    width: Math.round(spec.wIn * dpi),
    height: Math.round(spec.hIn * dpi),
    dpi,
    pageSize: pageSizeSelect.value,
  };
}

function fitPageToPane(pageEl, scrollEl) {
  const aspect = getPageSpec().wIn / getPageSpec().hIn;
  const availW = scrollEl.clientWidth - PANE_PAD * 2;
  const availH = scrollEl.clientHeight - PANE_PAD * 2;
  let w, h;
  if (availW / availH > aspect) {
    h = availH;
    w = h * aspect;
  } else {
    w = availW;
    h = w / aspect;
  }
  pageEl.style.width = `${Math.round(w)}px`;
  pageEl.style.height = `${Math.round(h)}px`;
}

function applyPageDimensions() {
  const { width, height } = getPageDimensions();

  if (hasReference) {
    pageLeft.style.width = `${width}px`;
    pageLeft.style.height = `${height}px`;
  } else {
    fitPageToPane(pageLeft, scrollLeft);
  }

  if (currentProjectId) {
    pageRight.style.width = `${width}px`;
    pageRight.style.height = `${height}px`;
    iframe.style.width = `${width}px`;
    iframe.style.height = `${height}px`;
  } else {
    fitPageToPane(pageRight, scrollRight);
  }
}

applyPageDimensions();

const ro = new ResizeObserver(() => applyPageDimensions());
ro.observe(scrollLeft);
ro.observe(scrollRight);

// ── Preview URL helper ──────────────────────────────────

function getPreviewUrl() {
  if (!currentProjectId) return '';
  const params = new URLSearchParams({ v: Date.now() });
  if (currentJobType === 'image') {
    params.set('mode', 'image');
    params.set('dpi', dpiSelect.value);
  }
  return `/projects/${currentProjectId}/preview?${params}`;
}

// ── DPI / Page Size ─────────────────────────────────────

dpiSelect.addEventListener('change', () => {
  applyPageDimensions();
  rerenderCurrent(getPageDimensions);
  if (currentProjectId) refreshPreview();
});

pageSizeSelect.addEventListener('change', () => {
  applyPageDimensions();
  rerenderCurrent(getPageDimensions);
  if (currentProjectId) refreshPreview();
});

// ── Job Type ────────────────────────────────────────────

jobTypeSelect.addEventListener('change', () => {
  currentJobType = jobTypeSelect.value;

  fidelityGroup.style.display = currentJobType === 'image' ? 'flex' : 'none';

  btnEdit.style.display = currentJobType === 'htmlcss' ? '' : 'none';
  btnSave.style.display = currentJobType === 'htmlcss' ? '' : 'none';
  if (currentJobType !== 'htmlcss') {
    editorPanel.classList.remove('open');
  }

  if (instructionsPanel.classList.contains('open')) {
    instructionTextarea.value = savedInstructions[currentJobType];
    checkUnsaved();
  }

  if (currentProjectId) refreshPreview();
});

// ── Fidelity ────────────────────────────────────────────

fidelityBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    fidelityBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFidelity = btn.dataset.fidelity;
  });
});

// ── Instructions Panel ──────────────────────────────────

btnInstructions.addEventListener('click', () => {
  const isOpen = instructionsPanel.classList.contains('open');
  if (isOpen) {
    instructionsPanel.classList.remove('open');
  } else {
    instructionTextarea.value = savedInstructions[currentJobType];
    instructionsPanel.classList.add('open');
    instructionTextarea.focus();
    checkUnsaved();
  }
});

instructionTextarea.addEventListener('input', checkUnsaved);

function checkUnsaved() {
  const draft = instructionTextarea.value;
  const saved = savedInstructions[currentJobType];
  const dirty = draft !== saved;
  instructionStatus.textContent = dirty ? 'Unsaved Changes' : '';
  instructionStatus.className = dirty
    ? 'instruction-status unsaved'
    : 'instruction-status';
}

instructionSave.addEventListener('click', async () => {
  const text = instructionTextarea.value.trim();
  if (!text) {
    instructionStatus.textContent = 'Cannot be empty';
    instructionStatus.className = 'instruction-status error';
    return;
  }

  try {
    const res = await fetch('/api/instructions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobType: currentJobType,
        text: instructionTextarea.value,
      }),
    });
    if (!res.ok) {
      const d = await res.json();
      instructionStatus.textContent = d.error || 'Save failed';
      instructionStatus.className = 'instruction-status error';
      return;
    }
    savedInstructions[currentJobType] = instructionTextarea.value;
    instructionsPanel.classList.remove('open');
    updateInstructionsBtn();
  } catch {
    instructionStatus.textContent = 'Save failed';
    instructionStatus.className = 'instruction-status error';
  }
});

function updateInstructionsBtn() {
  const hasSaved = savedInstructions[currentJobType]?.trim();
  btnInstructions.classList.toggle('has-saved', !!hasSaved);
}

// ── Editor ──────────────────────────────────────────────

editorTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    editorTabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    editorHtml.classList.toggle('active', which === 'html');
    editorCss.classList.toggle('active', which === 'css');
  });
});

editorHtml.classList.add('active');

btnEdit.addEventListener('click', () => {
  editorPanel.classList.toggle('open');
  applyPageDimensions();
});

btnSave.addEventListener('click', async () => {
  if (!currentProjectId) return;

  await fetch(`/api/projects/${currentProjectId}/files`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: editorHtml.value, css: editorCss.value }),
  });

  refreshPreview();
});

// ── Preview ─────────────────────────────────────────────

function loadPreview(projectId) {
  iframe.src = getPreviewUrl();
  iframe.classList.add('visible');
  applyPageDimensions();
}

function refreshPreview() {
  if (!currentProjectId) return;
  iframe.src = getPreviewUrl();
}

async function loadEditorFiles(projectId) {
  const res = await fetch(`/api/projects/${projectId}/files`);
  const { html, css } = await res.json();
  editorHtml.value = html;
  editorCss.value = css;
}

// ── Submit ──────────────────────────────────────────────

let statusTimer = 0;

function showStatus(msg, type) {
  submitStatus.textContent = msg;
  submitStatus.className = `submit-status ${type}`;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    submitStatus.textContent = '';
    submitStatus.className = 'submit-status';
  }, 5000);
}

btnSubmit.addEventListener('click', async () => {
  if (!currentProjectId || !hasReference) {
    showStatus('Upload a reference file first', 'error');
    return;
  }

  const saved = savedInstructions[currentJobType];
  if (!saved || !saved.trim()) {
    showStatus('Save instructions before submitting', 'error');
    return;
  }

  if (instructionsPanel.classList.contains('open')) {
    if (instructionTextarea.value !== saved) {
      showStatus('Save instruction changes first', 'error');
      return;
    }
  }

  btnSubmit.disabled = true;
  btnSubmit.textContent = 'Submitting\u2026';

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobType: currentJobType,
        fidelity: currentFidelity,
        dpi: Number(dpiSelect.value),
        pageSize: pageSizeSelect.value,
      }),
    });
    const data = await res.json();

    if (data.error && !data.ok) {
      showStatus(
        typeof data.error === 'object' ? data.error.message : data.error,
        'error',
      );
    } else if (data.ok) {
      const parts = [];
      if (data.generatedFile) parts.push(data.generatedFile);
      if (data.exportFile) parts.push(data.exportFile);
      showStatus(parts.length ? `Done: ${parts.join(', ')}` : 'Submitted', 'success');

      refreshPreview();

      if (currentJobType === 'htmlcss') {
        await loadEditorFiles(currentProjectId);
      }
    } else {
      showStatus(data.warning || data.message || 'Submitted', 'success');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.textContent = 'Submit';
  }
});

// ── Project lifecycle ───────────────────────────────────

function handleProjectCreated(projectId) {
  currentProjectId = projectId;
  hasReference = true;
  rightActions.classList.add('visible');
  loadPreview(projectId);
  loadEditorFiles(projectId);
  applyPageDimensions();
}

// ── Init ────────────────────────────────────────────────

async function init() {
  for (const jt of ['htmlcss', 'image']) {
    try {
      const res = await fetch(`/api/instructions?jobType=${jt}`);
      const data = await res.json();
      savedInstructions[jt] = data.text;
    } catch {
      /* server may not be ready */
    }
  }
  updateInstructionsBtn();
}

init();
initUpload(getPageDimensions, handleProjectCreated);
