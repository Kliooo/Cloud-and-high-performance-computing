# Containerization basics — two Docker containers on a shared network

A study project: a database and an entry point running in separate containers joined by a shared
Docker network. All reads and writes go through the entry point, and the data survives container restarts.

| Container | Role | Image |
|---|---|---|
| `db` | data storage — PostgreSQL 16 | `k1io/containers-basics-db` |
| `api` | entry point — FastAPI | `k1io/containers-basics-api` |

```
localhost:8000  →  api  →  db:5432            (network containers-basics-net)
                            └── db container → volume containers-basics-pgdata
```

## Structure

```
docker-containers-basics/
├── api/                      container #2 — the entry point
│   ├── Dockerfile
│   ├── requirements.txt
│   └── app/{db.py, main.py}
├── db/                       container #1 — the database
│   ├── Dockerfile
│   └── init/01_schema.sql    schema and starter rows (applied once)
├── scripts/demo.sh           end-to-end self-check
├── docker-compose.yml        2 services, network, volume
├── .env.example              optional overrides (the stack starts without it)
├── .gitattributes
├── README.md                 this file
└── .env                      local overrides (git-ignored, not in the repository)
```

## Requirements

Docker Engine 20.10+ or Docker Desktop, Compose v2 (`docker compose`), `curl`.

**If Docker runs inside WSL (Ubuntu):**

```bash
sudo service docker start   # the daemon does not start by itself (systemd is off in WSL)
unset DOCKER_HOST           # otherwise the podman-docker package points it at its own socket
```

## Start

```bash
docker compose up -d --build
docker compose ps           # both containers running, db is (healthy)
```

No configuration step is needed: the database port is never published and the database is reachable
only inside the Docker network, so it runs with `trust` auth (no password). For anything beyond a local
demo, drop the `POSTGRES_HOST_AUTH_METHOD` line and provide a password instead.

Optional: `cp .env.example .env` to change the database name, the user or the published port.

## Check: querying the database through the entry point

All commands run in the host terminal (WSL), not inside the containers. Lines with `docker compose exec`
must be run from the project directory; `curl` works from any directory.

```bash
BASE=http://localhost:8000

curl -s $BASE/health                      # {"status":"ok","database":"reachable"}
curl -s $BASE/items                       # rows read from the database
curl -s $BASE/items/1                     # a single row by id
curl -s $BASE/db-info                     # server version, database start time, row count
curl -s -X POST $BASE/items -H 'Content-Type: application/json' \
     -d '{"title":"a row from the entry point","description":"created through the API"}'

# the same rows as seen inside the database container (the command still runs on the host)
docker compose exec db psql -U appuser -d appdb -c "SELECT * FROM items;"
```

Note: `docker compose ...` always runs on the host — docker is not installed inside the containers.
To look around inside the database container:

```bash
docker compose exec db bash            # from the project directory; sh works too
# inside the container:
#   psql -U appuser -d appdb -c "SELECT * FROM items;"
#   psql -U appuser -d appdb            # interactive session, quit with \q
```

Swagger UI: <http://localhost:8000/docs>. Everything at once:

```bash
bash scripts/demo.sh
```

### Windows PowerShell

`Invoke-RestMethod` in Windows PowerShell 5.1 decodes a response without a charset as Latin-1
(Cyrillic turns into `Ð¡ÑÐ°ÑÑÐ¾Ð²Ð°Ñ`) and encodes a string body the same way (Cyrillic is stored as
`??????`). Explicit UTF-8 fixes both:

```powershell
$BASE = 'http://localhost:8000'

# read: decode the response bytes as UTF-8
$wc = New-Object System.Net.WebClient
$wc.Encoding = [System.Text.Encoding]::UTF8
($wc.DownloadString("$BASE/items") | ConvertFrom-Json) | Format-Table

# write: send the body as a UTF-8 byte array
$body  = @{ title = 'a row from the entry point'; description = 'created through the API' } | ConvertTo-Json
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Method Post -Uri "$BASE/items" -ContentType 'application/json; charset=utf-8' -Body $bytes
```

PowerShell 7 (`pwsh`) and `curl.exe` are UTF-8 by default and need none of this.

## Data persistence

```bash
BASE=http://localhost:8000
curl -s -X POST $BASE/items -H 'Content-Type: application/json' -d '{"title":"restart marker"}'

docker compose restart                    # or stricter: docker compose down && docker compose up -d
curl -s $BASE/items                       # the marker is still there
```

Why it works: the PostgreSQL data directory is mounted from the `containers-basics-pgdata` volume,
which is not removed together with the containers. After a restart `GET /db-info` reports a new
`db_started_at` with the same `items_total` — the container restarted, the data did not.

The schema from `db/init/01_schema.sql` is applied only when an empty data directory is initialized,
so rows created later are never overwritten. The only way to lose the data is to remove the volume:
`docker compose down -v`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/`, `/health` | service information, API and database health |
| GET | `/items`, `/items/{id}` | read rows from the database |
| POST | `/items` | create a row |
| DELETE | `/items/{id}` | delete a row |
| GET | `/db-info` | database server information |
| GET | `/docs` | Swagger UI |

## Publishing to Docker Hub

```bash
docker login
docker compose build && docker compose push    # images: ${DOCKERHUB_USER}/containers-basics-{db,api}
```

Image pages:

* https://hub.docker.com/r/k1io/containers-basics-api
* https://hub.docker.com/r/k1io/containers-basics-db

## Troubleshooting

| Symptom | Fix |
|---|---|
| `port is already allocated` | the port is busy: set `API_PORT` in `.env` |
| `'compose' is not a docker command` | Compose v2 is required — update Docker Desktop |
| `Cannot connect to the Docker daemon` (WSL) | `sudo service docker start` |
| `dial unix ...podman.sock` (WSL) | `unset DOCKER_HOST` (the podman-docker package) |
| Entry point logs `database is not ready yet` | the database is initializing on the first start: `docker compose logs db` |
| `docker: command not found` inside a container | `docker compose ...` runs on the host; inside the container run `psql -U appuser -d appdb` |
| Cyrillic in API responses looks like `Ð¡ÑÐ°ÑÑÐ¾Ð²Ð°Ñ` | Windows PowerShell 5.1 decodes it as Latin-1: read via `WebClient` with UTF-8, or use `pwsh` / `curl.exe` |
| Cyrillic was stored as `??????` after a POST | the body was not sent as UTF-8: pass `[System.Text.Encoding]::UTF8.GetBytes($json)` |
| Start from scratch | `docker compose down -v && docker compose up -d --build` (wipes the data) |

## Assignment checklist

| Requirement | Where |
|---|---|
| A network of two containers | `docker-compose.yml`, network `containers-basics-net` |
| A database container | service `db`, `db/Dockerfile`, PostgreSQL 16 |
| A container as the entry point | service `api`, `api/Dockerfile`, FastAPI |
| Querying the database through the entry point | `GET/POST/DELETE /items`, `GET /db-info` |
| Data survives restarts | volume `containers-basics-pgdata`, section "Data persistence" |
| Dockerfile for both containers | `db/Dockerfile`, `api/Dockerfile` |
| docker-compose for the whole system | `docker-compose.yml` |
| README with run and test commands | this file and `scripts/demo.sh` |
| Docker Hub link | section "Publishing to Docker Hub" |

Russian version of this file was kept during development and has been removed: the repository is English-only.
