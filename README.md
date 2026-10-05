# Psychology Shorts Bot

Faceless Short/Reel, three a day, for **Human Psychology Tricks**.
Topic → script → b-roll (Pexels or Higgsfield) + ElevenLabs voice + ffmpeg captions → **YouTube + Instagram via Composio** → log row.

Output: 1080x1920, under 90 s and 100 MB, bold white captions with black stroke at bottom center. YouTube: public, category 26, `#Shorts` in the title. If one platform fails the other still posts. YouTube quota errors are not retried until the next run.

## Deploy (posts while your phone is off)
GitHub Actions runs in the cloud, so once the repo has the secrets below, nothing depends on your phone or computer.

1. Open the repo: Settings > Secrets and variables > Actions > New repository secret.
2. Required secrets: `PEXELS_API_KEY`, `ELEVENLABS_API_KEY`, `COMPOSIO_API_KEY`. For Instagram also set `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL` (and `S3_ENDPOINT` for R2/B2). Optional: `ANTHROPIC_API_KEY`, `COMPOSIO_USER_ID`, `ELEVENLABS_VOICE_ID`, `IG_USER_ID`, `HF_*`, `LOG_MODE`, `SHEET_ID`, `SHEET_NAME`. See `.env.example` for what each one does.
3. Test: Actions > Daily Short > Run workflow with **dry_run** ticked. It builds the video without uploading. Then run it once without dry_run.

Scheduled workflows only run from the default branch (`main`). GitHub also pauses scheduled workflows on public repos after 60 days with no repo activity. If posts stop, open the Actions tab and re-enable the workflow.
Since the repo is public, run artifacts (videos, logs) are publicly downloadable. Secrets are never exposed.

## Local run
1. `npm install`, copy `.env.example` to `.env`, fill in keys.
2. `npm run schemas` fetches the live Composio schemas and checks them against `tools.js`.
3. `DRY_RUN=1 npm start` builds a video without uploading (needs `ffmpeg` + `ffprobe`). `npm start` posts for real.

## Reading a failed run
Errors show as red annotations on the run page and the run summary lists the YouTube link, the Instagram media id and any errors. Typical causes:
- *Missing required secrets*: the three required secrets are not set.
- *YouTube QUOTA*: daily API quota used up; the next run tries again.
- *IG: Hosted video not reachable*: check `S3_PUBLIC_BASE_URL` and the bucket's public access.
- *Composio errors*: reconnect the account in Composio and check `COMPOSIO_USER_ID`.

## Schedule: 3 posts a day
`.github/workflows/daily.yml` has three cron lines (GitHub cron is always UTC):

| Cron (UTC) | Morocco time (UTC+1) |
|---|---|
| `0 12 * * *` | **1 PM** |
| `0 18 * * *` | **7 PM** |
| `0 21 * * *` | **10 PM** |

- **Ramadan:** Morocco moves to UTC+0, so every post lands one hour earlier on the Morocco clock (21:00 UTC becomes 9 PM). To keep the same local times, add 1 to each cron hour for that period.
- **No overlap:** `concurrency: group: shorts-bot` makes runs queue instead of posting in parallel. Manual and scheduled runs share the queue.
- **Random delay:** scheduled runs wait a random 0 to 5 minutes before starting (`MAX_START_DELAY_MIN`, default 5; `0` disables). Manual "Run workflow" runs skip it. Posts can land up to 5 minutes after the cron time, plus GitHub's own cron lag of 5 to 30 minutes.
- **Quotas:** 3 uploads a day is about 4,800 of YouTube's default 10,000 daily API units (one upload is about 1,600). A quota error is logged and not retried until the next run.

## One different topic per run
Every run reads `logs/runs.jsonl` (written together with `logs/runs.csv`, same rows) and:
- passes **today's topics** and the last 60 to Claude, rejects any repeat, and retries up to 3 times (with `ANTHROPIC_API_KEY`);
- otherwise picks a built-in script **not used today**, least recently used first.

Only 4 built-in scripts exist, so at 3 posts a day they repeat after about a day and a half. Set `ANTHROPIC_API_KEY` for fresh topics every run.
Each run gets its own video file name (`short-<date>T<time>.mp4`), so runs never overwrite each other. On GitHub, `logs/` is carried between runs by a cache, so the history survives.

