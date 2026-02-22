import dotenv from 'dotenv';
import { dirname, join, extname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env.txt') });

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { extractPdf } from './extract.js';
import { replicateHtmlCss } from './replicate.js';
import { generateImage } from './image-gen.js';

const app = express();
const PORT = process.env.PORT || 3001;
const REPLICATIONS_DIR = join(dirname(__dirname), 'replications');
const PROMPTS_DIR = join(__dirname, 'prompts');
const RUNTIME_DIR = join(__dirname, 'runtime');

const PAGE_SPECS = {
  a4: { wIn: 8.27, hIn: 11.69 },
};

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const instructions = { htmlcss: '', image: '' };

// ── Initialization ──────────────────────────────────────

async function initInstructions() {
  await mkdir(RUNTIME_DIR, { recursive: true });

  const defaultHtmlcss = await readFile(join(PROMPTS_DIR, 'default-htmlcss.txt'), 'utf-8');
  const defaultImage = await readFile(join(PROMPTS_DIR, 'default-image.txt'), 'utf-8');

  instructions.htmlcss = defaultHtmlcss.trim();
  instructions.image = defaultImage.trim();

  await writeFile(join(RUNTIME_DIR, 'current-htmlcss.txt'), instructions.htmlcss);
  await writeFile(join(RUNTIME_DIR, 'current-image.txt'), instructions.image);
  console.log('Instructions initialized from defaults');
}

// ── Templates ───────────────────────────────────────────

function templateHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="page">
    <p>Start building your replica here.</p>
  </div>
</body>
</html>`;
}

function templateCss() {
  return `* { margin: 0; padding: 0; box-sizing: border-box; }

html, body {
  width: 100%;
  height: 100%;
}

#page {
  width: 100%;
  height: 100%;
  padding: 40px;
  font-family: sans-serif;
}`;
}

// ── Helpers ──────────────────────────────────────────────

async function nextVersion(baseName) {
  let entries = [];
  try {
    entries = await readdir(REPLICATIONS_DIR);
  } catch {
    /* directory created below */
  }
  const prefix = `${baseName}-Ver`;
  let max = 0;
  for (const e of entries) {
    if (e.startsWith(prefix)) {
      const n = parseInt(e.slice(prefix.length), 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

async function nextExportVersion(projectDir) {
  const entries = await readdir(projectDir);
  let max = 0;
  for (const e of entries) {
    const m = e.match(/^export-Ver(\d+)\.pdf$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

async function exportProjectPdf(projectId, pageSpec, dpi, mode = 'htmlcss') {
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    throw new Error(
      'Playwright not installed. Run: npm install playwright && npx playwright install chromium',
    );
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const width = Math.round(pageSpec.wIn * dpi);
    const height = Math.round(pageSpec.hIn * dpi);

    await page.setViewportSize({ width, height });

    const modeParam = mode === 'image' ? '&mode=image' : '';
    await page.goto(
      `http://localhost:${PORT}/projects/${projectId}/preview?t=${Date.now()}${modeParam}`,
      { waitUntil: 'networkidle' },
    );

    const projectDir = join(REPLICATIONS_DIR, projectId);
    const ver = await nextExportVersion(projectDir);
    const filename = `export-Ver${ver}.pdf`;

    await page.pdf({
      path: join(projectDir, filename),
      width: `${pageSpec.wIn}in`,
      height: `${pageSpec.hIn}in`,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    return { filename };
  } finally {
    await browser.close();
  }
}

async function latestGeneratedImage(assetsDir) {
  let entries = [];
  try {
    entries = await readdir(assetsDir);
  } catch {
    return null;
  }
  let latest = null;
  let maxVer = -1;
  for (const e of entries) {
    if (e === 'generated-page.png' && maxVer < 0) {
      maxVer = 0;
      latest = e;
    }
    const m = e.match(/^generated-page-Ver(\d+)\.png$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxVer) {
        maxVer = n;
        latest = e;
      }
    }
  }
  return latest;
}

// ── Static / Preview ────────────────────────────────────

