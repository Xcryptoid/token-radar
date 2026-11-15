// The dossier builder for this entry (Node 22, standard library only, no build step).
//
// main.ts calls buildDossier(dir, caps) after writing /output: it reads the dashboard/ the entry
// ships and the screenshots/ beside it and returns the dossier (makefun/dossier/v1) as canonical
// JSON bytes. The scorer rebuilds the same dossier from the same /output and requires the bytes
// to match, so this file's job is to produce exactly one spelling of the dossier:
//
//   schema  "makefun/dossier/v1"
//   cover   0: the first screenshot by name is the cover
//   images  the PNG and JPEG files in dir/screenshots/ (names starting with '.' skipped), in name
//           order, each {name, media_type, sha256, base64}
//   text    what the judge reads: a "## Dashboard" block (the file count, the bytes, and every
//           file's path with its size), then "## Source", each text file's path, size and line
//           count and its contents in a fenced block by path, every file by path
//
// The text holds at most caps.text_max_bytes UTF-8 bytes: every file that fits goes in whole, in
// path order; the first that does not goes in up to its last complete line that fits (its fence
// closed, then a line naming how many of its lines are not shown), or not at all when not one
// line fits; nothing follows it but a last line naming how many whole files and how many bytes
// were left out. A file whose extension is not one of .html .css .js .json .mjs .svg .md .txt is
// named in the Dashboard block and not shown: the text is source, and the page's images are not
// source.
//
// buildDossier refuses (DossierError) an empty screenshots/ directory, a screenshot name the
// dossier refuses, a screenshot that is not a whole PNG or JPEG, a screenshot past its byte cap
// or more screenshots than the count cap, a dashboard file that is not plain (a link, a
// dot-directory, a name that is not letters, digits and . _ -, a file past its byte cap or more
// files than the count cap), a text cap that cannot hold the Dashboard block and the cut line,
// and a dossier past 4 MiB. The caps only refuse: they never shape the bytes. Only
// text_max_bytes shapes them.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

/** The schema string every dossier carries. */
export const DOSSIER_SCHEMA = 'makefun/dossier/v1';
/** A dossier never holds more than 4 MiB. */
export const DOSSIER_MAX_BYTES = 4 * 1024 * 1024;
/** A dossier never holds more than 8 images. */
export const DOSSIER_MAX_IMAGES = 8;
/** A plain file's name: a letter, digit or _ first, then letters, digits and . _ -, 1 to 128 of them, no directory. */
export const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** A dashboard file whose contents the dossier's text shows: source, never an image. */
export const TEXT_FILE = /\.(?:html|css|js|json|mjs|svg|md|txt)$/;

/** What buildDossier is held to: the text's cap in UTF-8 bytes, and, when given, the screenshot and dashboard caps, which only refuse. */
export interface DossierCaps {
  text_max_bytes: number;
  screenshots?: { max: number; max_bytes: number };
  dashboard?: { max_files: number; max_bytes: number };
}

/** Why buildDossier writes no dossier for a directory: its caps, its screenshots, its dashboard or its size. */
export class DossierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DossierError';
  }
}

// ------------------------------------------------------------ small pieces

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_BYTES = [0xff, 0xd8, 0xff];

function startsWithBytes(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

/**
 * One regular file's bytes, at most `cap` long; never through a link, never more than `cap` bytes
 * read. A link, a directory or a missing file is a DossierError naming `what`.
 */
function readAtMost(path: string, cap: number, what: string): Uint8Array {
  let size: number;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new DossierError(`buildDossier: ${what} is not a regular file`);
    size = st.size;
  } catch (err) {
    if (err instanceof DossierError) throw err;
    throw new DossierError(`buildDossier: ${what} cannot be read`);
  }
  if (size > cap) throw new DossierError(`buildDossier: ${what} is ${size} bytes, over the ${cap} a dossier reads`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new DossierError(`buildDossier: ${what} is not a regular file`);
  }
  try {
    const now = fstatSync(fd).size;
    if (now > cap) throw new DossierError(`buildDossier: ${what} is ${now} bytes, over the ${cap} a dossier reads`);
    const buf = Buffer.alloc(now);
    let at = 0;
    while (at < buf.length) {
      const n = readSync(fd, buf, at, buf.length - at, at);
      if (n === 0) break;
      at += n;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, at);
  } finally {
    closeSync(fd);
  }
}

