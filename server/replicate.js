import { readFile, writeFile, rename, copyFile } from 'fs/promises';
import { join } from 'path';
import OpenAI from 'openai';

export async function replicateHtmlCss(projectDir, instruction) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: { code: 'MISSING_KEY', message: 'OPENAI_API_KEY not set' },
    };
  }

  const client = new OpenAI({ apiKey });

  const meta = JSON.parse(
    await readFile(join(projectDir, 'project.json'), 'utf-8'),
  );

  let extractionData = null;
  let firstPassHtml = null;
  try {
    extractionData = JSON.parse(
      await readFile(join(projectDir, 'extraction.json'), 'utf-8'),
    );
  } catch {
    /* no extraction */
  }
  try {
    firstPassHtml = await readFile(
      join(projectDir, 'first-pass.html'),
      'utf-8',
    );
  } catch {
    /* no first-pass */
  }

  let prompt = instruction + '\n\n';
  prompt += `Project metadata:\n${JSON.stringify(meta, null, 2)}\n\n`;
  prompt += `Reference file: assets/${meta.referenceFilename}\n`;
  prompt += `Reference type: ${meta.referenceType}\n\n`;

  if (extractionData) {
    prompt += `Extraction data (element positions and text):\n${JSON.stringify(extractionData)}\n\n`;
  }
  if (firstPassHtml) {
    prompt += `First-pass HTML reference:\n${firstPassHtml}\n\n`;
  }

  prompt +=
    'Return only a JSON object with no markdown, no commentary, no code fences. ' +
    'The JSON must have exactly two keys: "index_html" and "styles_css". ' +
    'index_html must include <link rel="stylesheet" href="styles.css"> and must include id="page".';

  const response = await client.responses.create({
    model: 'gpt-5.2',
    input: prompt,
  });

  const raw = response.output_text;

  // ── Strict validation ─────────────────────────────────
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('LLM response is not valid JSON');
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !parsed.index_html || !parsed.styles_css) {
    throw new Error(
      'Response must have exactly two keys: index_html and styles_css',
    );
  }
  if (!parsed.index_html.includes('<link rel="stylesheet" href="styles.css">')) {
    throw new Error('index_html missing required stylesheet link');
  }
  if (!parsed.index_html.includes('id="page"')) {
    throw new Error('index_html missing required id="page"');
  }

  // ── Atomic write with backup ──────────────────────────
  const htmlPath = join(projectDir, 'index.html');
  const cssPath = join(projectDir, 'styles.css');
  const htmlTmp = join(projectDir, 'index.html.tmp');
  const cssTmp = join(projectDir, 'styles.css.tmp');
  const htmlBackup = join(projectDir, 'index.backup.html');
  const cssBackup = join(projectDir, 'styles.backup.css');

  try {
    await writeFile(htmlTmp, parsed.index_html);
    await writeFile(cssTmp, parsed.styles_css);

    try {
      await copyFile(htmlPath, htmlBackup);
    } catch {
      /* first run */
    }
    try {
      await copyFile(cssPath, cssBackup);
    } catch {
      /* first run */
    }

    await rename(htmlTmp, htmlPath);
    await rename(cssTmp, cssPath);

    return { ok: true };
  } catch (err) {
    try {
      await copyFile(htmlBackup, htmlPath);
    } catch {
      /* nothing to restore */
    }
    try {
      await copyFile(cssBackup, cssPath);
    } catch {
      /* nothing to restore */
    }
    return { ok: false, error: err.message, restored: true };
  }
}
