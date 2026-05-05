# Dumb Links

VS Code extension which resolves relative links, with support for symbols and
search.

> [!NOTE]
>
> WIP: the basic logic works, but there is no test, and the documentation will
> likely change. It is also both too permissive (it will resolve anything that
> looks like a link) and too strict (it will yield errors if a symbol cannot be
> resolved).

## Examples

These can be clicked with the extension loaded.

- `./README.md#Supported-paths`

- `src/extension.ts#activate`

- `//src/extension.ts#LinkResolver.scanLines`

- `//src/extension.ts:5`

- `//src/extension.ts:9:10`

- `//README.md#:~:text=resolves%20relative%20links`

## Syntax

### Supported paths

- `src/extension.ts` (requires at least one `/`)

  - Can be disabled by setting
    [`dumbLinks.overrides.implicit.enable`](vscode://settings/dumbLinks.overrides)
    to `false`.

- `./README.md`

  - Can be disabled by setting
    [`dumbLinks.overrides.relative.enable`](vscode://settings/dumbLinks.overrides)
    to `false`.

- `//README.md` (uses the _first_ workspace folder)

  - Can be disabled by setting
    [`dumbLinks.overrides.absolute.enable`](vscode://settings/dumbLinks.overrides)
    to `false`.

### Supported suffixes

- [`#:~:text=Fragment`](https://developer.mozilla.org/docs/Web/URI/Reference/Fragment/Text_fragments)

- `#Symbol.path` (uses VS Code's symbol provider)

- `:1:2` (column may be omitted)

## Building

```sh
$ pnpm install
$ pnpm run package-vsix
```
