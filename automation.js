import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Composio } from '@composio/core';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { T } from './tools.js';

const env = process.env;
const OUT = path.resolve('output');
const LOGS = path.resolve('logs');
const W = 1080, H = 1920;
const IG_TAGS = '#selfimprovement #confidence #aura #mindset #masculinity';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Clear logs: ::error:: / ::warning:: show up as annotations on the GitHub run page
function note(level, msg) { console.log(env.GITHUB_ACTIONS ? `::${level}::${String(msg).replace(/\r?\n/g, ' ')}` : `${level.toUpperCase()}: ${msg}`); }
const missing = ['PEXELS_API_KEY', 'ELEVENLABS_API_KEY', 'COMPOSIO_API_KEY'].filter((k) => !env[k]);
if (missing.length) {
  note('error', `Missing required secrets: ${missing.join(', ')}. Add them under Settings > Secrets and variables > Actions.`);
  process.exit(1);
}
if (!(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY)) note('warning', 'S3_* secrets not set: Instagram will rely on Composio temporary hosting (video_file).');
if (!env.ANTHROPIC_API_KEY) note('warning', 'ANTHROPIC_API_KEY not set: only 4 built-in scripts will rotate (they repeat every ~1.5 days at 3 posts/day).');
const composio = new Composio({ apiKey: env.COMPOSIO_API_KEY });
const USER_ID = env.COMPOSIO_USER_ID || 'default';

// ---------- helpers ----------
async function retry(name, fn, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (e.quota || /quota/i.test(e.message)) { e.quota = true; throw e; } // never retry quota errors
      console.warn(`[${name}] attempt ${i}/${tries} failed: ${e.message}`);
      if (i < tries) await sleep(5000 * i);
    }
  }
  throw last;
}
const ff = (args, cwd) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { cwd, stdio: 'inherit' });
const duration = (f) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
const wc = (s) => s.split(/\s+/).filter(Boolean).length;
async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

