# GIDE

GIDE (Governed IDE) is a development environment built on Eclipse Theia, with a project workbench, agent chat, configurable workflows and policy-controlled tools.

## Features

- Monaco editor and file explorer.
- Projects with multiple connected Git repositories, stored separately from project context.
- ChatGPT connection and a local model through Ollama.
- Editable workflows with result dependencies, user reviews and controlled rework.
- Project tools with named methods and Allow / Ask / Deny access rules.
- File search using bundled ripgrep, batch reads and precise text replacements.
- Task history, selective context and workflow state persisted in SQLite.
- Browser development and an Electron desktop target.

## Requirements

- Node.js 24 or later.
- Yarn Classic 1.22.22.
- Git and the native build prerequisites required by Theia for your platform.

Docker and GitHub CLI are needed only for their respective tools.

## Run in a browser

From the repository root:

```sh
yarn install --frozen-lockfile
yarn --cwd theia-extensions/product build
yarn --cwd applications/browser build
yarn browser start --hostname 127.0.0.1 --port 3000
```

Open http://127.0.0.1:3000/ and create or open a project.

## Tests

```sh
yarn --cwd theia-extensions/product build
yarn --cwd theia-extensions/product test:harness
```

## Desktop development

```sh
yarn desktop:build
yarn electron start
```

To create the current unsigned macOS Apple Silicon package:

```sh
yarn desktop:package
```

## Local data

Application settings, connections and task history live in `~/.governed-ide/`. Project folders hold their own metadata, tools, context, workflows and ChangeSets. Connected repositories remain in their own checkouts.

User projects, credentials, databases, downloaded toolchains, dependencies and generated builds are excluded from Git. Do not add application state or authentication files to this repository.

## Foundation and license

Based on the [Eclipse Theia IDE / Blueprint](https://github.com/eclipse-theia/theia-ide). The original upstream documentation is preserved in [docs/THEIA_BLUEPRINT.md](docs/THEIA_BLUEPRINT.md).

See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for licensing and attribution. Theia is a trademark of the Eclipse Foundation.
