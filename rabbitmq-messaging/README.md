# RabbitMQ: messaging between services

Assignment: an application that generates and consumes data through RabbitMQ, with routing and a
dead-letter queue. It runs either on Docker Compose or on Kubernetes.

The producer does not know who will process its jobs: it publishes to a topic exchange with a
`calc.<operation>` routing key, and the broker decides which queue receives the message. Every
result is written to the log as one JSON line; everything that cannot be computed is rejected and
ends up in the dead-letter queue.

```
producer ──calc.add──┐
         ──calc.div──┤   exchange calc.exchange (topic)
         ──calc.mul──┘        │  binding calc.*
                              ▼
                       queue calc.jobs ──x-dead-letter-exchange──▶ calc.dlx (direct)
                              │                                            │ "dead"
                              ▼                                            ▼
                    consumer × N (prefetch 10)                    queue calc.jobs.dlq
                              │
                              ▼
                 result → log (stdout, JSON)
```

## Repository layout

```
rabbitmq-messaging/
├── README.md
├── app/                   one image, three entry points
│   ├── producer.py        publishes jobs on a schedule, key = calc.<operation>
│   ├── consumer.py        computes, acknowledges, rejects into the DLQ
│   ├── dlq.py             shows what was rejected and why (x-death)
│   ├── topology.py        exchanges, queues, bindings, dead-letter arguments
│   ├── operations.py      the five operations and what counts as uncomputable
│   ├── jobs.py            wire format, validation, job generation
│   ├── broker.py          connection with retries and backoff
│   ├── health.py          /healthz, /readyz, /stats for the probes
│   ├── healthcheck.py     the check used by HEALTHCHECK and docker-compose
│   └── config.py          every setting comes from the environment
├── tests/                 50 tests, no broker required
├── deploy/                how the stack is built and run
│   ├── Dockerfile         python:3.12-slim, non-root, HEALTHCHECK
│   ├── docker-compose.yml broker + producer + consumer
│   ├── requirements.txt   pika, pinned
│   ├── .env.example       template for local overrides
│   └── Makefile           short commands for the compose stack
├── k8s/
│   ├── base/              namespace, Secret, ConfigMap, PVC, 3 Deployments, 2 Services, PDB
│   └── overlays/
│       ├── local/         kind/k3s: management UI as NodePort 30672
│       └── cloud/         VM: UI stays inside the cluster, 3 consumers
└── scripts/
    └── smoke-test.sh      end-to-end check of the stack
```

The Dockerfile builds from the project root (it copies `app/` and `tests/`), which is why
`deploy/docker-compose.yml` points its build context one level up. `.dockerignore` sits in the root
because that is where the build context starts.

## Requirements

| Where | What |
|---|---|
| Compose | Docker Engine + Docker Compose v2 (`docker compose`) |
| Kubernetes | a 1.27+ cluster and `kubectl` (the manifests target k3s/kind) |
| Scripts | `bash` (Linux, WSL, macOS) — only for the checks |

## Quick start

```bash
docker compose -f deploy/docker-compose.yml up -d --build      # or: make -C deploy up
docker compose -f deploy/docker-compose.yml logs -f producer consumer
```

Management UI: <http://localhost:15672>, login `123` / `123`.

Stop everything and delete the broker data: `docker compose -f deploy/docker-compose.yml down -v`
(or `make -C deploy down`). To change credentials, ports or the publish interval, copy
`deploy/.env.example` to `deploy/.env` and edit it — compose reads that file from the directory of
its own compose file.

## What to look at

* **Queues → `calc.jobs`** — the work queue: one consumer, messages are taken almost immediately.
* **Queues → `calc.jobs.dlq`** — rejected jobs. It grows by one roughly every 12 seconds
  (a job every 2.5 s, every 5th one is invalid on purpose). Open the queue and use **Get messages**
  to see the payload and the `x-death` header with the reason.
* **Exchanges** — `calc.exchange` (topic) and `calc.dlx` (direct); **Bindings** shows `calc.*` and
  `dead`.

## How it works

### Routing