/** Lines of a text: 0 when empty, else its newlines plus one for a last line with none. */
function countLines(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n++;
  return bytes[bytes.length - 1] === 0x0a ? n : n + 1;
}

/** A Markdown fence one backtick longer than the longest run in `body`, three at least. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) if (run.length > longest) longest = run.length;
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The fence a file's extension is shown with. */
function languageFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  return ext === 'mjs' ? 'js' : ext;
}

/**
 * JSON with every object's keys in code-unit order and no whitespace: one spelling per value.
 * Takes null, booleans, finite numbers, strings, arrays and plain objects; throws TypeError on
 * anything else (undefined, a function, a bigint, NaN, Infinity, a class instance).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} is not a finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects and arrays');
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort(cmpStr)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
}

// ------------------------------------------------------------ the dashboard walk

/** One file of the dashboard tree: its path relative to the directory, and its size in bytes. */
interface DashboardEntry {
  path: string;
  size: number;
}

/**
 * Every regular file under `root` (symbolic links are neither followed nor taken for files), in
 * path order, with its size. Refuses a dot-directory, a file whose name the dossier refuses, an
 * entry that is neither a file nor a directory, and, when the caps are given, too many files or
 * bytes in all.
 */
function collectDashboard(root: string, caps: { max_files: number; max_bytes: number } | null): DashboardEntry[] {
  let st: import('node:fs').Stats;
  try {
    st = lstatSync(root);
  } catch {
    throw new DossierError('buildDossier: no dashboard/ directory: the page and its source are what the judge reads');
  }
  if (!st.isDirectory()) throw new DossierError('buildDossier: dashboard is not a directory');
  const found: DashboardEntry[] = [];
  let total = 0;
  const pending: string[] = [''];
  while (pending.length > 0) {
    const rel = pending.pop()!;
    const dir = rel === '' ? root : join(root, rel);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) throw new DossierError(`buildDossier: dashboard/${p} is a dot-directory`);
        pending.push(p);
      } else if (e.isFile()) {
        if (!PLAIN_NAME.test(e.name)) throw new DossierError(`buildDossier: dashboard/${p}: a file's name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`);
        const size = lstatSync(join(root, p)).size;
        found.push({ path: p, size });
        total += size;
        if (caps !== null && found.length > caps.max_files) throw new DossierError(`buildDossier: dashboard/ holds more than the ${caps.max_files} files it may`);
        if (caps !== null && total > caps.max_bytes) throw new DossierError(`buildDossier: dashboard/'s files come to more than the ${caps.max_bytes} bytes they may`);
      } else {
        throw new DossierError(`buildDossier: dashboard/${p} is neither a file nor a directory`);
      }
    }
  }
  return found.sort((a, b) => cmpStr(a.path, b.path));
}

// ------------------------------------------------------------ the dossier

/** A shown file as the dossier shows it. */
interface ShownFile {
  bytes: Uint8Array;
  text: string;
  fence: string;
  /** The language the fence opens with (the file's extension, mjs as js). */
  lang: string;
  /** The fenced block: the fence and the language, the text (a last LF added when it lacks one), the fence, a blank line. */
  block: string;
  blockBytes: number;
  lines: number;
}

interface Section {
  heading: string;
  file: ShownFile | null;
  size: number;
  bytes: number;
}

/**
 * A file's section cut inside its contents: its heading, its first k lines in its fence (closed),
 * a line naming how many of its lines are not shown, then `tail(hidden)` (the cut line, given the
 * bytes this file leaves out), k the most lines (at least one, fewer than all) whose whole fits in
 * `room` UTF-8 bytes; null when not one line fits. It cuts only after a line's LF, which is never
 * inside a UTF-8 sequence nor a replacement character's bytes, so no character is split, and a
 * line's shown bytes are those of its text.
 */
