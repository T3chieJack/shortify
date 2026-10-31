# Changelog

## 1.1.0

- Two-factor login with an authenticator app, recovery codes, and a server command to turn it off if you're locked out
- An optional updater container, which adds an update button and a schedule to Settings, and rolls back if a new version fails to start
- Settings now shows which version you're running

## 1.0.1

- The container image is now also published to Docker Hub as `techiejack/shortify`

## 1.0.0

The first release.

### Links

- Short links with custom or random endings, bulk add, tags, search and filters
- Text sharing up to 1 MB, and file sharing up to 100 MB by default
- PINs, expiry dates, click limits and one-time links
- QR codes, and link previews by adding `+` to a short link
- Multiple domains, with a default and swapping at any time

### Running it

- One Docker container for Intel/AMD and ARM, with no npm dependencies
- First-run account setup, protected by a code from the container logs
- Optional HTTPS through Cloudflare Tunnel, your own reverse proxy, or your own certificate
- Database backup download, and storage use in Settings

### Advanced mode

- Off by default
- Analytics, per-link stats and CSV export, without storing IP addresses
- An API with revocable keys
