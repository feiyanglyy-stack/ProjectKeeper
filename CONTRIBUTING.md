# Contributing

Thank you for looking. ProjectKeeper is at v0.1 and has been used on few projects so far: a report of what it did on yours — where the picture was wrong, what it missed, what it cost — is as useful as code.

## Run it

You need Node.js 24 or later, and git.

```sh
npm ci
npm run demo        # an invented, organized project at http://127.0.0.1:4880/ — no key, no network
npm start           # the workbench at http://127.0.0.1:4870/
```

There is no build step. Node runs the TypeScript sources directly, and the workbench is plain JavaScript.

While developing, keep your work away from your real ProjectKeeper folder: give a scratch folder as the home, and another port.

```sh
npm start -- --home ./scratch-home --port 4871
```

Add `--fake-provider` to serve with a local stand-in for the model, which is how the demo answers without a key.

## Test it

```sh
npm run typecheck   # tsc, no output files
npm test            # about 1,160 tests, about two minutes; no network, no keys
```

One test file: `node --test src/model/vocab.test.ts`.

- Tests sit beside the code as `*.test.ts` and use Node's own test runner.
- A test must not need the network, a key, or anything outside the temporary folders it makes.
- The browser checks (`scripts/ui-*-check.mjs`) drive headless Chrome against a served fixture; the header of each says how to run it. They need Chrome (`CHROME_PATH` names it) and are not part of `npm test`.
- A test that compares the paths ProjectKeeper reports with the ones it made takes its temporary directory from `src/util/tmp.test-helpers.ts`, not from `os.tmpdir()`: ProjectKeeper keeps paths in the file system's own spelling, and the temporary directory is often given in another (a short `RUNNER~1` name on a CI runner). `src/qc/path-spelling.test.ts` is where the other spellings are tried on purpose.
- A test that makes commits gives git an identity itself (`-c user.name=… -c user.email=…`, or the `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables): CI has none configured.
- CI runs the typecheck and the tests on Windows, the only platform ProjectKeeper 0.1 supports. The suite fails on Linux and has never been run on macOS; changes that make it pass on either are welcome.

## What a good issue looks like

**A bug:**

- what you did, what you expected, what happened;
- your operating system, Node version, and the commit of ProjectKeeper;
- the model and provider, if a round was involved;
- for a round that went wrong: which step, as `Keeper activity` shows it, and the text of the step if you can share it.

**A wrong picture** (the most useful kind of report):

- what the workbench shows, and what your project's material actually says — the object, and the document, commit or session that contradicts it;
- whether the object is marked `Inferred`;
- the depth and the models of the takeover.

**Please leave out** keys, and anything from your project you would not publish. Screenshots of the workbench show your project's content; crop them.

**An idea:** say what you were trying to find out about your project and could not. That is more useful than a feature list.

## Sending a change

1. Open an issue first for anything larger than a fix, so the direction can be agreed before you spend the time.
2. Keep a pull request to one change. Say what it changes for a user, and how you checked it.
3. `npm run typecheck` and `npm test` pass.
4. Add or adjust a test when behaviour changes.

Conventions the code keeps:

- **LF line endings, UTF-8, two spaces** (`.editorconfig`).
- **TypeScript that Node can run by stripping types**: no enums, no namespaces, no parameter properties; imports name the `.ts` file.
- **A program does what a program can.** If something can be counted, checked or looked up exactly, write code for it rather than asking the model. See [How the Keeper works](docs/how-the-keeper-works.md).
- **Text the model reads** — skills, tool descriptions, refusals — is plain and self-contained: it must make sense to a model that has never seen this repository's history.
- **Fixtures are invented.** No material from a real private project goes into the repository.
- **Comments say why**, in full sentences.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence of this repository ([LICENSE](LICENSE)). The themes under `ui/themes/` have their own terms ([ui/themes/LICENSE.md](ui/themes/LICENSE.md)).

## Conduct

Be kind and specific. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
