# Deploying Redline to a server

This puts Redline on the internet at a domain of your choosing, behind HTTPS, with the
database kept across restarts and a daily backup. It assumes a Linux server you can reach
over SSH — any small VPS will do; a few hundred delegates is nothing to Node and SQLite, and
1 GB of RAM is plenty.

**Why HTTPS is not optional.** People sign in with passwords. Over plain HTTP those cross
the internet readable by anyone on the path, including the venue's wifi. The setup below
puts [Caddy](https://caddyserver.com) in front of the app: it obtains and renews a free
Let's Encrypt certificate by itself, and the app has no port open to the outside at all.

---

## What you need before starting

- A server running a recent Ubuntu or Debian, with a public IP address.
- SSH access to it, as a user that can use `sudo`.
- A domain or subdomain you control, e.g. `redline.your-conference.org`.

## 1. Point the domain at the server

At your DNS provider, create an **A record** for the name you chose, pointing at the
server's public IPv4 address (and an **AAAA** record for its IPv6 address, if it has one).

Wait until it resolves — from your own computer:

```bash
dig +short redline.your-conference.org
```

When that prints the server's IP, carry on. Starting before it does is the most common
reason Caddy fails to get a certificate.

## 2. Install Docker on the server

Connect with SSH, then use Docker's official install script:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Log out and back in so the group change takes effect, then check:

```bash
docker compose version
```

## 3. Open the firewall

Only SSH and the web need to be reachable:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

Port 80 has to stay open even though everything ends up on HTTPS: it is how Let's Encrypt
checks that you control the domain, and how visitors who type `http://` get redirected.

> Docker publishes ports around `ufw`, not through it. That is why the production setup gives
> the app no published port: the only ports Docker opens are Caddy's 80 and 443, which you
> want open anyway.

## 4. Get the code

```bash
git clone https://github.com/Gnoch42/RedLine.git
cd RedLine
```

If the repository is private, the server needs its own read access — a GitHub
[deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
is the tidy way, cloned with `git clone git@github.com:Gnoch42/RedLine.git`.

## 5. Configure it

```bash
cd deploy
cp .env.example .env
nano .env
```

Set `REDLINE_DOMAIN` to the name from step 1, save, and close. That file stays on the server
and is ignored by git.

## 6. Start it

From the `deploy/` folder:

```bash
docker compose up -d --build
```

The first build takes a few minutes. Then watch Caddy obtain the certificate:

```bash
docker compose logs -f caddy
```

Look for a line saying the certificate was obtained; press `Ctrl+C` to stop watching (the
containers keep running). Open `https://your-domain` — you should see the sign-in page with a
padlock.

Both containers restart on their own if they crash or the server reboots.

## 7. Create your account, and make it an administrator

In the browser, create your account as usual. Then, on the server, from `deploy/`:

```bash
docker compose exec app node scripts/admin.js grant you@example.org
```

Sign out and back in, and an **Admin** button appears. From there you can reset other
people's passwords and appoint more administrators. Do this before the conference: without
an administrator, nobody can help a delegate who forgets their password.

---

## Backups

The whole conference is one SQLite file on a Docker volume. Take a consistent snapshot —
safe while people are using the site:

```bash
docker compose exec app node scripts/backup.js --keep 14
```

That writes a timestamped copy into the same volume and keeps the 14 most recent. **A backup
on the same disk only protects you from mistakes, not from losing the server** — so copy them
off it:

```bash
docker compose cp app:/data/backups ./backups
```

and then, from your own computer:

```bash
scp -r you@your-server:RedLine/deploy/backups ./redline-backups
```

### Every day, automatically

On the server, run `crontab -e` and add this line — adjusting the path to wherever you
cloned the repository — to back up every night at 3 a.m.:

```cron
0 3 * * * cd /home/you/RedLine/deploy && docker compose exec -T app node scripts/backup.js --keep 14 >> /home/you/redline-backup.log 2>&1
```

During the conference itself, consider every hour instead: `0 * * * *`.

### Restoring one

From `deploy/`, with the file you want to restore sitting in `deploy/backups/`:

```bash
docker compose stop app
docker compose run --rm --user root -v "$PWD/backups:/restore:ro" app \
  sh -c 'cp /restore/redline-THE-ONE-YOU-WANT.db /data/redline.db \
         && rm -f /data/redline.db-wal /data/redline.db-shm \
         && chown node:node /data/redline.db'
docker compose start app
```

Deleting the `-wal` and `-shm` files matters: they belong to the database being replaced, and
left behind they would be replayed over the one you restored.

## Updating to a newer version

Back up first, then from the repository root:

```bash
git pull
cd deploy
docker compose up -d --build
```

The database is migrated automatically when the app starts; existing work is kept. Watch
`docker compose logs -f app` for a clean start.

---

## When something goes wrong

**The site does not load, or the browser warns about the certificate.**
`docker compose logs caddy`. Nearly always one of: the domain does not yet resolve to this
server (step 1), port 80 or 443 is blocked by a firewall — including one at your hosting
provider, separate from `ufw` — or `REDLINE_DOMAIN` has a typo. Let's Encrypt rate-limits
repeated failures, so fix the cause before retrying over and over.

**"502 Bad Gateway".** Caddy is up but the app is not. `docker compose logs app`.

**A delegate is locked out.** An administrator issues a reset code from the Admin panel.
If no administrator can sign in either, from the server:

```bash
docker compose exec app node scripts/admin.js reset them@example.org
```

**Is it running?** `docker compose ps` — both services should say `running`, and the app
`healthy`.

## Before the conference: things worth knowing

- **Never run `npm run seed` against the real server.** It creates demo accounts that all
  share a password printed in the terminal.
- **Sessions do not expire.** On a shared or borrowed computer, delegates should sign out when
  they are done.
- **Contact details are visible to every participant**, by design. Tell delegates that when
  they register — the phone field is optional.
- **Rate limiting on sign-in lives in memory** and resets when the app restarts. That is fine
  for one server; it is not a substitute for an administrator keeping an eye out.

## No domain? A local network instead

If Redline only needs to work inside a venue or a classroom, on a network you trust, you can
skip the domain and HTTPS and use the root `docker-compose.yml`, opened to the network:

```bash
REDLINE_BIND=0.0.0.0 docker compose up -d --build
```

Delegates then reach it at `http://<the-machine's-local-ip>:3000`. Passwords travel
unencrypted on that network, so do not do this on public or guest wifi, and never on a server
reachable from the internet — that is what the `deploy/` setup is for.
