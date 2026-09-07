# Getting started with Aspire and Dev Containers

Build apps with JavaScript/TypeScript, Python, .NET, or a mix of languages using [Aspire](https://aspire.dev). This repository template provides a ready-to-use development environment for Visual Studio Code Dev Containers and GitHub Codespaces, without choosing an application language or framework for you.

## What's included

The container uses an Ubuntu 24.04 base image, with language tooling installed as Dev Container Features:

| Tooling | Purpose |
| --- | --- |
| Aspire CLI and VS Code extension | Orchestrate and debug your app's services |
| Docker-in-Docker | Run containers for databases, caches, and other dependencies |
| Node.js LTS and npm | Develop JavaScript and TypeScript apps |
| Python and uv | Develop Python apps and manage packages and virtual environments |
| .NET 10 SDK and C# Dev Kit | Develop .NET apps |
| PowerShell | Run cross-platform automation scripts |

VS Code includes JavaScript/TypeScript support, with ESLint, Python, and Pylance extensions installed alongside the .NET tooling.

## Get started

1. [Create a repository from this template](https://github.com/new?template_name=aspire-devcontainer&template_owner=microsoft).
2. Open it in GitHub Codespaces, or clone it and select **Dev Containers: Reopen in Container** in VS Code. Local development requires Docker and the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers).
3. Run `aspire new` in the container terminal to choose an app template, or bring your existing services into the repository.

For more guidance, see:

- [Aspire and GitHub Codespaces](https://aspire.dev/get-started/github-codespaces/)
- [Aspire and Visual Studio Code Dev Containers](https://aspire.dev/get-started/dev-containers/)

## Customize your environment

Edit [`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) to change language versions, add tooling, or remove features you don't need. Rebuild the container after changing its configuration. The [Dev Container configuration reference](https://containers.dev/implementors/json_reference/) describes the available options.

The template does not run a language-specific restore command. Install your app's dependencies with its package manager, such as `npm install`, `uv sync`, or `dotnet restore`.

The container configures HTTPS development certificates at startup through Aspire, independent of your app's language:

```sh
aspire certs trust --non-interactive
```

Aspire stores these certificates under `~/.aspnet/dev-certs/trust`. The container's remote environment includes this directory in `SSL_CERT_DIR` so OpenSSL-based tools such as `curl` can verify HTTPS endpoints from the container terminal.

Trust inside the container does not automatically make your host browser trust the certificate. Follow the [Dev Containers HTTPS guidance](https://aspire.dev/get-started/dev-containers/) for local browser setup.

> [!NOTE]
> Once you have created your repository from this template please remember to review the included files such as `LICENSE`, `CODE_OF_CONDUCT.md`, `SECURITY.md` and this `README.md` file to ensure they are appropriate for your circumstances.

## CI checks

The [Devcontainer workflow](.github/workflows/devcontainer.yml) runs on pull requests, pushes to `main`, and manual dispatch. It starts the actual devcontainer and runs [smoke checks](.github/scripts/smoke-test.mjs) before and after stopping and reopening it.

The checks cover non-root workspace access, installed tooling, certificate trust from the startup hook, Docker-in-Docker, a compiled .NET console app, and an Aspire app with a TypeScript AppHost, Python API, React frontend, and Redis. HTTPS requests verify certificates normally; the checks do not bypass TLS validation. Sample projects are created inside the container, not in the repository. VS Code extension installation and editor/debugger behavior are not covered.

To run the same checks locally with Docker running:

```sh
npx --yes --package @devcontainers/cli@0.89.0 devcontainer up --workspace-folder . --mount-workspace-git-root false --no-lockfile
npx --yes --package @devcontainers/cli@0.89.0 devcontainer exec --workspace-folder . node .github/scripts/smoke-test.mjs
```

To check restart behavior, stop the container identified by the `up` output, then run both commands again. The smoke script stops its Aspire app; the devcontainer remains running for further use.

## Code of Conduct

This project has adopted the code of conduct defined by the Contributor Covenant
to clarify expected behavior in our community.

For more information, see the [.NET Foundation Code of Conduct](https://dotnetfoundation.org/code-of-conduct).
