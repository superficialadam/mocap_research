# mocap_research

Thin deployment repo for running NVIDIA Kimodo on the Ubuntu 5090 box at `adam-Ultra-930`.

## What this repo does

- clones the upstream Kimodo code into `vendor/kimodo`
- installs Kimodo into a local `.venv`
- starts the text encoder and demo server on `0.0.0.0:7860`
- installs a local `closed-chain-ik-js` solver under `previz_solver_js/`
- starts a local previz solver service on `127.0.0.1:8765`
- keeps logs and PID files under this repo so the setup is repeatable

## Remote layout

Expected checkout path on the Ubuntu box:

`/home/adam/CODE/blenda/mocap_research`

## Prerequisites

Kimodo requires a Hugging Face token on the host because the text encoder pulls the LLM2Vec / Llama weights. The upstream docs expect the token at:

`~/.cache/huggingface/token`

If it is missing, log in once on the Ubuntu box:

```bash
python3 -m venv ~/.hf-cli
source ~/.hf-cli/bin/activate
pip install --upgrade pip huggingface_hub[cli]
hf auth login
deactivate
```

## Bootstrap

```bash
./scripts/bootstrap_remote.sh
```

This will:

1. clone or update `nv-tlabs/kimodo`
2. clone or update `nv-tlabs/kimodo-viser`
3. apply local Kimodo patches from `patches/`
4. create `.venv`
5. install GPU PyTorch for CUDA 12.8
6. install Kimodo with demo extras
7. install `closed-chain-ik-js` solver dependencies with `npm`

Authenticate Hugging Face after bootstrap:

```bash
./scripts/login_huggingface.sh
```

## Start / Stop / Status

Start Kimodo:

```bash
./scripts/start_kimodo_demo.sh
```

Stop Kimodo:

```bash
./scripts/stop_kimodo_demo.sh
```

Inspect status:

```bash
./scripts/status_kimodo_demo.sh
```

## Public Access

To put Kimodo behind Google Workspace login and expose it through Tailscale Funnel:

```bash
./scripts/install_oauth2_proxy.sh
cp config/oauth2-proxy.env.example config/oauth2-proxy.env
./scripts/start_public_gateway.sh
```

Full Google OAuth and Funnel instructions are in:

`docs/PUBLIC_ACCESS.md`

## Reboot Persistence

To install user `systemd` services so Kimodo, the previz solver, and `oauth2-proxy` restart automatically:

```bash
./scripts/install_systemd_user_services.sh
systemctl --user restart kimodo-previz-solver.service kimodo-text-encoder.service kimodo-demo.service oauth2-proxy.service
```

To make those user services start after a full reboot without an interactive login, enable lingering once:

```bash
sudo loginctl enable-linger "$USER"
```

## Access

The demo listens on:

- `http://127.0.0.1:7860` on the Ubuntu host
- `http://<tailscale-ip>:7860` from devices on the same Tailscale tailnet

Get the current tailnet IP with:

```bash
tailscale ip -4 | head -n1
```

Kimodo upstream references:

- Project page: <https://research.nvidia.com/labs/sil/projects/kimodo/>
- Docs: <https://research.nvidia.com/labs/sil/projects/kimodo/docs/>
- Source: <https://github.com/nv-tlabs/kimodo>
