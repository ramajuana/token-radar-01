// Token Radar entry point.
//
//   node main.ts [--input <snapshot.json|dir>] [--output <dir>]
//
// Reads the frozen DefiLlama snapshot, builds the ranked pre-token board with
// the model in lib/model.ts, and writes into the output directory:
//   board.json    the ranked board (the gate's contract)
//   data.js       window.RADAR, the same board for the dashboard
//   dashboard/    a copy of this repo's dashboard/
//   screenshots/  a copy of this repo's screenshots/
//   dossier.json  buildDossier's summary of the dashboard + screenshots,
//                 written last because it is computed over the final output
//
// Input defaults to /input and output to /output, with $MAKEFUN_OUTPUT_DIR
// honoured for local runs. Standard library only, and deterministic: the
// same snapshot always produces the same bytes.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRadar, type BoardRow, type Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const DOSSIER_CAPS = {
  text_max_bytes: 65536,
  screenshots: { max: 4, max_bytes: 524288 },
  dashboard: { max_files: 400, max_bytes: 4194304 },
} as const;

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 2) out.set(a.slice(2, eq), a.slice(eq + 1));
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) out.set(a.slice(2), argv[++i]!);
    else out.set(a.slice(2), 'true');
  }
  return out;
}

function snapshotPath(input: string): string {
  const abs = resolve(input);
  if (existsSync(abs) && statSync(abs).isDirectory()) return join(abs, 'snapshot.json');
  return abs;
}

/**
 * The gate's board rules, checked before anything is written: 100–4000 rows,
 * ranks exactly 1..N, implied values positive whole dollars, at most 1e14,
 * never rising as rank ascends and not all equal, every watchlist slug on
 * the board, and 3–12 farm steps of 20–600 characters per row.
 */
function checkBoard(rows: BoardRow[], snapshot: Snapshot): void {
  const fail = (msg: string): never => {
    throw new Error(`board check failed: ${msg}`);
  };
  if (rows.length < 100 || rows.length > 4000) fail(`board has ${rows.length} rows, outside 100..4000`);
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let prev = Number.POSITIVE_INFINITY;
  let allEqual = rows.length > 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.rank !== i + 1) fail(`row ${i} carries rank ${r.rank}, expected ${i + 1}`);
    if (!slugs.has(r.slug)) fail(`row ${r.rank} names unknown slug ${r.slug}`);
    if (seen.has(r.slug)) fail(`slug ${r.slug} appears twice`);
    seen.add(r.slug);
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) {
      fail(`row ${r.rank} implied value ${r.implied_value_usd} is not a whole dollar amount in 1..1e14`);
    }
    if (r.implied_value_usd > prev) fail(`implied value rises at rank ${r.rank}`);
    if (r.implied_value_usd !== rows[0]!.implied_value_usd) allEqual = false;
    prev = r.implied_value_usd;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) fail(`row ${r.rank} has ${r.farm_steps.length} farm steps`);
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) fail(`row ${r.rank} has a farm step of ${len} chars, outside 20..600`);
    }
  }
  if (allEqual) fail('every implied value is the same');
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) fail(`watchlist slug ${slug} is missing from the board`);
  }
}

/** Copy a directory tree (files only, names sorted) from the repo to the output. */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  const names = readdirSync(from, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of names) {
    if (e.isDirectory()) copyTree(join(from, e.name), join(to, e.name));
    else if (e.isFile()) cpSync(join(from, e.name), join(to, e.name));
  }
}

const USAGE =
  'usage: node main.ts [--input <snapshot.json|dir>] [--output <dir>]\n' +
  '  --input   snapshot file, or a directory holding snapshot.json (default /input)\n' +
  '  --output  where board.json, data.js, dashboard/, screenshots/ and dossier.json go\n' +
  '            (default $MAKEFUN_OUTPUT_DIR, else /output)\n';

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help') || args.has('h')) {
    process.stdout.write(USAGE);
    return;
  }
  const input = args.get('input') ?? '/input';
  const outDir = resolve(args.get('output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  const repoDir = fileURLToPath(new URL('.', import.meta.url));

  const snapFile = snapshotPath(input);
  if (!existsSync(snapFile)) throw new Error(`snapshot not found at ${snapFile} (from --input ${input})`);
  const snapshot = JSON.parse(readFileSync(snapFile, 'utf8')) as Snapshot;
  if (!Array.isArray(snapshot.protocols) || !Array.isArray(snapshot.watchlist)) {
    throw new Error('snapshot is missing its protocols or watchlist arrays');
  }

  const radar = buildRadar(snapshot);
  checkBoard(radar.rows, snapshot);

  mkdirSync(outDir, { recursive: true });

  const boardRows = radar.rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    implied_value_usd: r.implied_value_usd,
    farm_steps: r.farm_steps,
  }));
  writeFileSync(join(outDir, 'board.json'), JSON.stringify({ rows: boardRows }) + '\n');
  writeFileSync(join(outDir, 'data.js'), `window.RADAR = ${JSON.stringify(radar)};\n`);

  copyTree(join(repoDir, 'dashboard'), join(outDir, 'dashboard'));
  copyTree(join(repoDir, 'screenshots'), join(outDir, 'screenshots'));

  const dossier = buildDossier(outDir, DOSSIER_CAPS);
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  const covered = radar.rows.filter((r) => r.watchlist).length;
  process.stdout.write(
    `token-radar: ${radar.rows.length} pre-token protocols ranked from ${snapshot.protocols.length} in the snapshot; ` +
      `watchlist coverage ${covered}/${snapshot.watchlist.length}.\n` +
      radar.rows
        .slice(0, 5)
        .map((r) => `  #${r.rank} ${r.name} — $${r.implied_value_usd} implied on $${r.tvl_usd} TVL`)
        .join('\n') +
      `\nWrote board.json, data.js, dashboard/, screenshots/ and dossier.json (${dossier.length} bytes) to ${outDir}.\n`,
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`token-radar: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
