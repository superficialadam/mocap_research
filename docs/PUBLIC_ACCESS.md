# Public Access With Google Login

This setup makes Kimodo publicly reachable on the internet through Tailscale Funnel, while only allowing users who authenticate with a Google account under `@blendalabs.com`.

Architecture:

- `Kimodo` stays on `127.0.0.1:7860`
- `oauth2-proxy` listens on `127.0.0.1:4180`
- `tailscale funnel` publishes `https://<device>.<tailnet>.ts.net`
- `oauth2-proxy` allows only `@blendalabs.com` logins before proxying to Kimodo

## 1. Prepare the Ubuntu host

On the 5090 box:

```bash
cd ~/CODE/blenda/mocap_research
./scripts/install_oauth2_proxy.sh
cp config/oauth2-proxy.env.example config/oauth2-proxy.env
chmod 600 config/oauth2-proxy.env
```

Generate a cookie secret:

```bash
python3 -c 'import os,base64; print(base64.urlsafe_b64encode(os.urandom(32)).decode())'
```

## 2. Create the Google OAuth app

Use a Google account that can administer the Blendalabs Google Workspace project.

Open these dashboards:

- Project creation: <https://console.cloud.google.com/projectcreate>
- Google Auth Platform branding: <https://console.cloud.google.com/auth/branding>
- Google Auth Platform audience: <https://console.cloud.google.com/auth/audience>
- Google Auth Platform clients: <https://console.cloud.google.com/auth/clients>

Create or select a project for Kimodo auth.

### Branding page

On the Branding page:

1. Set **App name** to something like `Blendalabs Kimodo`.
2. Set **User support email** to a monitored `@blendalabs.com` address.
3. Leave logo optional for now.
4. If Google asks for app domain links, use your public company URLs.

### Audience page

On the Audience page:

1. If Google offers **Internal**, choose `Internal`.
2. If `Internal` is not available, use `External`.
3. Publish only after you are ready.

Even if the app is `External`, the runtime gate still happens in `oauth2-proxy` with `--email-domain=blendalabs.com`.

### Clients page

Create an OAuth client:

1. Click `Create client`.
2. Choose **Web application**.
3. Name it `Kimodo Funnel`.
4. Add this **Authorized redirect URI**:

   `https://adam-ultra-930.tail7b560c.ts.net/oauth2/callback`

5. Add this **Authorized JavaScript origin**:

   `https://adam-ultra-930.tail7b560c.ts.net`

6. Create the client.
7. Copy the **Client ID**.
8. Copy the **Client secret** immediately and store it safely.

## 3. Fill the local config

Edit `config/oauth2-proxy.env` on the Ubuntu host:

```bash
OAUTH2_PROXY_CLIENT_ID="your-client-id.apps.googleusercontent.com"
OAUTH2_PROXY_CLIENT_SECRET="your-client-secret"
OAUTH2_PROXY_COOKIE_SECRET="your-generated-cookie-secret"
OAUTH2_PROXY_EMAIL_DOMAIN="blendalabs.com"
PUBLIC_HOST="adam-ultra-930.tail7b560c.ts.net"
KIMODO_UPSTREAM_URL="http://127.0.0.1:7860"
OAUTH2_PROXY_HTTP_ADDRESS="127.0.0.1:4180"
```

## 4. Start Kimodo and the gateway

```bash
cd ~/CODE/blenda/mocap_research
./scripts/start_kimodo_demo.sh
./scripts/start_public_gateway.sh
```

Check status:

```bash
./scripts/status_kimodo_demo.sh
./scripts/status_public_gateway.sh
```

If everything is healthy, the public URL is:

`https://adam-ultra-930.tail7b560c.ts.net`

## 5. Troubleshooting

If Google rejects the redirect URI:

- verify the redirect URI matches exactly
- wait a few minutes after editing the Google client
- confirm the host is HTTPS and not an IP address

If the login page loops:

- restart the gateway after any config change
- inspect `logs/oauth2-proxy.log`
- confirm Funnel points to port `4180` and Kimodo is still on `7860`

If you need to stop the public endpoint:

```bash
./scripts/stop_public_gateway.sh
```

## References

- Tailscale Funnel docs: <https://tailscale.com/docs/features/tailscale-funnel>
- Funnel CLI examples: <https://tailscale.com/docs/reference/examples/funnel>
- oauth2-proxy Google provider docs: <https://oauth2-proxy.github.io/oauth2-proxy/configuration/providers/google/>
- oauth2-proxy configuration overview: <https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/>
- Google OAuth web apps: <https://developers.google.com/identity/protocols/oauth2/web-server>
- Google OAuth client management: <https://support.google.com/cloud/answer/15549257>
