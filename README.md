# Tecateca Kenya: backend

Zero dependencies. Needs Node 22.13 or newer (uses the built-in SQLite). Data lives in one file: `data/tecateca.db`.

## Run it locally
    cp .env.example .env     # leave MPESA_MOCK=1 for now
    npm start                # http://localhost:3000
    npm test                 # 18 end-to-end checks, mock M-Pesa

Admin sign-in is the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`. Partner links look like `/r/CODE`.

## What is built
Products and stock, guest and customer checkout, M-Pesa STK Push with callback, order status polling, referral cookie (30 days), partner applications and approval, commissions (rate x product subtotal, never delivery, never on a partner's own order), payouts marked by admin, pop-up events, rate limiting, hashed passwords, CSRF and security headers.

## Go live with real M-Pesa
1. Create an app at developer.safaricom.co.ke and enable Lipa Na M-Pesa Online. Go-live needs your Paybill/Till, passkey and Safaricom approval.
2. Set `MPESA_MOCK=0`, `MPESA_ENV=production`, `MPESA_KEY`, `MPESA_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `BASE_URL` (public https address) and a long random `MPESA_CALLBACK_SECRET`.
3. Test first with `MPESA_ENV=sandbox` and Safaricom's test shortcode, then with a real KES 10 product.
Safaricom does not sign callbacks, so the callback URL contains your secret, the amount is re-checked, and the status endpoint queries Daraja as a backup.

## Easiest deploy for a beginner: Render (about $7 a month)
Vercel will not work for this project: it runs short-lived functions with no permanent disk, and this server keeps its database in a file.
1. Make a free GitHub account, create a new private repository, and upload everything in this folder (drag and drop works).
2. Make a Render account (render.com), click New > Blueprint, and pick that repository. Render reads `render.yaml` for you.
3. When asked, enter `ADMIN_EMAIL`, `ADMIN_PASSWORD` (a long passphrase) and `BASE_URL`. Use `https://tecateca.onrender.com` for now. If that name is taken, use whatever address Render shows and update `BASE_URL` after the first deploy.
4. Open your address. Admin is at `/#/admin`, partners at `/#/partners`. Keep `MPESA_MOCK=1` until you have Safaricom credentials.
5. Add your own domain later under Settings > Custom Domains.

## Deploy on a VPS (Ubuntu)
    sudo adduser --system --group tecateca && sudo mkdir /opt/tecateca   # copy this folder there, chown to tecateca
    # /etc/systemd/system/tecateca.service
    [Unit]
    Description=Tecateca Kenya
    After=network.target
    [Service]
    User=tecateca
    WorkingDirectory=/opt/tecateca
    ExecStart=/usr/bin/node server.js
    Restart=always
    [Install]
    WantedBy=multi-user.target
    # then: sudo systemctl enable --now tecateca

Nginx in front (add `TRUST_PROXY=1` to `.env`), then `sudo certbot --nginx -d shop.yourbrand.co.ke`:

    server { server_name shop.yourbrand.co.ke; location / { proxy_pass http://127.0.0.1:3000; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header Host $host; } }

Backups: run `sqlite3 /opt/tecateca/data/tecateca.db ".backup '/backups/tt-$(date +%F).db'"` nightly from cron.

## Before launch
Replace placeholder prices and stock in the admin API, set real delivery fees in `DELIVERY`, and keep `NODE_ENV=production` so the server refuses to start with missing secrets.
