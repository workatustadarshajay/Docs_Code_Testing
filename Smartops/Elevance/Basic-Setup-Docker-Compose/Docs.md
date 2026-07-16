# Amerbian — Local Development & Operations Guide

This document explains how to build, run, stop, and refresh the full stack
(FastAPI backend, React frontend, Nginx reverse proxy, and Apache Airflow 3.x),
including every command used to get everything working.

---

## 1. Architecture Overview

| Service                 | Container Name         | Role                                                   | Port (host)    |
|--------------------------|------------------------|---------------------------------------------------------|----------------|
| `nginx`                 | `myapp_nginx`          | Reverse proxy, serves the app on plain HTTP             | `80`           |
| `frontend`              | `myapp_frontend`       | React app (built with Vite), served internally by nginx | (internal `80`)|
| `backend`               | `myapp_backend`        | FastAPI app                                              | (internal `8000`)|
| `postgres`              | `airflow_postgres`     | Airflow metadata DB                                      | (internal `5432`)|
| `airflow-init`          | `airflow_init`         | One-time DB migration, then exits                        | —              |
| `airflow-apiserver`     | `airflow_apiserver`    | Airflow UI + REST API (`airflow api-server`)             | `8081`         |
| `airflow-scheduler`     | `airflow_scheduler`    | Triggers task runs                                       | (internal)     |
| `airflow-dag-processor` | `airflow_dag_processor`| Parses DAG files (separate from scheduler in 3.x)        | (internal)     |
| `airflow-triggerer`     | `airflow_triggerer`    | Handles deferrable/async operators                       | (internal)     |
| `minio`                 | `myapp_minio`          | S3-compatible object storage                             | `9000` (API), `9001` (console) |
| `elasticsearch`         | `myapp_elasticsearch`  | Search/indexing engine                                   | `9200`         |

Two compose files exist:
- **`docker-compose.yml`** — development. Bypasses SSL verification during
  image builds (`pip --trusted-host`, `npm --strict-ssl=false`) so it works
  behind corporate proxies like Zscaler with no certificate setup needed.
- **`docker-compose.prod.yml`** — production. Uses `Dockerfile.prod` for
  backend/frontend with normal SSL verification (no bypass).

---

## 2. Prerequisites

### 2.1 Docker permission (run once per machine)

If `docker ps` gives `permission denied`, add your user to the `docker` group
and start a fresh login shell (a plain `newgrp docker` in a non-interactive
terminal may fail — logging out/in or opening a new terminal is more reliable):

```bash
sudo usermod -aG docker $USER
# then log out and back in, OR open a brand new terminal, OR run:
sg docker -c bash
```

Until group membership is active, prefix every `docker` command with `sudo`.

### 2.2 Host port 80

Nginx binds host port `80` (so the app is reachable at `http://<host>` with
no port suffix). Binding to port 80 typically requires root, which is why
`sudo docker compose ...` is used throughout this doc.

---

## 3. Starting Everything

From the repo root:

```bash
cd ~/Projects/Amerbian

# Build images and start all containers in the background
sudo docker compose up --build -d

# Check status of every container
sudo docker compose ps
```

First time only — run the Airflow DB migration explicitly before (or let
`airflow-init` run automatically as part of `up`):

```bash
sudo docker compose up airflow-init
```

`airflow-init` mounts `./airflow/{dags,logs,plugins,config}`, creates those
folders if missing, `chown`s them to `AIRFLOW_UID` (default `50000`), and
runs `airflow db migrate`. It exits with code `0` when done — this is expected,
it is not a long-running service.

### Verify the whole stack

```bash
curl http://localhost/api/health      # backend health via nginx
curl http://localhost                 # frontend via nginx
sudo docker compose ps                # all services should show "Up"/"healthy"
```

---

## 4a. Ports You Can Access

