# wt - Git Worktree Manager

A CLI for managing git worktrees with automatic port offsetting, unique resource naming, and lifecycle hooks. Built for parallel development workflows where you need multiple isolated environments running simultaneously.

## Table of Contents

- [Why wt?](#why-wt)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Port Offsetting](#port-offsetting)
- [Unique Naming](#unique-naming)
- [Hooks](#hooks)
  - [Files Configuration](#files-configuration)
  - [Copy Source Directory](#copy-source-directory)
- [CLI Reference](#cli-reference)
- [Shell Completions](#shell-completions)
- [Real-World Examples](#real-world-examples)
- [JSON Schema for IDE Autocomplete](#json-schema-for-ide-autocomplete)
- [Roadmap](#roadmap)

---

## Why wt?

Git worktrees let you check out multiple branches simultaneously in separate directories. This is powerful for:

- Working on multiple features in parallel
- Running multiple AI coding agents (Claude Code, Cursor, etc.) simultaneously
- Quick context switching without stashing
- Testing changes against different branches

But raw `git worktree` commands are verbose and don't handle the real challenges:

- **Port conflicts**: Each worktree needs different ports for dev servers
- **Resource naming**: Docker containers, databases need unique names per worktree
- **Environment setup**: Copying secrets, installing dependencies, configuring services
- **Cleanup**: Stopping containers, removing resources when done

`wt` solves all of this with a simple config file and automatic environment management.

---

## Installation

```bash
# From the loxel monorepo
cd packages/wt
bun install
bun run build

# Install to your PATH and sign
cp dist/wt ~/.local/bin/
codesign -s - ~/.local/bin/wt

# Verify installation
wt --version
```

---

## Quick Start

### 1. Set up a bare repository

```bash
# Clone as bare repo (recommended for worktree-based workflows)
git clone --bare git@github.com:myorg/myproject.git myproject.git
cd myproject.git

# Create a "main" worktree for reference/copying
git worktree add main main
```

### 2. Create wt.yaml

Create `wt.yaml` in the bare repo root:

```yaml
editor: "code"
worktrees_dir: ".worktrees"
auto_branch: true
base_branch: main

port_offseting:
  offset: 10
  ports:
    PORT: 3000

hooks:
  add:
    files:
      - "**/.env.local" # Copy files as-is
      - template_file: ".env.template" # Process ${VAR} placeholders
        dest: ".env"
    run: |
      npm install
```

### 3. Create worktrees

```bash
wt add feature-auth    # Creates .worktrees/feature-auth, opens VS Code
wt add feature-payments
wt add bugfix-123

wt list                # See all worktrees with their port offsets
```

### 4. Work in parallel

Each worktree has isolated ports:

- `feature-auth`: PORT=3000
- `feature-payments`: PORT=3010
- `bugfix-123`: PORT=3020

### 5. Clean up

```bash
wt remove feature-auth  # Runs clean hook, removes worktree, deletes branch
```

---

## Configuration Reference

Create `wt.yaml` in your bare git repo root:

```yaml
# Editor command to open worktrees
# Examples: 'code', 'cursor', 'zed', 'webstorm', 'nvim'
editor: "code"

# Directory for worktrees relative to this config
worktrees_dir: ".worktrees"

# Automatically open editor after creating worktree
# Can be overridden with --open or --no-open flags
auto_open: true

# Automatically create a new branch when creating a worktree
# Branch name will match the worktree name
auto_branch: true

# Base branch for new worktree branches
base_branch: main

# Port offsetting configuration
port_offseting:
  # Set to false to disable port offsetting entirely
  enable: true

  # Offset increment between worktrees
  # First worktree gets offset 0, second gets 10, third gets 20, etc.
  offset: 10

  # Ports to offset - each becomes an env var in hooks
  ports:
    BACKEND_PORT: 3000
    FRONTEND_PORT: 5173
    POSTGRES_PORT: 5432
    REDIS_PORT: 6379

# Unique naming for resources that need globally unique identifiers
unique_naming:
  # Set to false to disable unique naming
  enable: true

  # Strategy for generating unique names:
  # - 'worktree-name': Normalize worktree name (feature-auth -> feature-auth)
  # - 'random': Random 8-char base62 string starting with a letter
  strategy: worktree-name

  # Environment variables with ${WT_UNIQUE_NAME} and ${WT_PORT_OFFSET} substitution
  envs:
    POSTGRES_CONTAINER_NAME: postgres-${WT_UNIQUE_NAME}
    REDIS_CONTAINER_NAME: redis-${WT_UNIQUE_NAME}
    NGROK_SUBDOMAIN: ${WT_UNIQUE_NAME}
    DATABASE_NAME: myapp_${WT_UNIQUE_NAME}
    COMPOSE_PROJECT_NAME: myapp_${WT_UNIQUE_NAME}_${WT_PORT_OFFSET}

# Source directory for copy hook (default: .wt-local-res)
# Path to directory (relative to repo root, absolute, or ~/...)
copy_source: .wt-local-res

# Lifecycle hooks
hooks:
  # Runs when creating a new worktree
  add:
    # Files to copy/template (source: copy_source setting)
    files:
      - "**/.env.local" # String: copy as-is
      - source: "configs/**" # Copy with custom destination
        dest: "configs/"
      - template_file: ".env.template" # Template with ${VAR} substitution
        dest: ".env"
      - inline_template: | # Inline template content
          PORT=${BACKEND_PORT}
          NAME=${WT_UNIQUE_NAME}
        dest: ".env.ports"

    # Shell script to run after file processing
    run: |
      echo "Setting up worktree $WT_NAME..."
      # Your setup commands here

  # Runs when removing a worktree
  clean:
    run: |
      echo "Cleaning up worktree $WT_NAME..."
      # Your cleanup commands here
```

---

## Port Offsetting

Port offsetting solves the problem of running multiple dev servers simultaneously. Each worktree gets a unique `WT_PORT_OFFSET` value, and configured ports are automatically adjusted.

### How It Works

With `offset: 10`:

| Worktree          | Index | WT_PORT_OFFSET | BACKEND_PORT (base 3000) | FRONTEND_PORT (base 5173) |
| ----------------- | ----- | -------------- | ------------------------ | ------------------------- |
| feature-auth      | 0     | 0              | 3000                     | 5173                      |
| feature-payments  | 1     | 10             | 3010                     | 5183                      |
| bugfix-123        | 2     | 20             | 3020                     | 5193                      |
| feature-dashboard | 3     | 30             | 3030                     | 5203                      |

When you remove a worktree, its index becomes available for reuse.

### Environment Variables

These variables are available in hooks:

| Variable                    | Example                                 | Description                              |
| --------------------------- | --------------------------------------- | ---------------------------------------- |
| `WT_PORT_OFFSET`            | `10`                                    | The raw offset value                     |
| `BACKEND_PORT`              | `3010`                                  | Each configured port with offset applied |
| `WT_ALL_PORTS_OFFSETS`      | `BACKEND_PORT=3010\nFRONTEND_PORT=5183` | All ports as KEY=value lines             |
| `WT_ALL_PORTS_OFFSETS_JSON` | `{"BACKEND_PORT":3010,...}`             | All ports as JSON (for jq)               |

### Usage Examples

#### 1. Append a specific port to .env

```yaml
hooks:
  add:
    run: |
      echo "BACKEND_PORT=$BACKEND_PORT" >> .env
```

#### 2. Append all ports at once

```yaml
hooks:
  add:
    run: |
      echo "$WT_ALL_PORTS_OFFSETS" >> .env
```

This appends:

```
BACKEND_PORT=3010
FRONTEND_PORT=5183
POSTGRES_PORT=5442
```

#### 3. Write to multiple .env files in a monorepo

```yaml
hooks:
  add:
    run: |
      # Backend service
      echo "PORT=$BACKEND_PORT" >> apps/backend/.env
      echo "DATABASE_PORT=$POSTGRES_PORT" >> apps/backend/.env

      # Frontend service
      echo "PORT=$FRONTEND_PORT" >> apps/frontend/.env
      echo "API_URL=http://localhost:$BACKEND_PORT" >> apps/frontend/.env
```

#### 4. Manual offset calculation (if you need a port not in config)

```yaml
hooks:
  add:
    run: |
      # Calculate a custom port based on offset
      CUSTOM_PORT=$((8080 + $WT_PORT_OFFSET))
      echo "CUSTOM_PORT=$CUSTOM_PORT" >> .env
```

#### 5. Use with docker-compose

```yaml
hooks:
  add:
    run: |
      # Create a docker-compose override with correct ports
      cat > docker-compose.override.yml << EOF
      services:
        backend:
          ports:
            - "$BACKEND_PORT:3000"
        frontend:
          ports:
            - "$FRONTEND_PORT:5173"
        postgres:
          ports:
            - "$POSTGRES_PORT:5432"
      EOF
```

#### 6. Configure Vite with the offset port

```yaml
hooks:
  add:
    run: |
      # Update vite.config.ts server port
      cat > vite.config.local.ts << EOF
      export default {
        server: {
          port: $FRONTEND_PORT
        }
      }
      EOF
```

---

## Unique Naming

Some resources need globally unique names on your system - Docker containers, database names, ngrok subdomains, etc. The unique naming feature generates consistent identifiers.

### Strategies

#### `worktree-name` (default)

Normalizes the worktree name:

- Converts to lowercase
- Replaces special characters with hyphens
- Removes leading/trailing hyphens
- Collapses consecutive hyphens

| Worktree Name  | WT_UNIQUE_NAME |
| -------------- | -------------- |
| `feature-auth` | `feature-auth` |
| `Feature_Auth` | `feature-auth` |
| `feature/auth` | `feature-auth` |
| `BUGFIX-123`   | `bugfix-123`   |

#### `random`

Generates a random 8-character base62 string that always starts with a letter:

| Worktree Name  | WT_UNIQUE_NAME (example) |
| -------------- | ------------------------ |
| `feature-auth` | `xK7mP2nQ`               |
| `bugfix-123`   | `aB3cD4eF`               |

Use `random` when worktree names might conflict or when you want truly unique identifiers across machines.

### Environment Variables

| Variable         | Example                 | Description                           |
| ---------------- | ----------------------- | ------------------------------------- |
| `WT_UNIQUE_NAME` | `feature-auth`          | The computed unique name              |
| Custom envs      | `postgres-feature-auth` | Each configured env with substitution |

### Usage Examples

#### 1. Named Docker containers

```yaml
unique_naming:
  strategy: worktree-name
  envs:
    POSTGRES_CONTAINER: postgres-${WT_UNIQUE_NAME}
    REDIS_CONTAINER: redis-${WT_UNIQUE_NAME}

hooks:
  add:
    run: |
      # Start containers with unique names
      docker run -d --name $POSTGRES_CONTAINER \
        -p $POSTGRES_PORT:5432 \
        postgres:15

      docker run -d --name $REDIS_CONTAINER \
        -p $REDIS_PORT:6379 \
        redis:7

  clean:
    run: |
      # Stop and remove containers
      docker stop $POSTGRES_CONTAINER $REDIS_CONTAINER || true
      docker rm $POSTGRES_CONTAINER $REDIS_CONTAINER || true
```

#### 2. Unique database names

```yaml
unique_naming:
  envs:
    DATABASE_NAME: myapp_${WT_UNIQUE_NAME}

hooks:
  add:
    run: |
      # Create a unique database
      createdb $DATABASE_NAME
      echo "DATABASE_URL=postgres://localhost:$POSTGRES_PORT/$DATABASE_NAME" >> .env

  clean:
    run: |
      # Drop the database
      dropdb $DATABASE_NAME || true
```

#### 3. Ngrok subdomains for webhook testing

```yaml
unique_naming:
  envs:
    NGROK_SUBDOMAIN: ${WT_UNIQUE_NAME}

hooks:
  add:
    run: |
      # Start ngrok with unique subdomain
      ngrok http $BACKEND_PORT --subdomain=$NGROK_SUBDOMAIN &
      echo "WEBHOOK_URL=https://$NGROK_SUBDOMAIN.ngrok.io" >> .env
```

#### 4. Kubernetes namespaces

```yaml
unique_naming:
  envs:
    K8S_NAMESPACE: dev-${WT_UNIQUE_NAME}

hooks:
  add:
    run: |
      kubectl create namespace $K8S_NAMESPACE
      kubectl config set-context --current --namespace=$K8S_NAMESPACE

  clean:
    run: |
      kubectl delete namespace $K8S_NAMESPACE || true
```

---

## Hooks

Hooks run shell scripts at key lifecycle points with all environment variables available.

### Add Hook

Runs when creating a new worktree, after files are processed.

### Files Configuration

The `files` array supports four item types for copying and templating files from the copy source directory:

#### 1. String (Simple Copy)

Copy files matching a glob pattern, preserving directory structure:

```yaml
hooks:
  add:
    files:
      - "**/.env.local" # Copy all .env.local files
      - "**/node_modules" # Copy node_modules (uses filesystem copy-on-write)
      - ".venv" # Copy Python virtual environment
```

#### 2. Copy Item (Custom Destination)

Copy files with control over the destination path:

```yaml
hooks:
  add:
    files:
      - source: "configs/production.json"
        dest: "config.json" # Rename file

      - source: "templates/**"
        dest: "configs/" # Dest ending with / = directory
```

| `dest` format | Behavior                                |
| ------------- | --------------------------------------- |
| `"file.txt"`  | Copy to specific file path              |
| `"dir/"`      | Copy into directory, preserve structure |
| _(omitted)_   | Mirror source path                      |

#### 3. Template File (File-Based Templates)

Process a template file with `${VAR}` placeholder substitution:

```yaml
hooks:
  add:
    files:
      - template_file: ".env.template"
        dest: ".env" # Required destination

      - template_file: "docker-compose.template.yml"
        dest: "docker-compose.override.yml"
```

Example `.env.template`:

```bash
# Database
DATABASE_URL=postgres://localhost:${POSTGRES_PORT}/${WT_UNIQUE_NAME}

# Ports
API_PORT=${BACKEND_PORT}
WEB_PORT=${FRONTEND_PORT}

# Container names
POSTGRES_CONTAINER=${POSTGRES_CONTAINER}
```

All hook environment variables are available for substitution. Unknown variables are preserved as-is.

#### 4. Inline Template (Config-Defined Templates)

Define template content directly in the config file:

```yaml
hooks:
  add:
    files:
      - inline_template: |
          PORT=${BACKEND_PORT}
          DATABASE_URL=postgres://localhost:${POSTGRES_PORT}/myapp_${WT_UNIQUE_NAME}
          REDIS_URL=redis://localhost:${REDIS_PORT}
        dest: ".env"

      - inline_template: |
          version: '3.8'
          services:
            postgres:
              ports:
                - "${POSTGRES_PORT}:5432"
        dest: "docker-compose.override.yml"
```

#### Template Escape Syntax

To output a literal `${VAR}` without substitution, use backslash escape:

| Input       | Output                                  |
| ----------- | --------------------------------------- |
| `${PORT}`   | Substituted value (e.g., `3000`)        |
| `\${PORT}`  | Literal `${PORT}`                       |
| `\\${PORT}` | `\` + substituted value (e.g., `\3000`) |

Example for shell scripts that need literal variable references:

```yaml
- inline_template: |
    # This gets substituted by wt
    STATIC_PORT=${BACKEND_PORT}

    # This stays as a shell variable reference
    DYNAMIC_PORT=\${PORT:-3000}
  dest: ".env"
```

#### Run Script

Execute commands after file processing:

```yaml
hooks:
  add:
    run: |
      # Trust mise configuration
      mise trust

      # Install dependencies
      pnpm install

      # Set up environment
      echo "$WT_ALL_PORTS_OFFSETS" >> .env

      # Start background services
      docker-compose up -d

      # Run migrations
      pnpm db:migrate
```

### Clean Hook

Runs when removing a worktree, before the worktree is deleted.

```yaml
hooks:
  clean:
    run: |
      # Stop and remove Docker containers
      docker-compose down -v
      docker stop $POSTGRES_CONTAINER $REDIS_CONTAINER || true
      docker rm $POSTGRES_CONTAINER $REDIS_CONTAINER || true

      # Drop test database
      dropdb $DATABASE_NAME || true

      # Clean up any background processes
      pkill -f "ngrok.*$NGROK_SUBDOMAIN" || true
```

### All Available Environment Variables

| Variable                    | Source          | Description                           |
| --------------------------- | --------------- | ------------------------------------- |
| `WT_NAME`                   | Core            | Worktree name                         |
| `WT_PATH`                   | Core            | Absolute path to worktree             |
| `WT_ROOT`                   | Core            | Absolute path to bare repo root       |
| `WT_PORT_OFFSET`            | Port Offsetting | Raw offset value (0, 10, 20...)       |
| `<PORT_NAME>`               | Port Offsetting | Each configured port with offset      |
| `WT_ALL_PORTS_OFFSETS`      | Port Offsetting | All ports as KEY=value lines          |
| `WT_ALL_PORTS_OFFSETS_JSON` | Port Offsetting | All ports as JSON                     |
| `WT_UNIQUE_NAME`            | Unique Naming   | Computed unique identifier            |
| `<UNIQUE_ENV>`              | Unique Naming   | Each configured env with substitution |

### Copy Source Directory

The `files` configuration copies/templates files from a source directory. By default, it uses `.wt-local-res` in the bare repo root.

#### Default: Local Resources Directory

Create the directory in your bare repo:

```bash
cd myproject.git
mkdir .wt-local-res
cp /path/to/env-templates/.env.local .wt-local-res/
```

#### Using Main Worktree

To copy from an existing worktree (e.g., your main worktree), point to its path:

```yaml
copy_source: .worktrees/main
```

#### Path Resolution

- **Relative paths**: Resolved from bare repo root (where wt.yaml lives)
- **Absolute paths**: Used as-is
- **Home directory**: `~` expands to your home directory

```yaml
# Relative (recommended)
copy_source: .wt-local-res

# Absolute
copy_source: /opt/shared/project-resources

# Home directory
copy_source: ~/my-project-resources
```

---

## CLI Reference

### `wt list` (alias: `ls`)

List all managed worktrees.

```bash
wt list
```

Output:

```
Worktrees:

  feature-auth
    Branch: feature-auth
    Path:   /path/to/.worktrees/feature-auth [offset: 0]

  feature-payments
    Branch: feature-payments
    Path:   /path/to/.worktrees/feature-payments [offset: 10]
```

### `wt add <name>` (alias: `create`)

Create a new worktree.

```bash
# Create worktree with new branch (default)
wt add feature-auth

# Create worktree from existing branch
wt add feature-auth -b existing-branch
wt add feature-auth --branch existing-branch

# Create without opening editor
wt add feature-auth --no-open

# Force open editor (overrides auto_open: false)
wt add feature-auth --open
```

### `wt open <name>`

Open an existing worktree in the configured editor.

```bash
wt open feature-auth
```

### `wt remove <name>` (aliases: `rm`, `delete`)

Remove a worktree, running the clean hook first.

```bash
# Normal removal (fails if uncommitted changes)
wt remove feature-auth

# Force removal
wt remove feature-auth --force
wt remove feature-auth -f
```

### `wt completions <shell>`

Output shell completion script.

```bash
wt completions bash
wt completions zsh
wt completions fish
```

---

## Shell Completions

Shell completions provide tab completion for commands, worktree names, and flags.

### Bash

```bash
# Option 1: Install to completions directory
wt completions bash > ~/.local/share/bash-completion/completions/wt

# Option 2: Add to .bashrc
echo 'eval "$(wt completions bash)"' >> ~/.bashrc
```

### Zsh

```bash
# Create completions directory if needed
mkdir -p ~/.zfunc

# Install completion
wt completions zsh > ~/.zfunc/_wt

# Add to .zshrc (before compinit)
# fpath=(~/.zfunc $fpath)
# autoload -Uz compinit && compinit
```

### Fish

```bash
wt completions fish > ~/.config/fish/completions/wt.fish
```

---

## Real-World Examples

### Full-Stack Web App (Node.js + PostgreSQL + Redis)

```yaml
editor: "code"
worktrees_dir: ".worktrees"
auto_branch: true
base_branch: main

port_offseting:
  offset: 100
  ports:
    API_PORT: 3000
    WEB_PORT: 3001
    POSTGRES_PORT: 5432
    REDIS_PORT: 6379

unique_naming:
  strategy: worktree-name
  envs:
    POSTGRES_CONTAINER: myapp-pg-${WT_UNIQUE_NAME}
    REDIS_CONTAINER: myapp-redis-${WT_UNIQUE_NAME}
    DB_NAME: myapp_${WT_UNIQUE_NAME}

hooks:
  add:
    files:
      - "**/.env.local"
      - "**/node_modules"
    run: |
      # Start databases
      docker run -d --name $POSTGRES_CONTAINER \
        -e POSTGRES_PASSWORD=dev \
        -e POSTGRES_DB=$DB_NAME \
        -p $POSTGRES_PORT:5432 \
        postgres:15

      docker run -d --name $REDIS_CONTAINER \
        -p $REDIS_PORT:6379 \
        redis:7-alpine

      # Wait for postgres
      sleep 3

      # Write environment
      cat >> .env.local << EOF
      DATABASE_URL=postgres://postgres:dev@localhost:$POSTGRES_PORT/$DB_NAME
      REDIS_URL=redis://localhost:$REDIS_PORT
      API_PORT=$API_PORT
      WEB_PORT=$WEB_PORT
      EOF

      # Install and migrate
      pnpm install
      pnpm db:migrate

  clean:
    run: |
      docker stop $POSTGRES_CONTAINER $REDIS_CONTAINER 2>/dev/null
      docker rm $POSTGRES_CONTAINER $REDIS_CONTAINER 2>/dev/null
```

### Python Django Project

```yaml
editor: "cursor"
worktrees_dir: ".worktrees"
auto_branch: true
base_branch: main

port_offseting:
  offset: 10
  ports:
    DJANGO_PORT: 8000
    POSTGRES_PORT: 5432
    CELERY_PORT: 5555

unique_naming:
  strategy: worktree-name
  envs:
    DB_NAME: django_${WT_UNIQUE_NAME}

hooks:
  add:
    files:
      - ".env.local"
      - ".venv"
    run: |
      # Create venv if not copied
      if [ ! -d ".venv" ]; then
        python -m venv .venv
      fi

      source .venv/bin/activate
      pip install -r requirements.txt

      # Configure Django
      cat >> .env.local << EOF
      DJANGO_PORT=$DJANGO_PORT
      DATABASE_URL=postgres://localhost:$POSTGRES_PORT/$DB_NAME
      EOF

      # Create database
      createdb $DB_NAME 2>/dev/null || true
      python manage.py migrate

  clean:
    run: |
      dropdb $DB_NAME 2>/dev/null || true
```

### Microservices with Docker Compose

```yaml
editor: "code"
worktrees_dir: ".worktrees"
auto_branch: true
base_branch: main

port_offseting:
  offset: 1000
  ports:
    GATEWAY_PORT: 3000
    AUTH_PORT: 3001
    USERS_PORT: 3002
    ORDERS_PORT: 3003
    POSTGRES_PORT: 5432

unique_naming:
  strategy: worktree-name
  envs:
    # Include port offset to ensure truly unique project names across all worktrees
    COMPOSE_PROJECT_NAME: myapp-${WT_UNIQUE_NAME}-${WT_PORT_OFFSET}

hooks:
  add:
    files:
      - "**/.env.local"
    run: |
      # Generate docker-compose.override.yml with correct ports
      cat > docker-compose.override.yml << EOF
      version: '3.8'
      services:
        gateway:
          ports:
            - "$GATEWAY_PORT:3000"
        auth:
          ports:
            - "$AUTH_PORT:3001"
        users:
          ports:
            - "$USERS_PORT:3002"
        orders:
          ports:
            - "$ORDERS_PORT:3003"
        postgres:
          ports:
            - "$POSTGRES_PORT:5432"
      EOF

      # Start services
      docker-compose up -d

  clean:
    run: |
      docker-compose down -v
```

### Monorepo with Turborepo

```yaml
editor: "code"
worktrees_dir: ".worktrees"
auto_branch: true
base_branch: main

port_offseting:
  offset: 100
  ports:
    WEB_PORT: 3000
    DOCS_PORT: 3001
    API_PORT: 4000
    STORYBOOK_PORT: 6006

hooks:
  add:
    files:
      - "**/.env.local"
      - "**/node_modules"
      - "**/.turbo"
    run: |
      # Configure each app
      echo "PORT=$WEB_PORT" >> apps/web/.env.local
      echo "PORT=$DOCS_PORT" >> apps/docs/.env.local
      echo "PORT=$API_PORT" >> apps/api/.env.local

      # Install dependencies (fast with cached node_modules)
      pnpm install
```

### AI Agent Parallel Development

Perfect for running multiple Claude Code or Cursor instances:

```yaml
editor: "cursor"
worktrees_dir: ".worktrees"
auto_branch: true
base_branch: main

port_offseting:
  offset: 100
  ports:
    DEV_PORT: 3000
    DEBUG_PORT: 9229

hooks:
  add:
    files:
      - ".env.local"
      - "node_modules"
    run: |
      echo "PORT=$DEV_PORT" >> .env.local
      echo "DEBUG_PORT=$DEBUG_PORT" >> .env.local
      npm install
```

Then run multiple agents:

```bash
# Terminal 1
wt add feature-auth
# Opens Cursor at .worktrees/feature-auth with PORT=3000

# Terminal 2
wt add feature-payments
# Opens Cursor at .worktrees/feature-payments with PORT=3100

# Terminal 3
wt add feature-notifications
# Opens Cursor at .worktrees/feature-notifications with PORT=3200
```

Each agent works in complete isolation with its own dev server ports.

### Claude Code Settings Sharing

Share `.claude/settings.local.json` across worktrees and sync permissions back on removal:

```yaml
editor: "zed"
worktrees_dir: ".worktrees"
auto_branch: true
base_branch: main

hooks:
  add:
    run: |
      # Copy Claude Code local settings from bare repo
      SRC="$WT_ROOT/.claude/settings.local.json"
      if [ -f "$SRC" ]; then
        mkdir -p .claude
        cp "$SRC" .claude/settings.local.json
        echo "  Copied .claude/settings.local.json"
      fi

  clean:
    run: |
      # Merge permissions back to bare repo
      SRC=".claude/settings.local.json"
      DST="$WT_ROOT/.claude/settings.local.json"

      [ -f "$SRC" ] || exit 0
      mkdir -p "$WT_ROOT/.claude"

      if [ -f "$DST" ]; then
        # Merge allow/deny arrays, dedupe and sort
        jq -s '
          .[0] as $dst | .[1] as $src |
          ($dst // {}) * ($src // {}) * {
            permissions: {
              allow: ([$dst.permissions.allow // [], $src.permissions.allow // []] | add | unique | sort),
              deny: ([$dst.permissions.deny // [], $src.permissions.deny // []] | add | unique | sort)
            }
          }
          | .permissions |= with_entries(select(.value | length > 0))
        ' "$DST" "$SRC" > "$DST.tmp" && mv "$DST.tmp" "$DST"
        echo "  Merged .claude/settings.local.json"
      else
        cp "$SRC" "$DST"
        echo "  Copied .claude/settings.local.json to bare repo"
      fi
```

This ensures:

- New worktrees inherit your accumulated Claude Code permissions
- Permissions granted during development are preserved when the worktree is removed
- No manual syncing needed

---

## JSON Schema for IDE Autocomplete

Generate a JSON schema for YAML autocomplete in your IDE:

```bash
bun run packages/wt/src/config/json-schema.ts > wt.schema.json
```

Reference it in your `wt.yaml`:

```yaml
# yaml-language-server: $schema=./wt.schema.json
editor: "code"
worktrees_dir: ".worktrees"
# ... rest of config with autocomplete!
```

---

## Requirements

- **Bun** 1.0+ (for running/building)
- **Git** 2.5+ (for worktree support)
- **Bare git repository** (regular repo support planned)

---

## Roadmap

Future features under consideration:

- [ ] **Regular repo support** - Work with non-bare repositories
- [ ] **Shell environment auto-population** - Auto-generate `.envrc` with port/naming vars for direnv
- [ ] **Version management** - Different node/bun/python versions per worktree (mise/asdf integration)
- [ ] **Session management** - tmux integration for persistent processes
- [ ] **Status dashboard** - View all worktrees' git status at a glance
- [ ] **Fuzzy finder** - Interactive worktree selection with fzf

---

## License

[FSL-1.1-ALv2](../../LICENSE) — source available for non-competing use; converts to Apache 2.0 after 2 years.
