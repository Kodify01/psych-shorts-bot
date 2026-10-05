// Composio tool slugs + the exact argument names this project sends.
// Verified against live Composio schemas (see `npm run schemas`, which re-checks them on demand).
export const T = {
  YT_MULTIPART: 'YOUTUBE_MULTIPART_UPLOAD_VIDEO',
  YT_UPLOAD: 'YOUTUBE_UPLOAD_VIDEO', // fallback
  IG_USER: 'INSTAGRAM_GET_USER_INFO',
  IG_CONTAINER: 'INSTAGRAM_POST_IG_USER_MEDIA',
  IG_PUBLISH: 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH',
  SHEETS_NAMES: 'GOOGLESHEETS_GET_SHEET_NAMES',
  SHEETS_APPEND: 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND',
};

// required = args the live schema marks required; sends = every arg automation.js may pass
export const EXPECTED = {
  [T.YT_MULTIPART]: { required: ['title', 'description', 'categoryId', 'privacyStatus', 'videoFile'], sends: ['title', 'description', 'tags', 'categoryId', 'privacyStatus', 'videoFile'] },
  [T.YT_UPLOAD]: { required: ['title', 'description', 'tags', 'categoryId', 'privacyStatus', 'videoFilePath'], sends: ['title', 'description', 'tags', 'categoryId', 'privacyStatus', 'videoFilePath'] },
  [T.IG_USER]: { required: [], sends: ['ig_user_id'] },
  [T.IG_CONTAINER]: { required: ['ig_user_id'], sends: ['ig_user_id', 'media_type', 'video_url', 'video_file', 'caption', 'share_to_feed', 'thumb_offset'] },
  [T.IG_PUBLISH]: { required: ['ig_user_id', 'creation_id'], sends: ['ig_user_id', 'creation_id', 'max_wait_seconds', 'poll_interval_seconds'] },
  [T.SHEETS_NAMES]: { required: ['spreadsheet_id'], sends: ['spreadsheet_id'] },
  [T.SHEETS_APPEND]: { required: ['spreadsheetId', 'range', 'valueInputOption', 'values'], sends: ['spreadsheetId', 'range', 'valueInputOption', 'insertDataOption', 'values'] },
};