## Composio tools used (verified against live schemas)
| Step | Slug | Key args |
|---|---|---|
| YouTube upload | `YOUTUBE_MULTIPART_UPLOAD_VIDEO` (fallback `YOUTUBE_UPLOAD_VIDEO`) | title, description, tags, categoryId, privacyStatus, videoFile / videoFilePath |
| IG account id | `INSTAGRAM_GET_USER_INFO` | ig_user_id (`me`) |
| IG container | `INSTAGRAM_POST_IG_USER_MEDIA` | ig_user_id, media_type `REELS`, video_url, caption, share_to_feed, thumb_offset `0` |
| IG publish | `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` | ig_user_id, creation_id, max_wait_seconds (it waits for processing itself) |
| Sheets | `GOOGLESHEETS_GET_SHEET_NAMES`, `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` | spreadsheetId, range, values |

`COMPOSIO_USER_ID` must be the user id your connections were created under. Local file paths are uploaded by the SDK automatically.
If Composio changes a schema, `npm run schemas` prints a diff and exits non-zero. The workflow runs it before every post (non-blocking).

## Logging: two modes
Every run writes one row: **Date | Idea | Script | YT ID | IG ID | Status**.

1. **File mode (default, `LOG_MODE=file`)**: the row goes to `logs/runs.csv` and `logs/runs.jsonl`. GitHub keeps both as a 7-day artifact, and a cache carries them from run to run so topic history survives.
2. **Sheets mode (`LOG_MODE=composio`)**: the CSV row is still written, and the row is also appended to your Google Sheet through Composio.
   - Set `LOG_MODE=composio` and `SHEET_ID` (the long id in the sheet URL). `SHEET_NAME` is optional and defaults to the first tab.
   - Connect **Google Sheets** in your Composio account first, under the same `COMPOSIO_USER_ID`.
   - If `SHEET_ID` is empty or the append fails, the run does not fail. You still get the CSV row.

## Instagram needs a public video URL
Instagram downloads the MP4 from a URL, so the bot uploads it to your bucket first.

Env: `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL` (plus `S3_ENDPOINT` for R2, B2 or MinIO).

What the script does:
- Uploads with `public-read`. If the bucket rejects ACLs, it uploads without one.
- Uses `S3_PUBLIC_BASE_URL/<key>` as the URL. If that URL isn't reachable, it uses a 1-hour signed URL instead.
- Passes the URL to Composio as `video_url`. After publishing it deletes the object.
- If no `S3_*` is set at all, it passes the file to Composio's `video_file` option, which hosts it temporarily.

Bucket setup:
- **AWS S3**: new buckets block ACLs and public access. Either allow public reads on prefix `reels/` (Object Ownership: ACLs enabled, Block Public Access off for that rule), or keep the bucket private and leave `S3_PUBLIC_BASE_URL` empty so signed URLs are used.
- **Cloudflare R2**: no ACLs. Enable the bucket's public `r2.dev` URL or a custom domain, and set that as `S3_PUBLIC_BASE_URL`. Or leave it empty to use signed URLs.

**7-day auto-delete (do this once):**
- *S3*: bucket → Management → Create lifecycle rule → prefix `reels/` → Expire current versions after **7 days**.
- *R2*: bucket → Settings → Object lifecycle rules → add rule → prefix `reels/` → Delete uploaded objects after **7 days**.
- *B2*: bucket → Lifecycle Settings → keep only the last version, delete after 7 days.

The cover is the first frame (`thumb_offset: 0`). If Instagram shows `%23` in captions instead of `#`, set `IG_ENCODE_HASHTAGS=1`.

## Script / topic (LLM)
- With `ANTHROPIC_API_KEY`: every run Claude picks a fresh viral Human Psychology Tricks topic and writes a 95-115 word script (about 2 s hook → 3 tricks → CTA). It avoids your last 30 topics and retries if the length is off.
- Without it, 4 built-in scripts (90-95 words, about 36-38 s) rotate daily.

## Video source
- Default: **Pexels** portrait b-roll.
- With `HF_API_KEY`: **Higgsfield** text-to-video generates the clips instead. Use `HF_API_KEY=<key_id>:<secret>`, or `HF_API_KEY` plus `HF_API_SECRET`. `HF_MODEL` defaults to `wan/v2.7/text-to-video` and `HF_MAX_CLIPS` (default 6) caps how many 5 s clips are billed; clips are cycled to fill the voiceover. Extra request fields can go in `HF_EXTRA_JSON`. Any Higgsfield failure falls back to Pexels for that run.
- Check that the model you choose is enabled on your Higgsfield account.

## Retention
`output/` videos are deleted after 7 days. On GitHub the runner is temporary, so videos and logs are kept as 7-day run artifacts.
