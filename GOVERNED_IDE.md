# Governed IDE

This repository is an Eclipse Theia IDE product, based on the official Theia Blueprint.

## What was added

`theia-extensions/product/src/browser/governance-widget.tsx` defines a native Theia view named **Governance**. It contains a test agent chat, a controlled action card, policy checks, and an approval interaction. The UI does not run commands, access a server, or use credentials.

Use **View → Open Governance Panel** after starting the browser application to display it. The panel is added to the right side of the IDE, next to the normal editor, terminal, explorer, Git, and debug features provided by Theia.

## Local development

The current Blueprint requires Node.js 24+ and Yarn Classic.

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
corepack enable
corepack prepare yarn@1.22.22 --activate
yarn
yarn build:dev
yarn browser start
```

Open `http://localhost:3000`.

## Next implementation step

Keep the widget as a thin client. Add a backend service exposing only a declarative `request_action` API; it should call policy checks and issue short-lived runner capabilities, never hand SSH passwords or long-lived secrets to the agent.
