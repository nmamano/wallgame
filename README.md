# wallgame

Build walls and outsmart your opponents.

## Docker

To build the docker image:

```sh
docker build -t bunapp .
docker run -p 3000:3000 bunapp
```

## Fly.io deployment

The app is deployed on fly.io at https://wallgame.fly.dev

To deploy a new version:

```sh
fly deploy
```

The app was initialized with:

```sh
fly launch
```
