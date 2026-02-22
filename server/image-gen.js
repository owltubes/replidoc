import { readFile, writeFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import OpenAI from 'openai';

const PORT = process.env.PORT || 3001;

export async function generateImage(
  projectDir,
  projectId,
  instruction,
  fidelity,
  pageSpec,
  dpi,
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: { code: 'MISSING_KEY', message: 'OPENAI_API_KEY not set' },
    };
  }

  const width = Math.round(pageSpec.wIn * dpi);
  const height = Math.round(pageSpec.hIn * dpi);

  // Step 1 — Rasterize reference from original
  const rasterPath = join(projectDir, 'assets', 'reference-raster.png');
  await rasterizeReference(projectDir, projectId, width, height, dpi, rasterPath);

  // Step 2 — Optional LlamaParse + summarizer
  let summaryAppendix = '';
  const meta = JSON.parse(
    await readFile(join(projectDir, 'project.json'), 'utf-8'),
  );

  if (meta.referenceType === 'pdf' && process.env.LLAMA_CLOUD_API_KEY) {
    try {
      await access(join(projectDir, 'extraction.json'));
    } catch {
      const { extractPdf } = await import('./extract.js');
      await extractPdf(projectDir, projectId, pageSpec, dpi);
    }

    try {
      const extraction = JSON.parse(
        await readFile(join(projectDir, 'extraction.json'), 'utf-8'),
      );
      const client = new OpenAI({ apiKey });
      const summaryRes = await client.responses.create({
        model: 'gpt-5.2',
        input:
          'Summarize the following document extraction data into a concise layout and text constraints description suitable for image generation:\n\n' +
          JSON.stringify(extraction),
      });
      summaryAppendix =
        '\n\nDocument structure summary:\n' + summaryRes.output_text;
    } catch (err) {
      console.warn('Summarization skipped:', err.message);
    }
  }

  // Step 3 — Image generation via gpt-image-1
  const rasterBuffer = await readFile(rasterPath);
  const base64 = rasterBuffer.toString('base64');

  const client = new OpenAI({ apiKey });
  const promptText = instruction + summaryAppendix;

  const response = await client.images.edit({
    model: 'gpt-image-1',
    images: [{ image_url: `data:image/png;base64,${base64}` }],
    prompt: promptText,
    input_fidelity: fidelity,
    n: 1,
    size: '1024x1536',
    output_format: 'png',
    quality: 'high',
  });

  const b64Out = response.data[0].b64_json;
  const outputBuffer = Buffer.from(b64Out, 'base64');

  // Step 4 — Save with versioning (never overwrite)
  const filename = await nextImageFilename(join(projectDir, 'assets'));
  await writeFile(join(projectDir, 'assets', filename), outputBuffer);

  return { ok: true, generatedFile: filename };
}

// ── Helpers ─────────────────────────────────────────────

async function rasterizeReference(
  projectDir,
  projectId,
  width,
  height,
  dpi,
  outputPath,
) {
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    throw new Error('Playwright required for reference rasterization');
  }

  const meta = JSON.parse(
    await readFile(join(projectDir, 'project.json'), 'utf-8'),
  );

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width, height });

    if (meta.referenceType === 'pdf') {
      await page.goto(
        `http://localhost:${PORT}/api/internal/render-pdf/${projectId}?dpi=${dpi}&pageSize=${meta.pageSize || 'a4'}`,
        { waitUntil: 'networkidle', timeout: 30000 },
      );
      await page.waitForFunction(() => window.__pdfRendered === true, {
        timeout: 30000,
      });
      const canvas = await page.$('#c');
      await canvas.screenshot({ path: outputPath, type: 'png' });
    } else {
      const pngBuf = await readFile(
        join(projectDir, 'assets', 'reference-original.png'),
      );
      const b64 = pngBuf.toString('base64');

      await page.setContent(
        `<!DOCTYPE html><html><body style="margin:0;padding:0;width:${width}px;height:${height}px;background:#fff"><img src="data:image/png;base64,${b64}" style="width:100%;height:100%;object-fit:contain;display:block"></body></html>`,
      );
      await page.screenshot({
        path: outputPath,
        type: 'png',
        fullPage: false,
      });
    }
  } finally {
    await browser.close();
  }
}

async function nextImageFilename(assetsDir) {
  let entries = [];
  try {
    entries = await readdir(assetsDir);
  } catch {
    /* empty */
  }

  let max = 0;
  for (const e of entries) {
    if (e === 'generated-page.png' && max < 1) max = 1;
    const m = e.match(/^generated-page-Ver(\d+)\.png$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }

  if (max === 0) return 'generated-page.png';
  return `generated-page-Ver${max + 1}.png`;
}
