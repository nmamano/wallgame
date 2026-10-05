# wallgame

Build walls and outsmart your opponents.

## Local development

For the server:

```sh
bun run dev
```

For the frontend:

```sh
cd frontend
bun run dev
```

### Development Architecture

When running locally, you have two servers:

- **Port 5173 (Vite dev server)**: Frontend development server with hot reload
  - Use `http://localhost:5173` for development
  - Vite proxies `/api/*` requests to port 3000
  - Changes to frontend code appear instantly

- **Port 3000 (Backend server)**: Serves both API routes and frontend static files
  - API routes: `/api/puzzles`, `/api/login`, etc.
  - Frontend static files: Serves from `frontend/dist` (production build)
  - Visiting `http://localhost:3000` shows the production build, not the dev version

**Important**: During development, use `http://localhost:5173` for the frontend. The backend on port 3000 serves the production build from `frontend/dist`, which may be stale. To update the production build, run `cd frontend && bun run build`.

In production, the backend serves everything from a single port (3000), matching the behavior you see when visiting `localhost:3000` locally (with an updated production build).

## Docker (Optional - for local testing)

To test the production Docker image locally:

```sh
docker build -t bunapp .
docker run -p 3000:3000 bunapp
```

This can be used to:

- Verify the Docker build works
- Test the containerized app matches production
- Debug Docker-specific issues (if an image build fails, build locally to see errors faster)
- If you want to run it in a container instead of `bun run dev`

## Deployment and database

Production runs on a VPS with Docker, Caddy and PostgreSQL. The live site is
https://wallgame.io. Operators must read the private
`ops-private/wallgame-vps-production-20261005.md` runbook before deployment or
database work. Deploys and production writes require explicit approval.

Use a separate local database for development and tests. `bun run migrate` applies
migrations to the database selected by `DATABASE_URL`; check the target first.
Previous platform procedures are kept only in
`ops-private/OBSOLETE-fly-neon-rollback/`.

### Verify the database schema

You can do:

```sh
DATABASE_URL="postgresql://..." bunx drizzle-kit studio
```

Then open:

https://local.drizzle.studio

## Testing API endpoints

```plaintext
$ curl http://localhost:3000/api/puzzles
{"puzzles":[{"id":1,"title":"arst","author":"arst","rating":33}]}
Nilo@DESKTOP-053VVPL MINGW64 ~/repos/wallgame (main)

$ curl http://localhost:3000/api/puzzles/count
{"count":1}

$ curl -X POST http://localhost:3000/api/puzzles   -H "Content-Type: app
lication/json"   -d '{"title":"Test Puzzle 2","author":"You","rating":20
0}'
[{"id":2,"title":"Test Puzzle 2","author":"You","rating":200}]
```

## Kinde auth

The kinde dashboard is at: https://wallgame.kinde.com/admin/

Domain: https://wallgame.kinde.com

It is configured in .env and .env.prod. The difference is in the URLs.

Allowed callback URLs:
http://localhost:5173/api/callback
https://wallgame.io/api/callback

Allowed logout redirect URLs:
http://localhost:5173
https://wallgame.io