// Composio: exact slugs/args live in tools.js and are verified by `npm run schemas`
async function exec(slug, args) {
  const r = await composio.tools.execute(slug, { userId: USER_ID, arguments: args, dangerouslySkipVersionCheck: true });
  if (!r.successful) throw new Error(`${slug}: ${r.error || JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}

// ---------- 1+2. topic & script ----------
const BANK = [
  { topic: 'The 3-Second Rule That Makes People Trust You', hook: 'Do this in the first three seconds and people trust you instantly.',
    tricks: ['One: hold eye contact just long enough to notice their eye colour. It feels natural to them, and it tells their brain you are confident and honest.',
             "Two: use their name once, early in the conversation. A person's name is the sweetest sound to them, and it makes them relax around you.",
             'Three: slow down your speech. Fast talkers look nervous, but slow, calm speech makes people believe every word you say.'],
    cta: 'Follow for more psychology tricks they never taught you in school.', queries: ['business handshake', 'man confident city', 'eye contact portrait'] },
  { topic: 'How to Make Anyone Open Up to You', hook: 'There is a psychology trick that makes anyone open up to you.',
    tricks: ['One: ask a question, then stay completely silent. Most people cannot stand silence, so they rush to fill the gap and tell you far more than they planned.',
             'Two: repeat the last three words they said, as a question. It makes them feel heard, and they keep explaining without you saying anything.',
             'Three: nod slowly while they speak. Slow nodding signals understanding, and it quietly makes people trust you with their real thoughts.'],
    cta: 'Follow for daily psychology tricks you can use today.', queries: ['people talking cafe', 'conversation close up', 'man listening'] },
  { topic: 'Body Language Signs Someone Respects You', hook: 'Their body already told you whether they respect you, and you can read it in three seconds.',
    tricks: ['One: check their feet. People point their feet toward whoever they like and respect, even when their face is pretending otherwise.',
             'Two: watch for mirroring. If they copy your posture or your gestures without noticing, their subconscious has accepted you.',
             'Three: see who leans in. When you speak, a respectful person leans forward and stays still, and when you pause, they wait for more.'],
    cta: 'Follow for more body language secrets nobody talks about.', queries: ['body language office', 'business meeting', 'man walking street'] },
  { topic: 'Mind Tricks to Look More Confident Instantly', hook: 'Confidence is mostly a trick, and here are three ways to fake it.',
    tricks: ['One: take up space. Open posture, shoulders back and chin level change how you feel, and other people read that as certainty.',
             'Two: pause before you answer. A short silence makes your words sound deliberate, and people assume the calm person holds the power.',
             'Three: lower your voice at the end of every sentence. A falling tone signals certainty, while a rising tone sounds like you are asking permission.'],
    cta: 'Follow, and start using these today, because nobody notices the trick.', queries: ['man in suit', 'gym mirror', 'city night walk'] },
];

// Topic memory comes from logs/runs.jsonl, which is written together with logs/runs.csv (same rows).
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function topicLog() {
  let runs = [];
  try { runs = fs.readFileSync(path.join(LOGS, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* first run */ }
  const today = new Date().toISOString().slice(0, 10);
  return {
    recent: runs.slice(-60).map((r) => r.idea).filter(Boolean),                                       // last ~20 days at 3 posts/day
    today: runs.filter((r) => String(r.date).startsWith(today)).map((r) => r.idea).filter(Boolean),   // already posted today
  };
}

async function claudeContent(prev, today, note = '') {
  const prompt = `Today is ${new Date().toISOString().slice(0, 10)}. Pick ONE fresh, viral topic in "Human Psychology Tricks" for a faceless vertical Short.
Do NOT reuse these recent topics: ${prev.join(' | ') || 'none'}.
Already posted TODAY (your topic must be clearly different in angle and subject): ${today.join(' | ') || 'none'}.
Script structure: a scroll-stopping hook (max 12 words, ~2 seconds), exactly 3 tricks (2 short sentences each, starting "One:", "Two:", "Three:"), then a one-sentence CTA.
The total spoken text (hook + tricks + CTA) MUST be 95-115 words so it runs 35-45 seconds. Plain spoken English, no emojis, no hashtags, only claims that are reasonable. ${note}
Return ONLY JSON: {"topic":"max 50 chars","hook":"","tricks":["","",""],"cta":"","keywords":["10 SEO keywords"],"queries":["3 short b-roll scene ideas, visual only"]}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const c = JSON.parse(j.content.map((x) => x.text || '').join('').replace(/```json|```/g, '').trim());
  if (!c.topic || !c.hook || c.tricks?.length !== 3 || !c.cta) throw new Error('Bad JSON shape');
  if ([...today, ...prev].some((t) => norm(t) === norm(c.topic))) throw new Error('Topic was already used');
  const n = wc([c.hook, ...c.tricks, c.cta].join(' '));
  if (n < 85 || n > 125) throw new Error(`Script is ${n} words (need 95-115)`);
  c.queries = c.queries?.length ? c.queries : ['city night walk', 'man portrait', 'people conversation'];
  return c;
}

async function generateContent() {
  const { recent, today } = topicLog();
  if (today.length) console.log(`Already posted today: ${today.join(' | ')}`);
  if (env.ANTHROPIC_API_KEY) {
    let note = '';
    for (let i = 0; i < 3; i++) {
      try { const c = await claudeContent(recent, today, note); console.log('Script by Claude'); return c; }
      catch (e) { console.warn(`Claude script attempt ${i + 1} failed: ${e.message}`); note = `Previous attempt failed: ${e.message}.`; }
    }
    console.warn('Falling back to built-in scripts');
  }
  // Built-in: never repeat a topic already posted today, otherwise take the least recently used one
  const usedToday = new Set(today.map(norm));
  const seen = recent.map(norm);
  const pool = BANK.filter((b) => !usedToday.has(norm(b.topic)));
  return [...(pool.length ? pool : BANK)].sort((a, b) => seen.lastIndexOf(norm(a.topic)) - seen.lastIndexOf(norm(b.topic)))[0];
}

// ---------- 3. video ----------
async function elevenlabs(text, file) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3 } }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${await r.text()}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

