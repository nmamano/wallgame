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

## Docker (Optional - for local testing)

To test the production Docker image locally:

```sh
docker build -t bunapp .
docker run -p 3000:3000 bunapp
```

This can be used to:

- Verify the Docker build works
- Test the containerized app matches production
- Debug Docker-specific issues (if `fly deploy` fails, build locally to see errors faster)
- If you want to run it in a container instead of `bun run dev`

## Fly.io deployment

Deployment dashboard: https://fly.io/apps/wallgame

The app is deployed on fly.io at https://wallgame.fly.dev

The app was initialized with:

```sh
fly launch
```

To deploy a new version:

```sh
fly deploy
```

This builds the Docker image automatically.

Upload secrets to fly (you need to redeploy after updating the secrets):

```sh
fly secrets import < .env.prod
fly deploy
```

## Neon database

Database dashboard: https://console.neon.tech/app/projects/delicate-rice-01864210

Verify the database schema:

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
