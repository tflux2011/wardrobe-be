# Wardrobe Backend

Node.js + TypeScript API for the Wardrobe app. This service handles clothing image tagging, multi-item split detection, outfit suggestions, stylist chat, and serving uploaded images.

## Stack

- Express
- TypeScript
- Anthropic SDK
- Sharp
- Multer
- Zod

## What It Does

- Tags a single clothing image with category, colors, style, occasions, seasons, and tags
- Splits a photo containing multiple garments into separate crops and tags each crop
- Generates weather-aware outfit suggestions from the user's wardrobe
- Runs a multi-turn AI stylist chat with wardrobe context
- Serves uploaded images from `/uploads`

## Requirements

- Node.js 18+
- npm
- Anthropic API key
- OpenWeather API key

## Environment Variables

Create a local `.env` file from `.env.example`.

```bash
cp .env.example .env
```

Supported variables:

| Variable | Required | Description |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | Used for image tagging, split-region labeling, outfit suggestions, and stylist chat |
| `OPENWEATHER_API_KEY` | Yes | Used by the client-facing weather flow |
| `FIREBASE_WEB_API_KEY` | Yes | Used by backend middleware to verify Firebase ID tokens from `Authorization: Bearer <token>` |
| `ADMIN_USERNAME` | For admin access | Admin login name; login is disabled when missing |
| `ADMIN_PASSWORD` | For admin access | Admin password; configure a strong unique secret, no default is used |
| `PORT` | No | API port, defaults to `3002` |
| `ALLOWED_ORIGIN` | No | CORS origin, defaults to `*` |
| `RATE_LIMIT_WINDOW_MS` | No | Rate limit window for all `/api/*` routes, defaults to `60000` |
| `RATE_LIMIT_MAX_REQUESTS` | No | Max requests per IP per window on `/api/*`, defaults to `120` |
| `STYLIST_RATE_LIMIT_WINDOW_MS` | No | Rate limit window for `/api/stylist/*`, defaults to `60000` |
| `STYLIST_RATE_LIMIT_MAX_REQUESTS` | No | Max requests per IP per window on stylist routes, defaults to `25` |

Example:

```env
ANTHROPIC_API_KEY=your_anthropic_api_key_here
OPENWEATHER_API_KEY=your_openweather_api_key_here
FIREBASE_WEB_API_KEY=your_firebase_web_api_key_here
PORT=3002
ALLOWED_ORIGIN=*
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=120
STYLIST_RATE_LIMIT_WINDOW_MS=60000
STYLIST_RATE_LIMIT_MAX_REQUESTS=25
```

## Install

```bash
npm install
```

## Run Locally

