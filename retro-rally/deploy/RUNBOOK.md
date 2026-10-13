# Deploying RETRO RALLY on a Linux VM

The game needs a machine that stays up and can write to disk: a long-running Node process,
JSON files for the leaderboard and pilot registry, and a persistent SSE connection for the
multiplayer lobby. That rules out serverless platforms (Workers, Pages, Functions) — they
have neither a long-lived process nor a filesystem. Any ordinary Linux VPS works; this
runbook assumes Ubuntu or Debian, systemd and nginx, and nothing else.

## What the provider has to give you

- a public x86-64 Linux VM with a **public IPv4 address** (a private IP behind NAT is not
  enough)
- SSH access as a **non-root user with sudo**
- inbound TCP **22, 80, 443** open in both the provider firewall and the OS firewall
- 2 vCPU / 4 GB RAM is comfortable; 1 vCPU / 2 GB still runs, but Node + nginx + the browser
  multiplayer client like memory, and 20 GB of disk is plenty
- Ubuntu 22.04/24.04 LTS or Debian 12+ (the commands below assume `apt` and `systemd`)

Most providers offer a small free tier or a few hundred roubles a month for this size; the
exact figure changes often, so check the price page yourself before committing to anything.

## Step 0. DNS (optional, but do it first)

Point an A record for your domain at the VM's public IP and wait for it to resolve. Doing
this first means every later step can be tested over HTTPS instead of plain HTTP.

## Step 1. Open the ports

In the provider's web console, in the instance firewall / security group, allow inbound TCP
22, 80 and 443. On the machine itself:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## Step 2. Connect

The username depends on the image — `ubuntu`, `debian`, `ec2-user`, `root` and so on:

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@<IP>
```

If you do not have a key yet, create one locally and add the `.pub` contents to the provider's
"SSH keys" section *before* creating the VM, otherwise you will not be able to log in:

```powershell
ssh-keygen -t ed25519 -C "retro-rally"
Get-Content $HOME\.ssh\id_ed25519.pub
```

## Step 3. Install packages

```bash
sudo apt update
sudo apt install -y nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v && nginx -v                          # sanity check
```

## Step 4. Create a dedicated user

Running the game as a normal unprivileged account is worth the two extra commands:

```bash
sudo adduser --system --group --home /opt/retro-rally retro
```

Remember the name — step 6 needs it in the `User=` line of the unit.

## Step 5. Upload the project

From your local machine, at the project root:

```powershell
tar -czf retro-rally.tar.gz src tools deploy package.json README.md
scp -i $HOME\.ssh\id_ed25519 retro-rally.tar.gz user@<IP>:/tmp/
```

On the server:

```bash
sudo mkdir -p /opt/retro-rally
sudo tar -xzf /tmp/retro-rally.tar.gz -C /opt/retro-rally
sudo chown -R retro:retro /opt/retro-rally
rm -f /tmp/retro-rally.tar.gz
ls /opt/retro-rally                          # src/, tools/, deploy/, package.json ...
```

`src/data/` is not in the archive — the server creates it on first start.

## Step 6. systemd service

The finished unit ships in `deploy/retro-rally.service`. Copy it, then **edit `User=` to the
name from step 4** (`retro`) — the shipped default is `ubuntu`.

```bash
sudo cp /opt/retro-rally/deploy/retro-rally.service /etc/systemd/system/
sudo nano /etc/systemd/system/retro-rally.service
sudo systemctl daemon-reload
sudo systemctl enable --now retro-rally
systemctl status retro-rally --no-pager
curl -s http://127.0.0.1:8080/api/health     # {"status":"ok",...}
```

The unit pins `HOST=127.0.0.1`, so Node listens on loopback only — nginx is the only thing
facing the internet.

## Step 7. nginx: static files + API proxy

The finished config is `deploy/nginx-retro-rally.conf`. Change `server_name _;` to your
domain if you set one up in step 0.

```bash
sudo cp /opt/retro-rally/deploy/nginx-retro-rally.conf /etc/nginx/sites-available/retro-rally
sudo ln -s /etc/nginx/sites-available/retro-rally /etc/nginx/sites-enabled/retro-rally
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Why the config looks the way it does:

