Read README.md to understand the project. Read DESIGN.md to understand the technical design, then the docs/*.md files it lists for the area you are working on.

Before running `bun run dev`, check for a dev server that is already running for this repository (`pgrep -af 'vite dev'`, and look for this repository's path). If there is one, reuse it, because it hot-reloads from the working tree. Never stop a dev server you didn't start.
