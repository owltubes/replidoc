import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const API_BASE = 'https://api.cloud.llamaindex.ai/api/v2/parse';

export async function extractPdf(projectDir, projectId, pageSpec, dpi) {
  const apiKey = process.env.LLAMA_CLOUD_API_KEY;
  if (!apiKey) {
    return { ok: false, warning: 'LLAMA_CLOUD_API_KEY not set', extracted: false };
  }

  const pdfPath = join(projectDir, 'assets', 'reference-original.pdf');
  const pdfBuffer = await readFile(pdfPath);

  // Step 1 — Upload
  const form = new FormData();
  form.append(
    'file',
    new Blob([pdfBuffer], { type: 'application/pdf' }),
    'reference.pdf',
  );
  form.append(
    'configuration',
    JSON.stringify({
      tier: 'agentic',
      version: 'latest',
      output_options: { images_to_save: ['embedded', 'layout'] },
    }),
  );

  const uploadRes = await fetch(`${API_BASE}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`LlamaParse upload failed: ${uploadRes.status} ${text}`);
  }

  const { id: jobId } = await uploadRes.json();
  console.log(`LlamaParse job started: ${jobId}`);

  // Step 2 — Poll (3 s interval, 120 s timeout)
  const deadline = Date.now() + 120_000;
  let status;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollRes = await fetch(`${API_BASE}/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const job = await pollRes.json();
    status = job.status;
    console.log(`  poll ${jobId}: ${status}`);
    if (status === 'COMPLETED') break;
    if (status === 'FAILED' || status === 'CANCELLED') {
      throw new Error(`LlamaParse job ${status}`);
    }
  }
  if (status !== 'COMPLETED') {
    throw new Error('LlamaParse extraction timed out (120 s)');
  }

  // Step 3 — Fetch results
  const resultRes = await fetch(
    `${API_BASE}/${jobId}?expand=items,images_content_metadata`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const result = await resultRes.json();

  const items = result.items || result.result?.items || [];
  const images =
    result.images_content_metadata ||
    result.result?.images_content_metadata ||
    [];

  // Write extraction.json
  await writeFile(
    join(projectDir, 'extraction.json'),
    JSON.stringify(items, null, 2),
  );

  // Download images
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img.presigned_url) continue;
    const imgRes = await fetch(img.presigned_url);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const fname = img.name || `image_${i}.png`;
    await writeFile(join(projectDir, 'assets', fname), buf);
  }

  // Generate first-pass.html
  const pageW = Math.round(pageSpec.wIn * dpi);
  const pageH = Math.round(pageSpec.hIn * dpi);
  const html = buildFirstPassHtml(items, pageW, pageH);
  await writeFile(join(projectDir, 'first-pass.html'), html);

  return {
    ok: true,
    extracted: true,
    itemCount: items.length,
    imageCount: images.length,
  };
}

// ── first-pass.html builder ─────────────────────────────

function parseBbox(bbox) {
  if (Array.isArray(bbox))
    return { x: bbox[0], y: bbox[1], w: bbox[2], h: bbox[3] };
  return {
    x: bbox.x ?? bbox.left ?? 0,
    y: bbox.y ?? bbox.top ?? 0,
    w: bbox.w ?? bbox.width ?? 0,
    h: bbox.h ?? bbox.height ?? 0,
  };
}

function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildFirstPassHtml(items, pageW, pageH) {
  let els = '';

  for (const item of items) {
    const raw = item.bounding_box || item.bbox;
    if (!raw) continue;

    const { x, y, w, h } = parseBbox(raw);
    const px = Math.round(x * pageW);
    const py = Math.round(y * pageH);
    const pw = Math.round(w * pageW);
    const ph = Math.round(h * pageH);

    if (item.type === 'image' || item.type === 'figure') {
      const ref = item.image_name || item.image_ref || item.image || item.name;
      if (ref) {
        els += `    <img src="assets/${esc(ref)}" style="position:absolute;left:${px}px;top:${py}px;width:${pw}px;height:${ph}px" alt="">\n`;
      }
    } else {
      const text = item.value || item.text || item.content || '';
      if (text) {
        const fs = Math.max(8, Math.round(ph * 0.7));
        els += `    <div style="position:absolute;left:${px}px;top:${py}px;width:${pw}px;height:${ph}px;font-size:${fs}px;line-height:1.2;overflow:hidden">${esc(text)}</div>\n`;
      }
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="page" style="position:relative;width:${pageW}px;height:${pageH}px;padding:0;font-family:sans-serif;overflow:hidden">
${els}  </div>
</body>
</html>`;
}