| URL                              | What it is                                      |
|-----------------------------------|--------------------------------------------------|
| `http://<host>`                  | Frontend app (via nginx, port 80)                |
| `http://<host>/api/...`          | Backend API (via nginx, proxied to FastAPI)      |
| `http://<host>/docs`             | FastAPI Swagger UI                                |
| `http://<host>/openapi.json`     | FastAPI OpenAPI schema                            |
| `http://<host>:8081`             | Airflow UI (login: see section 4 below)          |
| `http://<host>:9000`             | MinIO S3 API                                      |
| `http://<host>:9001`             | MinIO web console (login: `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` in `.env`, default `minioadmin`/`minioadmin`) |
| `http://<host>:9200`             | Elasticsearch REST API (e.g. `curl http://<host>:9200/_cluster/health`) |

`<host>` = `localhost` if browsing from the same machine, or the VM's IP
(e.g. `10.100.242.186`) if browsing remotely.

---

## 4b. Airflow — Getting the Username & Password

Airflow 3.x replaced the old FAB `airflow users create` command with the
**Simple Auth Manager** (the new default). Users are declared in
`.env` via `AIRFLOW__CORE__SIMPLE_AUTH_MANAGER_USERS` (format
`username:role`, comma-separated), but **passwords are auto-generated** and
printed once in the `airflow-apiserver` logs the first time that user logs in
context is created.

Retrieve the current password at any time:

```bash
sudo docker compose logs airflow-apiserver | grep "Password for user"
```

Example output:

```
airflow_apiserver | Simple auth manager | Password for user 'airflow': NbAdMDbQW2rSdnqz
```

Then log in at **`http://<host>:8081`** with:
- Username: `airflow`
- Password: (from the log line above)

> The password is regenerated any time the underlying `simple_auth_manager_passwords.json.generated`
> file doesn't exist yet (e.g. after a fresh `postgres` volume). It is stable
> across normal restarts as long as the Postgres volume (`postgres-db-volume`)
> is not removed.

---

## 5. Adding / Editing DAGs

DAG files live in `./airflow/dags/` on the host, bind-mounted into
`airflow-scheduler`, `airflow-dag-processor`, and `airflow-triggerer` at
`/opt/airflow/dags`.

```bash
# Just drop a .py file in the folder — no restart required
cp my_dag.py ~/Projects/Amerbian/airflow/dags/
```

### Refresh interval

The `airflow-dag-processor` scans the folder automatically. The scan interval
is controlled by `AIRFLOW__DAG_PROCESSOR__REFRESH_INTERVAL` (set to `10`
seconds in this project's `docker-compose.yml`, instead of Airflow's 300s/5-minute
default) so new or edited DAGs show up quickly **without restarting any container**.

If a DAG still doesn't appear after ~15-20s:

```bash
# Confirm the file is actually visible inside the container
sudo docker compose exec airflow-dag-processor ls -la /opt/airflow/dags

# Check for parsing/import errors
sudo docker compose exec airflow-scheduler airflow dags list-import-errors

# List all known DAGs
sudo docker compose exec airflow-scheduler airflow dags list
```

### Permissions note

`airflow-init` chowns `./airflow/{dags,logs,plugins,config}` to
`AIRFLOW_UID:0` (default `50000:0`) the first time it runs. If your host user
then can't write into `./airflow/dags` (permission denied / silent failure),
reclaim ownership for your host user while keeping it readable by the
container:

```bash
sudo chown -R $(id -u):$(id -g) ~/Projects/Amerbian/airflow/dags \
  ~/Projects/Amerbian/airflow/plugins ~/Projects/Amerbian/airflow/config
chmod -R a+rX ~/Projects/Amerbian/airflow/dags \
  ~/Projects/Amerbian/airflow/plugins ~/Projects/Amerbian/airflow/config
```

### Trigger / inspect a DAG manually

```bash
# Trigger a run
sudo docker compose exec airflow-scheduler airflow dags trigger hello_world

# List runs for a DAG (dag_id is positional, not a flag)
sudo docker compose exec airflow-scheduler airflow dags list-runs hello_world

# List runs filtered by state
sudo docker compose exec airflow-scheduler airflow dags list-runs hello_world --state success
```

---

## 6. Stopping / Restarting

```bash
# Stop and remove all containers + the default network (keeps volumes/data)
sudo docker compose down

# Stop and ALSO wipe the Postgres volume (Airflow metadata, DAG run history) - destructive
sudo docker compose down -v

# Restart everything (rebuild images if Dockerfiles/requirements changed)
sudo docker compose up --build -d

# Restart a single service only (e.g. after a code change or config edit)
sudo docker compose up -d airflow-dag-processor
sudo docker compose restart backend

# View logs (all services, or one at a time)
sudo docker compose logs -f
sudo docker compose logs -f airflow-scheduler
```