app.get('/projects/:id/preview', async (req, res) => {
  try {
    const projectDir = join(REPLICATIONS_DIR, req.params.id);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');

    if (req.query.mode === 'image') {
      const meta = JSON.parse(
        await readFile(join(projectDir, 'project.json'), 'utf-8'),
      );
      const spec = PAGE_SPECS[meta.pageSize || 'a4'];
      const dpi = Number(req.query.dpi) || meta.dpi || 300;
      const w = Math.round(spec.wIn * dpi);
      const h = Math.round(spec.hIn * dpi);

      const imgFile = await latestGeneratedImage(join(projectDir, 'assets'));

      if (!imgFile) {
        res.send(
          `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0}html,body{width:100%;height:100%}</style></head><body><div id="page" style="width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;font-family:sans-serif;color:#999"><p>No generated image yet. Submit to generate.</p></div></body></html>`,
        );
      } else {
        res.send(
          `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0}html,body{width:100%;height:100%}</style></head><body><div id="page" style="width:${w}px;height:${h}px;position:relative"><img src="assets/${imgFile}" style="width:100%;height:100%;display:block"></div></body></html>`,
        );
      }
    } else {
      const htmlPath = join(projectDir, 'index.html');
      res.sendFile(htmlPath);
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Preview error');
  }
});

app.use(
  '/projects',
  express.static(REPLICATIONS_DIR, {
    etag: false,
    lastModified: false,
    setHeaders: (r) => r.set('Cache-Control', 'no-store'),
  }),
);

// ── Internal: PDF rasterization page (used by Playwright) ─

app.get('/api/internal/render-pdf/:id', (req, res) => {
  const projectId = req.params.id;
  const dpi = Number(req.query.dpi) || 300;
  const spec = PAGE_SPECS[req.query.pageSize || 'a4'];
  const width = Math.round(spec.wIn * dpi);
  const height = Math.round(spec.hIn * dpi);

  res.set('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;overflow:hidden;background:#fff">
<canvas id="c" style="display:block"></canvas>
<script type="module">
const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const WORKER_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const pdfjsLib = await import(PDFJS_CDN);
pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_CDN;
const r = await fetch('/projects/${projectId}/assets/reference-original.pdf');
const buf = await r.arrayBuffer();
const pdf = await pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise;
const pg = await pdf.getPage(1);
const dv = pg.getViewport({scale:1});
const scale = Math.min(${width}/dv.width, ${height}/dv.height);
const vp = pg.getViewport({scale});
const c = document.getElementById('c');
c.width = Math.round(vp.width);
c.height = Math.round(vp.height);
await pg.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;
window.__pdfRendered = true;
</script>
</body>
</html>`);
});

// ── API Routes ──────────────────────────────────────────

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// -- Projects -------------------------------------------------

app.post('/api/projects', async (req, res) => {
  try {
    const { filename, pageSize = 'a4', dpi = 300 } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const baseName = basename(filename, extname(filename));
    const ext = extname(filename).toLowerCase();
    const ver = await nextVersion(baseName);
    const projectId = `${baseName}-Ver${ver}`;
    const projectDir = join(REPLICATIONS_DIR, projectId);

    await mkdir(join(projectDir, 'assets'), { recursive: true });
    await writeFile(join(projectDir, 'index.html'), templateHtml());
    await writeFile(join(projectDir, 'styles.css'), templateCss());

    const meta = {
      pageSize,
      dpi: Number(dpi),
      referenceFilename: filename,
      referenceType: ext === '.pdf' ? 'pdf' : 'png',
      createdAt: new Date().toISOString(),
      activeProjectId: projectId,
      extracted: false,
    };
    await writeFile(
      join(projectDir, 'project.json'),
      JSON.stringify(meta, null, 2),
    );

    res.json({
      projectId,
      paths: {
        html: `${projectId}/index.html`,
        css: `${projectId}/styles.css`,
        assets: `${projectId}/assets`,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post(
  '/api/projects/:id/upload-reference',
  upload.single('file'),
  async (req, res) => {
    try {
      const projectId = req.params.id;
      const projectDir = join(REPLICATIONS_DIR, projectId);
      const ext = extname(req.file.originalname).toLowerCase();
      const dest = join(projectDir, 'assets', `reference-original${ext}`);
      await writeFile(dest, req.file.buffer);

      // Auto-extract if PDF and LlamaParse key is set
      if (ext === '.pdf' && process.env.LLAMA_CLOUD_API_KEY) {
        setImmediate(async () => {
          try {
            const meta = JSON.parse(
              await readFile(join(projectDir, 'project.json'), 'utf-8'),
            );
            const spec = PAGE_SPECS[meta.pageSize || 'a4'];
            const result = await extractPdf(
              projectDir,
              projectId,
              spec,
              meta.dpi || 300,
            );
            if (result.ok) {
              meta.extracted = true;
              meta.extractedAt = new Date().toISOString();
              await writeFile(
                join(projectDir, 'project.json'),
                JSON.stringify(meta, null, 2),
              );
              console.log(`Auto-extraction complete for ${projectId}`);
            } else if (result.warning) {
              console.log(`Auto-extraction skipped: ${result.warning}`);
            }
          } catch (err) {
            console.error(`Auto-extraction failed for ${projectId}:`, err.message);
          }
        });
      }

      res.json({ path: `${projectId}/assets/reference-original${ext}` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  },
);

// -- Extract --------------------------------------------------

app.post('/api/projects/:id/extract', async (req, res) => {
  try {
    const projectId = req.params.id;
    const projectDir = join(REPLICATIONS_DIR, projectId);

    const meta = JSON.parse(
      await readFile(join(projectDir, 'project.json'), 'utf-8'),
    );

    if (meta.referenceType !== 'pdf') {
      return res.status(400).json({ error: 'Extraction requires a PDF reference' });
    }

    const spec = PAGE_SPECS[meta.pageSize || 'a4'];
    const result = await extractPdf(projectDir, projectId, spec, meta.dpi || 300);

    if (result.ok) {
      meta.extracted = true;
      meta.extractedAt = new Date().toISOString();
      await writeFile(
        join(projectDir, 'project.json'),
        JSON.stringify(meta, null, 2),
      );
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -- Files ----------------------------------------------------

app.get('/api/projects/:id/files', async (req, res) => {
  try {
    const projectDir = join(REPLICATIONS_DIR, req.params.id);
    const [html, css] = await Promise.all([
      readFile(join(projectDir, 'index.html'), 'utf-8'),
      readFile(join(projectDir, 'styles.css'), 'utf-8'),
    ]);
    res.json({ html, css });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/projects/:id/files', async (req, res) => {
  try {
    const { html, css } = req.body;
    const projectDir = join(REPLICATIONS_DIR, req.params.id);
    const writes = [];
    if (html !== undefined)
      writes.push(writeFile(join(projectDir, 'index.html'), html));
    if (css !== undefined)
      writes.push(writeFile(join(projectDir, 'styles.css'), css));
    await Promise.all(writes);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -- Instructions ---------------------------------------------

app.get('/api/instructions', (req, res) => {
  const jt = req.query.jobType;
  if (!jt || !(jt in instructions)) {
    return res.status(400).json({ error: 'Invalid jobType' });
  }
  res.json({ jobType: jt, text: instructions[jt], limit: 2400 });
});

app.post('/api/instructions', async (req, res) => {
  try {
    const { jobType, text } = req.body;
    if (!jobType || !(jobType in instructions)) {
      return res.status(400).json({ error: 'Invalid jobType' });
    }
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Instructions cannot be empty' });
    }
    if (text.length > 2400) {
      return res
        .status(400)
        .json({ error: 'Instructions exceed 2400 character limit' });
    }

    instructions[jobType] = text;
    const fname =
      jobType === 'htmlcss' ? 'current-htmlcss.txt' : 'current-image.txt';
    await writeFile(join(RUNTIME_DIR, fname), text);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -- Submit ---------------------------------------------------

app.post('/api/projects/:id/submit', async (req, res) => {
  try {
    const { jobType, fidelity = 'high', dpi = 300, pageSize = 'a4' } = req.body;
    const projectId = req.params.id;
    const projectDir = join(REPLICATIONS_DIR, projectId);

    const instruction = instructions[jobType];
    if (!instruction || !instruction.trim()) {
      return res
        .status(400)
        .json({ error: 'No saved instruction for this job type' });
    }

    const spec = PAGE_SPECS[pageSize];
    if (!spec) return res.status(400).json({ error: 'Invalid pageSize' });

    await writeFile(join(projectDir, 'instruction.used.txt'), instruction);

    if (jobType === 'htmlcss') {
      const repResult = await replicateHtmlCss(projectDir, instruction);
      if (!repResult.ok) return res.json(repResult);

      const expResult = await exportProjectPdf(projectId, spec, Number(dpi));
      res.json({ ok: true, exportFile: expResult.filename });
    } else if (jobType === 'image') {
      const imgResult = await generateImage(
        projectDir,
        projectId,
        instruction,
        fidelity,
        spec,
        Number(dpi),
      );
      if (!imgResult.ok) return res.json(imgResult);

      const expResult = await exportProjectPdf(
        projectId,
        spec,
        Number(dpi),
        'image',
      );
      res.json({
        ok: true,
        generatedFile: imgResult.generatedFile,
        exportFile: expResult.filename,
      });
    } else {
      res.status(400).json({ error: 'Invalid jobType' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ───────────────────────────────────────────────

await initInstructions();

app.listen(PORT, () => {
  console.log(`RepliDoc server listening on http://localhost:${PORT}`);
});
