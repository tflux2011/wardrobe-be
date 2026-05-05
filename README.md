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