---

## 7. Production Deployment

Use the `-f` flag to point at the prod compose file, which builds with
`Dockerfile.prod` (normal SSL verification, no Zscaler/dev bypass):

```bash
sudo docker compose -f docker-compose.prod.yml up --build -d
sudo docker compose -f docker-compose.prod.yml ps
sudo docker compose -f docker-compose.prod.yml down
```

---

## 8. Quick Command Reference

| Task                                   | Command                                                                 |
|-----------------------------------------|--------------------------------------------------------------------------|
| Build + start everything                | `sudo docker compose up --build -d`                                     |
| Run Airflow DB migration only           | `sudo docker compose up airflow-init`                                   |
| Check container status                  | `sudo docker compose ps`                                                 |
| Get Airflow admin password               | `sudo docker compose logs airflow-apiserver \| grep "Password for user"`|
| List all DAGs                           | `sudo docker compose exec airflow-scheduler airflow dags list`          |
| List import errors                      | `sudo docker compose exec airflow-scheduler airflow dags list-import-errors` |
| Trigger a DAG                           | `sudo docker compose exec airflow-scheduler airflow dags trigger <dag_id>` |
| List DAG runs                           | `sudo docker compose exec airflow-scheduler airflow dags list-runs <dag_id>` |
| View logs (follow)                      | `sudo docker compose logs -f [service]`                                 |
| Restart one service                     | `sudo docker compose up -d <service>` or `sudo docker compose restart <service>` |
| Stop everything (keep data)             | `sudo docker compose down`                                               |
| Stop everything + wipe volumes          | `sudo docker compose down -v`                                            |
| Test backend health                     | `curl http://localhost/api/health`                                      |
| Test frontend                           | `curl http://localhost`                                                 |
| Test Elasticsearch                      | `curl http://localhost:9200/_cluster/health`                            |
| Open MinIO console                      | Browse to `http://localhost:9001`                                       |
| Production build/start                  | `sudo docker compose -f docker-compose.prod.yml up --build -d`          |

---

## 9. Key Files

| File                                | Purpose                                                             |
|--------------------------------------|----------------------------------------------------------------------|
| `docker-compose.yml`                | Dev stack: backend, frontend, nginx, Postgres, and full Airflow 3.x |
| `docker-compose.prod.yml`           | Prod stack (same services, `Dockerfile.prod`, normal SSL)           |
| `backend/Dockerfile` / `Dockerfile.prod` | FastAPI image (dev bypasses SSL verification via `--trusted-host`) |
| `frontend/Dockerfile` / `Dockerfile.prod` | React/Vite image (dev bypasses SSL via `npm config set strict-ssl false`) |
| `nginx/nginx.conf`                  | Reverse proxy routing `/`, `/api/`, `/docs`, `/openapi.json`         |
| `.env`                               | Shared environment variables (CORS origins, Airflow config, etc.)   |
| `airflow/dags/`                     | Drop DAG `.py` files here                                            |
| `airflow/logs/`, `airflow/plugins/`, `airflow/config/` | Airflow runtime data (gitignored)             |

---

## 10. Notes on MinIO / Elasticsearch Image Tags

On some corporate networks (e.g. Zscaler), pulling `minio/minio:latest` or
`docker.elastic.co/elasticsearch/elasticsearch:*` fails with a `403 Forbidden`
when downloading image layer data from the CDN backing those registries
(Cloudflare R2), even though the registry API itself responds normally. This
is a network/proxy-level block, not a project configuration issue.

Working alternatives used in this project:
- `minio/minio:RELEASE.2025-09-07T16-13-09Z-cpuv1` (pinned tag instead of `latest`)
- `elasticsearch:8.18.0` (official Docker Hub image instead of `docker.elastic.co/...`)

If pulls fail again in the future, try pinning to a different specific tag,
or ask your network/IT team to allowlist the Docker Hub CDN domains
(`registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`,
`*.r2.cloudflarestorage.com`).