function cutSectionHead(heading: string, file: ShownFile, room: number, tail: (hidden: number) => string): string | null {
  const total = file.lines;
  const lines = file.text.split('\n');
  const open = `${file.fence}${file.lang}\n`;
  const close = `${file.fence}\n\n`;
  const noteFor = (k: number): string => `[${total - k} of this file's ${total} lines not shown.]\n`;
  const fixed = utf8Length(heading) + utf8Length(open) + utf8Length(close);
  let best = 0;
  let shownBytes = 0;
  let rawPos = 0;
  for (let k = 1; k < total; k++) {
    shownBytes += utf8Length(lines[k - 1]!) + 1;
    rawPos = file.bytes.indexOf(0x0a, rawPos) + 1;
    if (fixed + shownBytes + utf8Length(noteFor(k)) + utf8Length(tail(file.bytes.length - rawPos)) <= room) best = k;
  }
  if (best === 0) return null;
  let rawEnd = 0;
  for (let k = 0; k < best; k++) rawEnd = file.bytes.indexOf(0x0a, rawEnd) + 1;
  const head = lines.slice(0, best).map((l) => `${l}\n`).join('');
  return `${heading}${open}${head}${close}${noteFor(best)}${tail(file.bytes.length - rawEnd)}`;
}

function checkCaps(caps: DossierCaps): { maxImages: number; maxImageBytes: number; fileCaps: { max_files: number; max_bytes: number } | null } {
  const max = caps.text_max_bytes;
  if (!Number.isSafeInteger(max) || max <= 0) throw new DossierError(`buildDossier: caps.text_max_bytes must be a positive integer, not ${String(max)}`);
  let maxImages = DOSSIER_MAX_IMAGES;
  let maxImageBytes = DOSSIER_MAX_BYTES;
  if (caps.screenshots !== undefined) {
    const s = caps.screenshots as { max?: unknown; max_bytes?: unknown } | null;
    if (typeof s !== 'object' || s === null) throw new DossierError('buildDossier: caps.screenshots must be an object {max, max_bytes}');
    for (const k of ['max', 'max_bytes'] as const) {
      const v = s[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new DossierError(`buildDossier: caps.screenshots.${k} must be a positive integer, not ${String(v)}`);
    }
    if ((s.max as number) < maxImages) maxImages = s.max as number;
    if ((s.max_bytes as number) < maxImageBytes) maxImageBytes = s.max_bytes as number;
  }
  let fileCaps: { max_files: number; max_bytes: number } | null = null;
  if (caps.dashboard !== undefined) {
    const d = caps.dashboard as { max_files?: unknown; max_bytes?: unknown } | null;
    if (typeof d !== 'object' || d === null) throw new DossierError('buildDossier: caps.dashboard must be an object {max_files, max_bytes}');
    for (const k of ['max_files', 'max_bytes'] as const) {
      const v = d[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new DossierError(`buildDossier: caps.dashboard.${k} must be a positive integer, not ${String(v)}`);
    }
    fileCaps = { max_files: d.max_files as number, max_bytes: d.max_bytes as number };
  }
  return { maxImages, maxImageBytes, fileCaps };
}

function collectImages(dir: string, maxImages: number, maxImageBytes: number): { name: string; media_type: string; sha256: string; base64: string }[] {
  const shotsDir = join(dir, 'screenshots');
  let names: string[];
  try {
    names = readdirSync(shotsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(cmpStr);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') throw new DossierError('buildDossier: no screenshots/ directory: the first screenshot is the cover');
    throw new DossierError('buildDossier: screenshots/ cannot be read');
  }
  if (names.length === 0) throw new DossierError('buildDossier: screenshots/ holds no image: the first is the cover');
  if (names.length > maxImages) throw new DossierError(`buildDossier: screenshots/ holds ${names.length} files, over the ${maxImages} a dossier holds`);
  return names.map((name) => {
    if (!PLAIN_NAME.test(name)) throw new DossierError(`buildDossier: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`);
    const bytes = readAtMost(join(shotsDir, name), maxImageBytes, `screenshots/${name}`);
    const media_type = startsWithBytes(bytes, PNG_BYTES) ? 'image/png' : startsWithBytes(bytes, JPEG_BYTES) ? 'image/jpeg' : null;
    if (media_type === null) throw new DossierError(`buildDossier: screenshots/${name} is neither a PNG nor a JPEG`);
    return { name, media_type, sha256: sha256Hex(bytes), base64: Buffer.from(bytes).toString('base64') };
  });
}

/**
 * The dossier (makefun/dossier/v1) of a dashboard directory, as canonical JSON bytes:
 * `dir/screenshots/`'s PNG and JPEG files (names starting with '.' skipped) are its images, the
 * first the cover; its text is the "## Dashboard" block and the "## Source" sections described
 * above, capped at `caps.text_max_bytes` UTF-8 bytes with the cut rule above. Throws DossierError
 * on caps it cannot keep and on a dashboard or screenshots directory it refuses.
 */
export function buildDossier(dir: string, caps: DossierCaps): Uint8Array {
  const max = caps.text_max_bytes;
  const { maxImages, maxImageBytes, fileCaps } = checkCaps(caps);
  const files = collectDashboard(join(dir, 'dashboard'), fileCaps);
  const images = collectImages(dir, maxImages, maxImageBytes);

  const head = [
    '## Dashboard',
    '',
    `Files: ${files.length} (${files.reduce((n, f) => n + f.size, 0)} bytes)`,
    ...files.map((f) => `- ${f.path} (${f.size} bytes)`),
    '',
    '## Source',
    '',
    '',
  ].join('\n');

  // The files whose contents are shown, by path; a binary file is named in the Dashboard block only.
  const shown = files.filter((f) => TEXT_FILE.test(f.path));
  const sections: Section[] = shown.map((f) => {
    const bytes = readAtMost(join(dir, 'dashboard', f.path), DOSSIER_MAX_BYTES, `dashboard/${f.path}`);
    const lines = countLines(bytes);
    const heading = `### ${f.path}\n\n${bytes.length} bytes, ${lines} line${lines === 1 ? '' : 's'}\n\n`;
    if (bytes.length === 0) return { heading, file: null, size: utf8Length(heading), bytes: 0 };
    const text = new TextDecoder('utf-8').decode(bytes);
    const fence = fenceFor(text);
    const lang = languageFor(f.path);
    const block = `${fence}${lang}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    return { heading, file: { bytes, text, fence, lang, block, blockBytes: utf8Length(block), lines }, size: utf8Length(heading) + utf8Length(block), bytes: bytes.length };
  });

  // restBytes[k]: the bytes of the shown files after section k.
  const restBytes = new Array<number>(sections.length + 1).fill(0);
  for (let k = sections.length - 1; k >= 0; k--) restBytes[k] = restBytes[k + 1]! + (k + 1 < sections.length ? sections[k + 1]!.bytes : 0);

  const cutLine = (count: number, bytes: number): string => `[Cut at ${max} bytes: ${count} file${count === 1 ? '' : 's'} and ${bytes} bytes left out.]\n`;
  let out = head;
  let used = utf8Length(head);
  if (used + utf8Length(cutLine(0, 0)) > max) throw new DossierError(`buildDossier: caps.text_max_bytes ${max} cannot hold even the Dashboard block and the cut line`);
  let kept = 0;
  for (; kept < sections.length; kept++) {
    const section = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const tail = restCount === 0 ? 0 : utf8Length(cutLine(restCount, restBytes[kept]!));
    if (used + section.size + tail > max) break;
    out += section.file === null ? section.heading : `${section.heading}${section.file.block}`;
    used += section.size;
  }
  if (kept < sections.length) {
    // The first file that does not fit whole: its head, up to its last complete line that fits, then nothing more.
    const first = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const after = restBytes[kept]!;
    const part = first.file === null ? null : cutSectionHead(first.heading, first.file, max - used, (hidden) => cutLine(restCount, after + hidden));
    out += part ?? cutLine(restCount + 1, after + first.bytes);
  }
  if (utf8Length(out) > max) throw new DossierError(`buildDossier: caps.text_max_bytes ${max} cannot hold even the Dashboard block and the cut line`);

  const doc = { schema: DOSSIER_SCHEMA, cover: 0, text: out.replace(/\n+$/, '\n'), images };
  const bytes = Buffer.from(canonicalJson(doc), 'utf8');
  if (bytes.length > DOSSIER_MAX_BYTES) throw new DossierError(`buildDossier: the dossier is ${bytes.length} bytes, over the ${DOSSIER_MAX_BYTES} one holds`);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}
