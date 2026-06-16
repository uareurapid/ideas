# Business Ideas - Historical Archive

This folder contains AI-generated business ideas for mobile apps and SaaS products.

## Format

Files are named by date: `YYYY-MM-DD.md`

## Generation Schedule

**Cron Job:** "Business Ideas Generator - Even Days"
- **Runs:** 11:00 AM (Lisbon time) on even-numbered days (2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30)
- **Delivers:** Telegram notification
- **Saves:** Automatically to this folder

## Sources

Ideas are researched from:
- Reddit: r/AppIdeas and r/SomebodyMakeThis
- Indie Hackers discussions
- Product Hunt recent launches (gap analysis)
- Review platforms (G2, Capterra) - common complaints

## Criteria

- Simple ideas that solve everyday problems
- Underrepresented niches
- Real pain points people are talking about right now
- Concise descriptions (2-3 sentences per idea)

## View History

```bash
ls -ltr /Users/paulocristo/workspace/mines/BUSINESS_IDEAS/*.md
```

## Recent Ideas

```bash
tail -30 /Users/paulocristo/workspace/mines/BUSINESS_IDEAS/*.md
```

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Start the app server:

```bash
npm start
```

3. Open:

```text
http://localhost:3737
```

## Shared Voting (SQLite)

- Votes are now shared across visitors and persisted in a local SQLite database.
- Database file: `votes.sqlite` (plus WAL/SHM sidecar files).
- One anonymous visitor token is stored in an HttpOnly cookie.
- For each visitor + idea + metric, only the latest vote is kept.
- Setting a metric to 0 clears that metric vote for the current visitor.
- Community stats shown in the UI:
	- Overall score per idea
	- Total unique voters per idea

### API Endpoints

- `GET /api/votes` - Fetch visitor ratings + community aggregates
- `POST /api/vote` - Upsert/clear one metric vote
- `POST /api/votes/migrate` - One-time localStorage migration for legacy ratings

### Optional Environment Variables

- `PORT` (default: `3737`)
- `VOTES_DB_PATH` (default: `./votes.sqlite`)
- `VOTER_COOKIE_NAME` (default: `biz_voter`)
- `VOTER_COOKIE_MAX_AGE_S` (default: one year)
- `VOTER_COOKIE_SECURE` (`1` to add `Secure` cookie flag)
- `VOTE_RATE_LIMIT_WINDOW_MS` (default: `60000`)
- `VOTE_RATE_LIMIT_MAX_WRITES` (default: `90`)

## Visitor Submissions + Moderation

- Visitors can submit ideas directly from the app UI.
- Required fields: nickname, title, description, category.
- Allowed category values: `general`, `developer`, `mobile`.
- Optional field: contact info.
- Policy: one submission per anonymous visitor identity per 24-hour window (default).
- New submissions are stored as `pending_approval`.
- Admin can approve/reject from the in-app Moderation Board.
- Approved submissions are published instantly from SQLite (no regenerate step needed).

### Submission/Moderation API Endpoints

- `GET /api/health` - Deployment health check + admin configured flag
- `POST /api/submissions` - Create pending submission
- `GET /api/submissions/approved` - Public approved submissions feed (idea-like payloads)
- `GET /api/admin/me` - Admin session check
- `POST /api/admin/login` - Admin login
- `POST /api/admin/logout` - Admin logout
- `GET /api/admin/submissions` - Admin queue listing (`status=pending_approval|approved|rejected|all`, `category=all|general|developer|mobile`)
- `POST /api/admin/submissions/:id/approve` - Approve + publish submission
- `POST /api/admin/submissions/:id/reject` - Reject submission

## Environment Configuration (`.env` is optional)

- `server.js` auto-loads `.env` if present.
- If a variable is missing, built-in defaults are used.
- Start from `.env.example` and customize only what you need.

### Production Deployment (Single Host)

This project is now prepared to run frontend + backend together in one Node service (no Netlify required).

#### Files included for deployment

- `render.yaml` blueprint for Render Web Service + persistent disk
- `Dockerfile` for container-based deployment
- `.dockerignore` for slimmer image builds

### Manual Steps (Render Dashboard)

1. Push the latest code to your Git provider.
2. In Render, choose **New +** -> **Web Service**.
3. Select this repository and branch.
4. Use:
	- Build Command: `npm ci`
	- Start Command: `npm start`
5. In service settings, add a persistent disk:
	- Mount path: `/var/data`
	- Size: `1 GB` (or more)
6. Set these environment variables:
	- `HOST=0.0.0.0`
	- `VOTES_DB_PATH=/var/data/votes.sqlite`
	- `ADMIN_USERNAME=<your-admin-username>`
	- `ADMIN_PASSWORD=<your-admin-password>`
	- `VOTER_COOKIE_SECURE=1`
	- `ADMIN_COOKIE_SECURE=1`
7. Deploy the service.
8. Validate deployment:
	- `https://YOUR_RENDER_DOMAIN/api/health`
	- `https://YOUR_RENDER_DOMAIN/api/admin/me`
9. Open `https://YOUR_RENDER_DOMAIN/` and test:
	- submit idea
	- admin login
	- approve/reject flow

### Manual Steps (Docker, Any Host)

1. Build image:

```bash
docker build -t business-ideas .
```

2. Run container with persisted data volume:

```bash
docker run -d \
  --name business-ideas \
  -p 3737:3737 \
  -e HOST=0.0.0.0 \
  -e PORT=3737 \
  -e VOTES_DB_PATH=/data/votes.sqlite \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=change-me \
  -e VOTER_COOKIE_SECURE=0 \
  -e ADMIN_COOKIE_SECURE=0 \
  -v $(pwd)/data:/data \
  business-ideas
```

3. For HTTPS production behind a real domain, set:
	- `VOTER_COOKIE_SECURE=1`
	- `ADMIN_COOKIE_SECURE=1`

### Post-deploy checks

1. Open `/api/health` and confirm `ok: true`.
2. Verify `/api/admin/me` returns JSON (not HTML error page).
3. Submit one visitor idea.
4. Login in Moderation Board and approve it.
5. Confirm approved idea appears immediately in the grid.
6. Confirm voting sync from two browsers/devices.

### Additional Optional Variables

- `HOST` (default: `0.0.0.0`)
- `ADMIN_USERNAME` (default: empty, moderation login disabled)
- `ADMIN_PASSWORD` (default: empty, moderation login disabled)
- `ADMIN_COOKIE_NAME` (default: `biz_admin`)
- `ADMIN_SESSION_TTL_S` (default: `43200`)
- `ADMIN_COOKIE_SECURE` (`1` to add `Secure` flag)
- `ADMIN_SESSION_CLEANUP_MS` (default: `600000`)
- `SUBMISSION_DAILY_LIMIT` (default: `1`)
- `SUBMISSION_WINDOW_MS` (default: `86400000`)
- `SUBMISSION_TITLE_MAX` (default: `140`)
- `SUBMISSION_NICK_MAX` (default: `40`)
- `SUBMISSION_DESC_MAX` (default: `1600`)
- `SUBMISSION_CONTACT_MAX` (default: `120`)

## GitHub Automation

- Workflow file: `.github/workflows/generate-ideas.yml`
- Triggers:
	- push to `main`
	- manual `workflow_dispatch`
- Behavior:
	- runs `node generate.js`
	- commits/pushes updated `data.js` only when it changes
	- ignores bot re-runs to avoid looped commits

---

**Last Updated:** 2026-05-21
