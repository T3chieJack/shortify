<p align="center">
  <img src="public/favicon.svg" alt="Shortify logo" width="96" height="96">
</p>

<h1 align="center">Shortify</h1>

<p align="center">
  A self-hosted link shortener in one Docker container. Shorten links, share text and files, protect them with PINs, and see how they get used, all on your own server.
</p>

> [!IMPORTANT]
> Plain HTTP works out of the box, but passwords, PINs and shared files then travel unencrypted. Only use it that way on a network you trust, and [turn on HTTPS](#https) before putting Shortify on the internet.

<br>

## Features

- **Short links**
  - Custom or random endings, bulk add, and tags
- **Text and file sharing**
  - Text up to 1 MB, and files up to 100 MB by default
- **Link protection**
  - PINs, expiry dates, click limits and one-time links
- **QR codes**
  - One for every link, with an SVG download
- **Link previews**
  - Add `+` to a short link to see where it goes before opening it
- **Multiple domains**
  - Pick one per link, set a default, and swap at any time
- **Connections**
  - Cloudflare Tunnel, your own reverse proxy, or a certificate of your own
- **Advanced mode** (optional)
  - Analytics, per-link stats, CSV export and an API with revocable keys
- **Admin tools**
  - Search, filters, bulk edit and delete, storage use, and database backups
- **Two-factor login**
  - Codes from an authenticator app, with one-time recovery codes
- **Updates from the browser** (optional)
  - An update button and a schedule, with automatic rollback if a new version fails to start

<br>

## Usage

> [!IMPORTANT]
> The first time you open Shortify, it asks you to create your account. That page needs a setup code, so nobody else who finds the server first can claim it. The code is printed in the container logs.

The recommended way to run Shortify is the published container image, built for Intel/AMD and ARM. It's on `ghcr.io` as used below, and on Docker Hub as `techiejack/shortify`. There are no npm dependencies. The only addition to the Node image is `cloudflared`, pinned by version and checksum in the `Dockerfile`.

### Docker Compose

Create a `compose.yaml`:

```yaml
services:
  shortify:
    image: ghcr.io/t3chiejack/shortify:1
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    ports:
      - "80:8080"
      - "443:8443"
    volumes:
      - shortify-data:/data

volumes:
  shortify-data:
```

Start it, then get your setup code and open the server in a browser:

```sh
docker compose up -d
docker compose logs | grep "Setup code"
```

### Docker CLI

Pull the image and mount a volume for persistent storage:

```sh
docker pull ghcr.io/t3chiejack/shortify:1
docker run --detach --name shortify \
  --volume shortify-data:/data \
  --restart unless-stopped \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  --publish 80:8080 \
  --publish 443:8443 \
  ghcr.io/t3chiejack/shortify:1
```

Then get your setup code:

```sh
docker logs shortify | grep "Setup code"
```

### Build it yourself

```sh
git clone https://github.com/T3chieJack/shortify.git
cd shortify
docker compose up -d --build
docker compose logs | grep "Setup code"
```

> [!TIP]
> To skip the setup page in automated installs, set `SHORTIFY_ADMIN_PASSWORD` before the first start.

<br>

## HTTPS

HTTPS is optional, and there are three ways to turn it on:

- **Cloudflare Tunnel:** paste a tunnel token in **Settings**. No open ports or certificates needed. Point the tunnel's public hostname at `http://localhost:8080`.
- **Your own reverse proxy:** let Caddy, Nginx or similar handle HTTPS, and list its IP in **Settings > Your own reverse proxy**. Without that, every visitor looks like the proxy, so they all share one limit on login, PIN and link-guessing tries.
- **A certificate in Shortify:** paste a certificate and private key in **Settings > HTTPS**. You can also send HTTP visitors to HTTPS from there. You'll need to renew the certificate yourself.

Then add your domain in **Settings > Domains** and use **Check** to confirm it reaches this server.

<br>

## Configuration

Set these under `environment` in `compose.yaml`:

| Variable | Default | What it does |
| --- | --- | --- |
| `SHORTIFY_MAX_UPLOAD_MB` | `100` | Largest file that can be shared. Uploads are held in memory while they arrive, so leave room for this. |
| `SHORTIFY_SECURE_COOKIES` | `0` | Set to `1` to treat every request as HTTPS when setting cookies. Only for setups the options above don't detect. |
| `SHORTIFY_ADMIN_USERNAME` | `admin` | Account name when `SHORTIFY_ADMIN_PASSWORD` is used. |
| `SHORTIFY_ADMIN_PASSWORD` | none | Creates the account on first start, instead of the setup page. |
| `SHORTIFY_HTTPS_PUBLIC_PORT` | `443` | The outside port for HTTPS, if you map it to something else. Used when redirecting visitors. |

<br>

## Two-factor login

Turn it on in **Settings > Two-factor login**. Scan the QR code with an authenticator app, enter a code to confirm it, and save the 10 recovery codes it gives you. Each recovery code works once.

An account gets 5 wrong codes before a 15-minute wait. API keys don't use two-factor login, so treat them like passwords.

If you lose both your app and your recovery codes, run this on the server to turn it off, then log in with your password:

```sh
docker compose exec shortify node src/reset-2fa.js
```

<br>

## Updates

Without the updater, update from the server:

```sh
docker compose pull
docker compose up -d
```

To update from **Settings > Updates**, or on a schedule, add the updater to `compose.yaml` under `services`, using the same image as `shortify`:

```yaml
  updater:
    image: ghcr.io/t3chiejack/shortify:1
    command: ["node", "src/updater.js"]
    restart: unless-stopped
    user: root
    read_only: true
    security_opt:
      - no-new-privileges:true
    healthcheck:
      disable: true
    volumes:
      - shortify-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
```

Then run `docker compose up -d`. Your Shortify service must be called `shortify`, as in the examples above.

> [!WARNING]
> The updater needs the Docker socket, and anything with access to that socket can take full control of the server. That's why it's optional and runs apart from Shortify, which never touches the socket. Shortify can only ask the updater to check for or install the image tag you chose. Leave the updater out if you'd rather update by hand.

The updater checks once a day, and only installs when you press **Update now** or set a schedule. If the new version doesn't start and pass its health check, your current version comes back on its own. It stays within the tag you chose, so `:1` never moves to version 2 by itself. It only works with published images, not with `docker compose up --build`.

<br>

## Limits

- **PINs:** 4 to 12 digits, stored hashed, so they can't be shown again. A visitor gets 5 wrong tries per link, and a link gets 50 in total, before a 15-minute wait.
- **Click limits:** known bots and chat app previews don't use up an open, and don't get to see the link.
- **Previews:** links with a PIN or a click limit keep their destination hidden.
- **Endings:** an ending works on every domain, so moving a link to another domain doesn't break its old address. It also means one ending can't point to two places.
- **Guessing:** an address asking for 200 links that don't exist within 15 minutes gets blocked for the rest of that time.

<br>

## Advanced mode

Off by default. Turning it on in **Settings** adds the Analytics page, detail on each link, and the API.

For each visit it records the time, the link, the referring site's name, browser, device, operating system and language, plus the country if Cloudflare or your proxy provides it. IP addresses aren't stored. Visitors are counted with a hash salted fresh each day, and the old salt is discarded. Detail is deleted after the period you choose, 90 days by default.

> [!TIP]
> If people outside your household use your links, check whether privacy rules where you live ask you to tell them.

<br>

## API

Needs advanced mode. Create a key under **Settings > Advanced mode > API keys**, and send it with every request:

```
Authorization: Bearer YOUR_KEY
```

| Request | What it does |
| --- | --- |
| `POST /api/links` | Create a link. Returns `201` and the link. |
| `GET /api/links` | List links, newest first, 100 at a time. Takes `offset`, `q`, `kind`, `tag` and `state`. |
| `GET /api/links/:ending` | Read one link. |
| `DELETE /api/links/:ending` | Delete a link. Returns `204`. |

Fields for `POST /api/links`. Send either `url` or `text`:

| Field | Type | Notes |
| --- | --- | --- |
| `url` | text | Where the link goes. |
| `text` | text | Text to share instead, up to 1 MB. |
| `slug` | text | The ending. Random if left out. |
| `pin` | text | 4 to 12 digits. |
| `expires` | text | `1h`, `1d`, `7d`, `30d`, or a date like `2027-01-31`. |
| `click_limit` | number | Stops working after this many opens. |
| `tags` | list of text | For organising links. |
| `domain` | text | One of your domains. Your default if left out. |

```sh
curl -X POST http://your-server/api/links \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","slug":"hello","tags":["demo"]}'
```

Errors come back as `{"error": "What went wrong"}` with a `4xx` status.

<br>

## Backups

Everything is stored in the `shortify-data` volume: the database, shared files and any HTTPS certificate. Back up that volume.

**Settings > Storage and backup** can also download a copy of the database. That copy holds your links, stats, settings, password hash, two-factor key and any tunnel token, so keep it safe. It doesn't include shared files.

To restore a database backup, stop the container, replace `shortify.db` in the volume with the backup, delete any `shortify.db-wal` and `shortify.db-shm` next to it, and start the container again.

<br>

## Disclaimer

This project is not associated with Cloudflare, Inc. Cloudflare Tunnel support uses Cloudflare's own `cloudflared` program.

**Please note:** there is no guarantee against data loss while using Shortify, including links, shared text and files. Back up your data regularly.
