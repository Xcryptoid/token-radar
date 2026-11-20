// Token Radar: a token-launch radar for make.fun's token-radar-01 (Node 22, stdlib only).
//
// Reads the sealed snapshot (/input/snapshot.json, or --input <file|dir>), scores every
// rankable pre-token protocol with the radar-3 model in lib/model.ts, and writes the
// ranked board to <output>/board.json plus the dashboard data to <output>/data.js. It
// copies dashboard/ and screenshots/ into the output directory, then writes the
// makefun/dossier/v1 summary to <output>/dossier.json with the builder in lib/dossier.ts.
//
// The output directory is MAKEFUN_OUTPUT_DIR, or --output, or /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './lib/dossier.ts';

// Where this file lives: dashboard/ and screenshots/ sit beside it.
const repoDir = fileURLToPath(new URL('.', import.meta.url));

// The caps the gate holds the entry to. The dossier text cap shapes the bytes; the
// screenshot and dashboard caps only refuse.
const TEXT_CAP = 65_536;
const SCREENSHOTS = { max: 4, max_bytes: 524_288 };
const DASHBOARD = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// The value of --<name> <value> or --<name>=<value> among the arguments, else `fallback`.
function flag(name: string, fallback: string): string {
  const argv = process.argv;
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]!;
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

// A fatal message on stderr, then out with `code`.
function die(message: string, code: number): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

const input = flag('input', '/input');
const snapshotPath = input.endsWith('.json') ? input : join(input, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  die(`no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
}
const output = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) die(`the model wrote a board the gate refuses: ${issue}`, 1);

mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(output, 'data.js'), dataScript(radar));

// Copy one directory's regular files into `dest`, skipping names that start with a dot.
function copyDir(from: string, dest: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(dest, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(dest, name));
    names.push(name);
  }
  return names;
}

copyDir(join(repoDir, 'dashboard'), join(output, 'dashboard'));
if (!existsSync(join(output, 'dashboard', 'index.html'))) {
  die('dashboard/ holds no index.html: the gate refuses a dashboard with no page', 1);
}
const shots = copyDir(join(repoDir, 'screenshots'), join(output, 'screenshots'));
if (shots.length < 3) {
  die(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`, 1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    die(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
  }
}

// The dossier goes last: the scorer rebuilds it from this output and compares bytes.
writeFileSync(join(output, 'dossier.json'), buildDossier(output, { text_max_bytes: TEXT_CAP, screenshots: SCREENSHOTS, dashboard: DASHBOARD }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(output, 'board.json')}, ${join(output, 'data.js')}, ${join(output, 'dashboard')}, ${join(output, 'screenshots')} (${shots.length} images) and ${join(output, 'dossier.json')}\n`,
);