async function pexelsClips(queries, count, dir) {
  const files = [];
  for (let i = 0; files.length < count && i < count * 3; i++) {
    const q = queries[i % queries.length];
    const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=portrait&size=medium&per_page=15&page=${1 + Math.floor(i / queries.length)}`, { headers: { Authorization: env.PEXELS_API_KEY } });
    if (!r.ok) throw new Error(`Pexels ${r.status}`);
    const { videos = [] } = await r.json();
    const v = videos[Math.floor(Math.random() * videos.length)];
    const f = v?.video_files?.filter((x) => x.width < x.height && x.width >= 720).sort((a, b) => Math.abs(a.height - H) - Math.abs(b.height - H))[0];
    if (!f) continue;
    const file = path.join(dir, `raw${files.length}.mp4`);
    await download(f.link, file);
    files.push(file);
  }
  if (!files.length) throw new Error('No Pexels clips found');
  return files;
}

// Higgsfield (docs.higgsfield.ai): POST https://api.higgsfield.ai/<model> -> poll status_url -> video.url
function hfAuth() {
  const k = env.HF_API_KEY;
  if (!k) return null;
  if (k.includes(':')) return k;
  const s = env.HF_API_SECRET || env.HF_API_KEY_SECRET;
  if (!s) { console.warn('HF_API_KEY set but no HF_API_SECRET (or "id:secret" format): using Pexels'); return null; }
  return `${k}:${s}`;
}
async function hfClip(prompt, file, auth) {
  const headers = { Authorization: `Key ${auth}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() };
  const body = { prompt, aspect_ratio: '9:16', duration: 5, resolution: '720p', ...JSON.parse(env.HF_EXTRA_JSON || '{}') };
  const r = await fetch(`https://api.higgsfield.ai/${env.HF_MODEL || 'wan/v2.7/text-to-video'}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Higgsfield submit ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const { status_url } = await r.json();
  for (let i = 0; i < 72; i++) { // ~6 min
    await sleep(5000);
    const s = await (await fetch(status_url, { headers: { Authorization: headers.Authorization } })).json();
    if (s.status === 'completed') {
      if (!s.video?.url) throw new Error('Higgsfield completed without video.url');
      return download(s.video.url, file);
    }
    if (['failed', 'nsfw', 'canceled'].includes(s.status)) throw new Error(`Higgsfield ${s.status}`);
  }
  throw new Error('Higgsfield timeout');
}
async function hfClips(queries, count, dir, auth) {
  const style = 'vertical cinematic b-roll, moody lighting, shallow depth of field, no text, no logos, no one speaking to camera';
  const files = Array.from({ length: count }, (_, i) => path.join(dir, `raw${i}.mp4`));
  await Promise.all(files.map((f, i) => hfClip(`${queries[i % queries.length]}, ${style}`, f, auth)));
  return files;
}

const ts = (s) => { const cs = Math.round(s * 100); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
function buildAss(text, dur) {
  const words = text.split(/\s+/).filter(Boolean);
  const total = words.reduce((a, w) => a + w.length + 1, 0);
  let t = 0; const lines = [];
  for (let i = 0; i < words.length; i += 3) {
    const chunk = words.slice(i, i + 3);
    const len = chunk.reduce((a, w) => a + w.length + 1, 0) / total * dur;
    lines.push(`Dialogue: 0,${ts(t)},${ts(t + len)},Cap,,0,0,0,,${chunk.join(' ').toUpperCase()}`);
    t += len;
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Cap,DejaVu Sans,86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,7,0,2,60,60,380,1

[Events]
Format: Layer,Start,End,Style,MarginL,MarginR,MarginV,Effect,Text
${lines.join('\n')}
`;
}

async function buildVideo(content, stamp) {
  const work = fs.mkdtempSync(path.join(OUT, 'work-'));
  const voiceText = [content.hook, ...content.tricks, content.cta].join(' ');
  const mp3 = path.join(work, 'voice.mp3');
  await retry('elevenlabs', () => elevenlabs(voiceText, mp3));
  const dur = duration(mp3);
  console.log(`Voiceover: ${dur.toFixed(1)}s, ${wc(voiceText)} words (target 35-45s)`);
  if (dur < 30 || dur > 55) console.warn('Voiceover length is outside the 35-45s target');
  if (dur > 85) throw new Error('Voiceover too long for Reels (<90s)');

  // b-roll: Higgsfield if configured (falls back to Pexels on any failure)
  let raws, segLen = 4;
  const auth = hfAuth();
  if (auth) {
    const need = Math.ceil((dur + 0.5) / 5);
    try {
      raws = await retry('higgsfield', () => hfClips(content.queries, Math.min(need, +env.HF_MAX_CLIPS || 6), work, auth), 2);
      segLen = 5; console.log(`Higgsfield: ${raws.length} clips`);
    } catch (e) { console.warn('Higgsfield failed, falling back to Pexels:', e.message); }
  }
  if (!raws) raws = await retry('pexels', () => pexelsClips(content.queries, Math.ceil((dur + 0.5) / segLen), work));

  const n = Math.ceil((dur + 0.5) / segLen);
  const segs = [];
  for (let i = 0; i < n; i++) {
    const out = `seg${i}.mp4`;
    ff(['-stream_loop', '-1', '-i', raws[i % raws.length], '-t', String(segLen), '-an', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,setsar=1`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', out], work);
    segs.push(out);
  }
  fs.writeFileSync(path.join(work, 'list.txt'), segs.map((s) => `file '${s}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'bg.mp4'], work);
  fs.writeFileSync(path.join(work, 'captions.ass'), buildAss(voiceText, dur));

  const final = path.join(OUT, `short-${stamp}.mp4`);
  const render = (crf) => ff(['-i', 'bg.mp4', '-i', 'voice.mp3', '-vf', 'subtitles=captions.ass', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-t', String(dur + 0.3), '-movflags', '+faststart', final], work);
  render(23);
  if (fs.statSync(final).size > 95 * 1024 * 1024) render(30);
  ff(['-i', final, '-frames:v', '1', '-q:v', '2', path.join(OUT, `short-${stamp}.jpg`)]); // first-frame cover, kept for reference
  fs.rmSync(work, { recursive: true, force: true });
  const mb = fs.statSync(final).size / 1048576, secs = duration(final);
  console.log(`Video ready: ${final} (${mb.toFixed(1)} MB, ${secs.toFixed(1)}s)`);
  if (mb >= 100 || secs >= 90) throw new Error('Video exceeds Reels limits (<100MB, <90s)');
  return { final, voiceText };
}

// ---------- 4. metadata ----------
function buildMetadata(c) {
  const TAGS = ' #psychology #mindset #darkpsychology #Shorts'; // 3 hashtags + #Shorts
  const max = 100 - TAGS.length; // YouTube titles are capped at 100 chars
  let topic = c.topic.trim();
  if (topic.length > max) topic = topic.slice(0, max).replace(/\s+\S*$/, '').trim();
  const title = topic + TAGS;
  const kws = (c.keywords?.length ? c.keywords : ['human psychology', 'psychology tricks', 'psychology facts', 'body language', 'mind tricks', 'self improvement', 'confidence', 'social skills', 'persuasion', 'mindset']).slice(0, 10);
  const description = `${c.hook}\n\n${c.tricks.join('\n')}\n\n${c.cta}\n\nKeywords: ${kws.join(', ')}\n\n#psychology #mindset #darkpsychology #Shorts`;
  let igCaption = `${topic} #psychology #mindset #darkpsychology\n\n${IG_TAGS}`;
  if (env.IG_ENCODE_HASHTAGS === '1') igCaption = igCaption.replace(/#/g, '%23');
  return { title, description, tags: kws.map((k) => k.slice(0, 30)), igCaption };
}

// ---------- 5a. YouTube via Composio ----------
async function postYouTube(file, m) {
  const base = { title: m.title, description: m.description, tags: m.tags, categoryId: '26', privacyStatus: 'public' };
  try {
    const d = await exec(T.YT_MULTIPART, { ...base, videoFile: file }); // SDK auto-uploads the local path
    const id = d?.video?.id;
    if (!id) throw new Error('no video id in response');
    return String(id);
  } catch (e) {
    if (/quota/i.test(e.message)) { e.quota = true; throw e; }
    console.warn(`${T.YT_MULTIPART} failed (${e.message}); trying ${T.YT_UPLOAD}`);
    const d = await exec(T.YT_UPLOAD, { ...base, videoFilePath: file });
    const id = d?.response_data?.id;
    if (!id) throw new Error('no video id in response');
    return String(id);
  }
}

// ---------- 5b. Instagram via Composio (video must be at a public URL) ----------
const haveS3 = () => env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY;
async function hostPublic(file) {
  const s3 = new S3Client({
    region: env.S3_REGION || 'auto',
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  const Key = `reels/${Date.now()}-${path.basename(file)}`;
  const put = (extra) => s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key, Body: fs.readFileSync(file), ContentType: 'video/mp4', ...extra }));
  try { await put({ ACL: 'public-read' }); }
  catch (e) { // ACLs disabled (new AWS buckets) or unsupported (R2): upload without ACL
    console.warn(`public-read ACL rejected (${e.name}); uploading without ACL`);
    await put({});
  }
  let url;
  if (env.S3_PUBLIC_BASE_URL) url = `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${Key.split('/').map(encodeURIComponent).join('/')}`;
  else url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key }), { expiresIn: 3600 }); // temporary signed URL
  const head = await fetch(url, { headers: { Range: 'bytes=0-0' } }).catch(() => null);
  if (!head || ![200, 206].includes(head.status)) {
    if (env.S3_PUBLIC_BASE_URL) { // public URL isn't reachable: use a signed URL instead
      console.warn(`Public URL returned ${head?.status}; using a signed URL`);
      url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key }), { expiresIn: 3600 });
    } else throw new Error(`Hosted video not reachable (${head?.status})`);
  }
  return { url, remove: () => s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key })) };
}

