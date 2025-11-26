Husky is setup like this:

```
bun add -D husky
mkdir -p .husky
git config core.hooksPath .husky
```

Then this is necessary:

```
chmod +x .husky/pre-push
```

Now, the command:

```
git config core.hooksPath
```

Should output `.husky`.


The current setup checks
- formatting, linting, and tests on commit.
- formatting, linting, tests, and build before pushing.

The scripts can be run directly with:

```
./husky/pre-commit
```