Development:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm start
```

When running locally, the API starts on:

```text
http://localhost:3002
```

## Scripts

Defined in [package.json](/Users/tobiadeosun/wardrobe/backend/package.json):

- `npm run dev` - start the TypeScript server in watch mode with `tsx`
- `npm run build` - compile TypeScript to `dist/`
- `npm start` - run the compiled server from `dist/index.js`

## API Routes

### Health

`GET /health`

Returns basic service status.

Example response:

```json
{
  "status": "ok",
  "timestamp": "2026-05-03T12:34:56.000Z"
}
```

### Clothing

`POST /api/clothing/upload`

Auth: requires `Authorization: Bearer <Firebase ID token>`

Uploads one image and returns AI-generated tags.

Request:

- `multipart/form-data`
- field name: `image`

`POST /api/clothing/split`

Auth: requires `Authorization: Bearer <Firebase ID token>`

Uploads one image, detects multiple garments, crops them, and tags each detected item.

Request:

- `multipart/form-data`
- field name: `image`

Notes:

- JPEG and PNG only
- 10 MB max upload size
- Split tagging now returns confidence-based review metadata so low-confidence labels can be manually confirmed in the client

### Outfits

`POST /api/outfits/suggest`

Auth: requires `Authorization: Bearer <Firebase ID token>`

Generates outfit suggestions from wardrobe context.

Expected body shape:

```json
{
  "occasion": "casual",
  "weather": {
    "temp": 24,
    "condition": "Clear"
  },
  "wardrobe": []
}
```

### Stylist

`POST /api/stylist/chat`

Auth: requires `Authorization: Bearer <Firebase ID token>`

Runs AI stylist chat with message history and optional wardrobe context.

Expected body shape:

```json
{
  "message": "What should I wear tonight?",
  "history": [],
  "wardrobeContext": []
}
```

## Uploaded Files

Uploaded images are served from:

- `/uploads/<filename>`
- `/uploads/splits/<filename>`

Current behavior:

- files are stored on local disk
- this is fine for local development
- this is not durable for most production hosts

For production, move uploads to persistent object storage such as S3, Cloudinary, or Supabase Storage.

## AI Labeling Behavior

The labeling system currently uses Anthropic `claude-sonnet-4-20250514` for:

- garment region detection
- clothing tagging
- outfit suggestions
- stylist chat

To reduce hallucinated labels, the backend includes:

- conservative category normalization
- blocked undergarment label terms
- category hints during split tagging
- confidence and `needsReview` metadata for low-confidence outputs

## Deployment Notes

This backend is ready for simple Node hosting.

Typical settings for Render or Railway:

- Root directory: `backend`
- Build command: `npm install && npm run build`
- Start command: `npm start`

Make sure these environment variables are configured in the host:

- `ANTHROPIC_API_KEY`
- `OPENWEATHER_API_KEY`
- `PORT`
- `ALLOWED_ORIGIN`

## Security Notes

- Never commit `.env`
- Keep `.env.example` as the template only
- Rotate any secrets that were previously committed
- Restrict `ALLOWED_ORIGIN` in production

## Project Structure

```text
backend/
├── src/
│   ├── index.ts
│   ├── routes/
│   │   ├── clothing.ts
│   │   ├── outfits.ts
│   │   └── stylist.ts
│   └── services/
│       └── claude_service.ts
├── .env.example
├── package.json
└── tsconfig.json
```
## Photo-referenced mannequin previews

`POST /api/images/outfit/reference` accepts the existing prompt, wardrobeContext
(with saved garment IDs), and styleProfile fields. The authenticated server loads
every garment photograph from that user's wardrobe. Missing or unavailable
items stop generation; text-only/provider fallback is deliberately disabled.

Set `OPENAI_API_KEY` on the backend host. `OPENAI_OUTFIT_IMAGE_MODEL` optionally
overrides the default `gpt-image-2`. The front is generated using all selected
photographs; the back edits that front with the original photographs retained.
The response includes `generationVersion: photo-references-v2` and
`referenceItemIds` so the client can reject older unreferenced results. Allow up
to seven minutes for both views. Back details absent from original photographs
are inferred, so the result remains a visualization rather than a garment scan.

Deploy this backend before installing the updated mobile client. Existing
text-only preview caches are invalidated by the mobile client's v2 cache prefix.
Keep the OpenAI key exclusively on the backend; never bundle it in the app.

## Free beta and private photographs

The API owns all allowances; neither web nor Android can submit a paid flag or usage counter. Defaults are 100 saved clothes, 20 photo attempts/day, 5 new mannequin views/month, 3 generated trip plans/month, 30 other styling requests/day, and 100 MB of tracked private images. UTC periods apply. Cached mannequin views are free. Legacy front-and-back generation reserves two views. Existing clothing records can be edited above the garment cap; adding more requires freeing space. Existing images migrated from public storage are preserved even when they exceed the byte allowance.

PostgreSQL counters and expiring reservations serialize competing requests with transaction-scoped advisory locks. AI failures refund the user reservation; photo attempts count even on failure. Platform work ceilings do not refund failed attempts. `Idempotency-Key` rejects repeat operations; clients should check for a saved result after an interrupted request. No payment provider is enabled.

Release order (Node 22.12+; Node 24 recommended):

1. Back up the database. Apply the additive, idempotent SQL with `npx prisma db execute --schema prisma/schema.prisma --file prisma/releases/20261101_beta_security.sql`. This also restricts direct anonymous database/storage access. The backend database role must bypass RLS.
2. Run `npx tsx src/scripts/prepare_beta.ts` to prepare the private `clad-private` bucket. Keep the existing hosted OpenAI key.
3. Test/build the API and clients. `npx tsx src/scripts/verify_beta.ts` runs real PostgreSQL concurrency tests against a temporary isolated UID, then cleans up its records. No AI calls or emails are sent.
4. Release web/Android clients with `/media/` URL support, then the API. `/health` identifies this release as `beta-security-v1`.
5. Run `npx tsx src/scripts/migrate_private_photos.ts` for an inventory. Set `SECURITY_BACKUP_DIR` to a private local folder and add `--apply` to copy and verify original photo bytes, update owned references, and make the original bucket private only when all references are migrated. Original objects are retained privately until removal/retention cleanup. Failed migrations leave originals accessible rather than silently breaking photographs; resolve failures before opening public signups.

Photo URLs in the database are stable `/media/<id>` references. Authenticated API responses sign those references for 24 hours; download redirects expire after five minutes. Refresh wardrobe data to renew a link. Cache hits do not consume AI allowance. Temporary input files are never public. Cropping uses source photographs, not invented garment reconstructions. All decoded JPEG/PNG input is bounded to 25 million pixels and re-encoded to remove metadata.

Unused uploads and previews are eligible for cleanup after 48 hours; usage-operation audit entries after 90 days. Account/item deletion also attempts removal of migrated originals while respecting shared references. Admin sessions expire after one hour; credential/reset attempts have durable rate caps. Set `ALLOWED_ORIGIN` to additional exact web origins as needed (comma-separated). Avoid `trust proxy: true`; configure only the actual trusted hop count.