The producer picks one of five operations (`add`, `sub`, `mul`, `div`, `pow`) and publishes with the
key `calc.<operation>` to the topic exchange `calc.exchange`. The work queue is bound with the
pattern `calc.*`, so a new operation needs neither a new queue nor a change in the routing code.

Messages are published with `mandatory=True`: if no queue matches, the broker returns the message
and the producer logs `{"event": "unroutable"}` instead of losing it silently.

### Message format

```json
{"id": "5f0c1e5a-…", "op": "div", "operands": [17, 4], "created_at": "2026-11-09T13:41:02Z"}
```

`id` is also the message's `message_id` and its natural idempotency key: a redelivery is visible in
the log instead of being recomputed unnoticed. The body is just bytes — here JSON, but the broker
does not care.

### Failures and the dead-letter queue

The consumer acknowledges a message only after the result is logged (`auto_ack=False`). Any failure
— invalid JSON, missing fields, an unknown operation, division by zero, overflow — leads to
`basic_reject(requeue=False)`:

* `requeue=False` is the point: with `requeue=True` the broker would hand the same uncomputable
  message straight back, and the worker would loop forever;
* dead-lettering then applies: the queue declares `x-dead-letter-exchange = calc.dlx`, and the
  direct exchange `calc.dlx` routes by the key `dead` into `calc.jobs.dlq`;
* RabbitMQ adds an `x-death` header (original queue, reason `rejected`, number of attempts), which
  `python -m app.dlq` prints.

So that the DLQ is not always empty, the producer makes every `POISON_EVERY`-th message invalid,
cycling through three reasons: division by zero, an unknown operation, a wrong number of operands.
`POISON_EVERY=0` disables the injection.

### Delivery guarantees

| Mechanism | Where | What it gives |
|---|---|---|
| `delivery_mode=2` | producer | the message is persistent |
| durable exchanges and queues | `topology.py` | objects survive a broker restart |
| publisher confirms | `channel.confirm_delivery()` | the producer knows the broker accepted the message |
| `auto_ack=False` + `basic_ack` | consumer | no message is lost if the worker dies |
| `prefetch_count` | consumer | one worker cannot take the whole queue |

The result is **at-least-once**: nothing is lost, but a message may be delivered twice if the worker
dies between computing and acknowledging. End-to-end exactly-once does not exist; the answer is an
idempotent consumer keyed by `id`.

### Several consumers

```bash
docker compose -f deploy/docker-compose.yml up -d --scale consumer=3     # or: make -C deploy scale
```

All workers read the same queue — competing consumers: each message goes to exactly one of them,
and `prefetch` keeps the load even. No coordination between the workers is needed.

## Verifying the result

One command starts the stack, checks routing, results and the dead-letter path, and cleans up:

```bash
./scripts/smoke-test.sh            # 10 checks, tears everything down at the end
./scripts/smoke-test.sh --keep     # leave the stack running
./scripts/smoke-test.sh --full     # also restart the broker and check that the queues survive
```

It checks that three services are running, `rabbitmqctl` answers, `calc.jobs` exists and has a
consumer, the producer published at least 3 jobs with `calc.*` keys, the consumer logged at least
3 results, no job was left unroutable, `calc.jobs.dlq` received at least one message, and the log
contains a rejection reason.

Manual commands:

```bash
docker compose -f deploy/docker-compose.yml ps

docker compose -f deploy/docker-compose.yml logs --tail=20 consumer   # results and rejections
docker compose -f deploy/docker-compose.yml logs --tail=20 producer   # what was sent, with which key

docker compose -f deploy/docker-compose.yml exec rabbitmq \
    rabbitmqctl list_queues -q name messages consumers
docker compose -f deploy/docker-compose.yml exec rabbitmq \
    rabbitmqctl list_bindings -q source_name destination_name routing_key

make -C deploy stats        # counters of the running service: /stats
make -C deploy dlq          # what is in the DLQ and why
make -C deploy dlq-drain    # read the DLQ and remove the messages
```

Log lines look like this (one message, one JSON line):