async function igUserId() {
  if (env.IG_USER_ID) return env.IG_USER_ID;
  try { const d = await exec(T.IG_USER, { ig_user_id: 'me' }); return String(d?.id || d?.user_id || d?.data?.id || 'me'); }
  catch (e) { console.warn('Could not resolve IG user id, using "me":', e.message); return 'me'; }
}

async function postInstagram(file, m) {
  const ig_user_id = await igUserId();
  const args = { ig_user_id, media_type: 'REELS', caption: m.igCaption, share_to_feed: true, thumb_offset: 0 }; // thumb_offset 0 = first frame as cover
  let hosted;
  if (haveS3()) { hosted = await retry('s3-upload', () => hostPublic(file)); args.video_url = hosted.url; }
  else { console.warn('S3_* not set: letting Composio host the file temporarily (video_file)'); args.video_file = file; }
  try {
    const c = await retry('ig-container', () => exec(T.IG_CONTAINER, args));
    if (!c?.id) throw new Error('no container id in response');
    // publish waits for processing itself (max_wait_seconds); retried with the same container
    const p = await retry('ig-publish', () => exec(T.IG_PUBLISH, { ig_user_id, creation_id: String(c.id), max_wait_seconds: 300, poll_interval_seconds: 5 }));
    if (!p?.id) throw new Error('no media id in publish response');
    return String(p.id);
  } finally { if (hosted) await hosted.remove().catch((e) => console.warn('S3 cleanup failed:', e.message)); }
}