- the root is **`/opt/retro-rally/src/public`**, so `src/data/` (admin key, pilot registry),
  `src/lib/`, `tools/` and `server.js` are never served. This matters: if the document root
  ever slips up to the project root, the generated admin key becomes world-readable;
- `/api/` is proxied to Node with `proxy_buffering off` — without it the multiplayer
  Server-Sent Events stall;
- service paths are additionally blocked with `deny all` as a second line of defence.

## Step 8. Verify

```bash
curl -s http://<IP>/api/health          # status ok
curl -sI http://<IP>/data/admin-key.txt # must be 404 or 403, never 200
```

Then open `http://<IP>/` for the game and `http://<IP>/admin.html` for the admin panel. The
administrator key:

```bash
cat /opt/retro-rally/src/data/admin-key.txt
```

To use your own key instead, add `Environment=ADMIN_KEY=yourkey` to the unit and run
`sudo systemctl daemon-reload && sudo systemctl restart retro-rally`.

## Step 9. HTTPS

With a domain already resolving:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain
sudo systemctl enable --now certbot.timer
```

If you would rather terminate TLS somewhere else (a CDN or load balancer in front of the VM),
let it handle the certificate and keep the origin on port 80 as the config assumes.

## Updating

`deploy/deploy.ps1` does it in one step from a Windows machine (needs `scp`/`ssh`, both
present in Windows 10+):

```powershell
.\deploy\deploy.ps1 -Server <IP> -User retro
```

It packs the code, uploads it to `/tmp`, unpacks it over `/opt/retro-rally` leaving
`src/data/` untouched, and restarts the service. Parameters: `-Server`, `-User`, `-RemoteDir`,
`-KeyPath`, `-ServiceName`.

Manually it is the same steps as step 5 plus `sudo systemctl restart retro-rally`.

## Backups

The only durable state is `src/data/`: `results.json` (leaderboard), `pilots.json` (accounts)
and the generated admin key.

```bash
sudo mkdir -p /root/backup
sudo crontab -e     # add this line:
0 4 * * * tar -czf /root/backup/retro-rally-$(date +\%F).tar.gz -C /opt/retro-rally src/data
```

Snapshot the disk through your provider too if you have that included — it covers the case
where the machine is destroyed rather than merely misconfigured.

## Containers instead

If you would rather not manage systemd and nginx at all, build the included image. It runs
the same server and serves the game itself, so it needs no nginx in front and no unit file:

```bash
docker build -f deploy/Dockerfile -t retro-rally .
docker run -d -p 8080:8080 -v retro-rally-data:/app/data -e ADMIN_KEY=yourkey retro-rally
```

The volume keeps `results.json` and `pilots.json` across container recreation. The game is
then on port 8080 directly, which is fine for a course project but exposes the Node port to
the internet — put a reverse proxy in front of it if that matters.

## Common pitfalls

| Symptom | Cause and what to do |
|---|---|
| Nothing opens from outside | no public IP attached, or port 80 missing from the provider firewall or `ufw` |
| `502 Bad Gateway` | the service is not running: `systemctl status retro-rally`, then `journalctl -u retro-rally -n 50` |
| Multiplayer keeps dropping | buffering is not disabled in nginx: `proxy_buffering off` for `/api/` |
| The admin panel asks for a key and you do not know it | `cat /opt/retro-rally/src/data/admin-key.txt` |
| Changes are not visible in the browser | the client is cached by `?v=` — force a hard refresh (Ctrl+F5) |
| Service fails to start after a fresh install | the unit's `User=` does not exist on this image; set it to the user from step 4 |
| Login silently fails on a plain HTTP address | expected: Web Crypto needs a secure context, the client falls back to a built-in SHA-256 |