```
{"event": "published", "id": "…", "op": "div", "operands": [74, -9], "routing_key": "calc.div"}
{"event": "result", "id": "…", "op": "add", "operands": [12, 30], "result": 42, "duration_ms": 0.041}
{"event": "rejected", "id": "…", "delivery_tag": 7, "routing_key": "calc.div",
 "reason_type": "OperationError", "reason": "division by zero", "body": "…", "next": "calc.jobs.dlq"}
```

What a real run on RabbitMQ 3.13 showed: `calc.exchange` (topic) and `calc.dlx` (direct) with the
bindings `calc.*` and `dead`; routing keys `calc.add`, `calc.div`, `calc.mul`, `calc.pow`,
`calc.sub`; rejected messages in the DLQ with
`x-death: {"queue": "calc.jobs", "reason": "rejected", "count": 1}`; the management UI answering 200
and `/stats` showing `{"processed": 30, "dead_lettered": 14}`; a second consumer joining the same
queue (`calc.jobs` → `consumers 2`); all 10 checks of `smoke-test.sh` passing.

## Kubernetes

```bash
kubectl apply -k k8s/overlays/cloud         # or: make -C deploy k8s-apply
kubectl -n rabbitmq-messaging get pods,svc

# the UI is not published — reach it through a port-forward
kubectl -n rabbitmq-messaging port-forward svc/rabbitmq-management 15672:15672
```

On a local cluster (kind/k3s) use the `local` overlay: it publishes the UI as NodePort `30672`,
that is <http://localhost:30672>.

Images are built from `deploy/Dockerfile`. For kind and k3s, load them into the cluster
(`kind load docker-image k1io/rabbitmq-calc:1.0.0`) or change the image name in
`k8s/base/*-deployment.yaml` to your registry.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RABBITMQ_HOST`, `RABBITMQ_PORT` | `localhost`, `5672` | where the broker is (in compose: `rabbitmq`) |
| `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `RABBITMQ_VHOST` | `123`, `123`, `/` | credentials |
| `EXCHANGE_NAME` | `calc.exchange` | topic exchange for jobs |
| `DEAD_LETTER_EXCHANGE` | `calc.dlx` | direct exchange for rejected messages |
| `QUEUE_NAME` | `calc.jobs` | work queue |
| `DLQ_NAME` | `calc.jobs.dlq` | dead-letter queue |
| `PRODUCER_INTERVAL_SECONDS` | `2.5` | publish period |
| `POISON_EVERY` | `5` | every N-th message is invalid, `0` disables it |
| `PREFETCH_COUNT` | `10` | unacknowledged messages a worker may hold |
| `HEALTH_PORT` | `8080` | port of `/healthz`, `/readyz`, `/stats` |
| `LOG_LEVEL` | `INFO` | log level |

The same values live in `deploy/docker-compose.yml` and `k8s/base/configmap.yaml`;
`deploy/.env.example` is the template for local overrides. These are demo credentials: in compose
the broker is published on `127.0.0.1` only, and the `cloud` overlay does not publish the
management UI at all.

## Tests

```bash
make -C deploy test
# the same thing, without make:
docker compose -f deploy/docker-compose.yml run --rm --no-deps producer \
    python -m unittest discover -s tests -t . -v
```

No broker is needed: pika's channel is replaced by a recording fake with the same method signatures,
and RabbitMQ by a toy broker with topic bindings and dead-lettering. 50 assertions:

* `tests/test_operations.py` — all five operations, division by zero, an unknown operation, wrong
  arity, non-numeric and non-finite operands, overflow, rounding;
* `tests/test_topology.py` — the type of each exchange, the dead-letter arguments, the bindings;
* `tests/test_producer.py` — the `calc.<operation>` key, `delivery_mode=2`, `mandatory`, the fault
  injection and its switch-off, no accidentally invalid jobs;
* `tests/test_consumer.py` — acknowledgement on success, `reject(requeue=False)` on any failure, no
  ack for rejected messages, reason and id in the log;
* `tests/test_flow.py` — a job leaves the queue after the ack, a rejected one reaches the DLQ through
  `calc.dlx`, a foreign key comes back as unroutable, the body survives dead-lettering;
* `tests/test_dlq.py` — the viewer shows distinct messages (not the same one twice), `--drain`
  acknowledges what was read, the limit is respected.