// ---------- 6. log ----------
async function logRow(row) {
  fs.mkdirSync(LOGS, { recursive: true });
  const cells = [row.date, row.idea, row.script, row.yt, row.ig, row.status]; // Date | Idea | Script | YT ID | IG ID | Status
  fs.appendFileSync(path.join(LOGS, 'runs.jsonl'), JSON.stringify(row) + '\n');
  fs.appendFileSync(path.join(LOGS, 'runs.csv'), cells.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',') + '\n');
  console.log('LOG ROW:', JSON.stringify(cells));
  if (env.LOG_MODE === 'composio') {
    if (!env.SHEET_ID) { console.warn('LOG_MODE=composio but SHEET_ID is empty: CSV only'); return; }
    try {
      const tab = env.SHEET_NAME || (await exec(T.SHEETS_NAMES, { spreadsheet_id: env.SHEET_ID }))?.sheet_names?.[0];
      if (!tab) throw new Error('could not determine sheet tab name');
      await exec(T.SHEETS_APPEND, { spreadsheetId: env.SHEET_ID, range: `${tab}!A:F`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', values: [cells] });
      console.log(`Logged to Google Sheet tab "${tab}"`);
    } catch (e) { console.warn('Composio Sheets append failed (CSV row was still written):', e.message); }
  }
}

// ---------- 7. cleanup ----------
function cleanup() {
  if (!fs.existsSync(OUT)) return;
  for (const f of fs.readdirSync(OUT)) {
    const p = path.join(OUT, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400000) fs.rmSync(p, { recursive: true, force: true });
  }
}

// ---------- main ----------
// Random 0-5 min delay on scheduled runs so overlapping triggers don't act at the same instant.
async function startDelay() {
  if (env.SKIP_DELAY === '1' || env.GITHUB_EVENT_NAME === 'workflow_dispatch') return;
  const max = env.MAX_START_DELAY_MIN ? Number(env.MAX_START_DELAY_MIN) : 5;
  if (!(max > 0)) return;
  const ms = Math.floor(Math.random() * max * 60000);
  console.log(`Random start delay: ${(ms / 60000).toFixed(1)} min (max ${max})`);
  await sleep(ms);
}

(async () => {
  await startDelay();
  fs.mkdirSync(OUT, { recursive: true });
  cleanup();
  const content = await generateContent();
  const stamp = new Date().toISOString().slice(0, 16).replace(':', ''); // e.g. 2026-10-04T1300 (3 posts/day must not overwrite each other)
  const video = await buildVideo(content, stamp);
  const meta = buildMetadata(content);
  console.log('Title:', meta.title);
  if (env.DRY_RUN === '1') { console.log(`DRY RUN: video built at ${video.final}, skipping uploads and logging.`); return; }

  const res = { yt: '', ig: '', notes: [] };
  try { res.yt = await retry('youtube', () => postYouTube(video.final, meta)); console.log('YouTube ID:', res.yt); }
  catch (e) { res.notes.push(`YT:${e.quota ? 'QUOTA (retry next run)' : 'FAIL'} ${e.message.slice(0, 120)}`); note('error', `YouTube failed: ${e.message}`); }
  try { res.ig = await postInstagram(video.final, meta); console.log('Instagram ID:', res.ig); }
  catch (e) { res.notes.push(`IG:FAIL ${e.message.slice(0, 120)}`); note('error', `Instagram failed: ${e.message}`); }

  const status = res.yt && res.ig ? 'OK' : res.yt || res.ig ? `PARTIAL ${res.notes.join(' | ')}` : `FAILED ${res.notes.join(' | ')}`;
  await logRow({ date: new Date().toISOString(), idea: content.topic, script: video.voiceText, yt: res.yt, ig: res.ig, status });
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## ${status.split(' ')[0]}: ${content.topic}\n\n| Platform | Result |\n|---|---|\n| YouTube | ${res.yt ? `https://youtube.com/shorts/${res.yt}` : 'not posted'} |\n| Instagram | ${res.ig ? `media ${res.ig}` : 'not posted'} |\n\n${res.notes.length ? '**Errors**\n\n' + res.notes.map((n) => `- ${n}`).join('\n') + '\n' : ''}`);
    } catch { /* summary is best-effort */ }
  }
  if (!res.yt && !res.ig) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
