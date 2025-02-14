# Blog

Static site generator for the blog.

Workflow:

1. Write or update a post in markdown in /src/posts/
2. Build the site with `bun run build`
3. The site is built to /\_site/
4. Now, if you run or deploy the backend (at ../), it will serve the blog at /blog.

For hot-reloading during development, you can use `bun run dev`. However, note that some of the URL paths are different in the blog-specific server than the backend server, so some links may be broken (e.g., going back from a post to the main page). That's working as intended.

## Install

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.2. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
