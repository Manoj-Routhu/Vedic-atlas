"""`veda pair` and `veda devices` - pair a phone, list paired phones, revoke one.

They call the server's loopback-only device routes (the registry lives in the server process, so a revoke
takes effect immediately). Nothing here prints a device token: the phone receives it once, at pairing.
"""

from __future__ import annotations

from urllib.parse import urlencode

import httpx
from rich.console import Console
from rich.table import Table

from controller.cli.client import VedaClient

_LOOPBACK = ("127.0.0.1", "localhost", "::1")


def _confirm_approve(console: Console) -> bool:
    console.print(
        "[yellow]This phone will be able to APPROVE or DENY actions Veda asks permission for "
        "(sending mail, running commands, ...).[/yellow]"
    )
    try:
        return input("Allow that for this phone? [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:
        return False


def cmd_pair(client: VedaClient, *, allow_approve: bool = False) -> int:
    console = Console()
    if allow_approve and not _confirm_approve(console):
        console.print("[dim]cancelled - nothing was created[/dim]")
        return 1
    try:
        info = client.create_pairing_code(allow_approve=allow_approve)
    except httpx.HTTPError as e:
        console.print(f"[red]could not create a pairing code:[/red] {e}")
        return 1

    uri = "veda://pair?" + urlencode({"host": info["host"], "port": info["port"], "code": info["code"]})
    console.print(f"\nPairing code: [bold]{info['code']}[/bold]   (valid {info['expires_in_s']} s, single use)")
    console.print(f"Phone connects to: {info['host']}:{info['port']}    permissions: {', '.join(info['scopes'])}")
    console.print(f"[dim]{uri}[/dim]")
    try:
        import qrcode   # optional: `pip install qrcode`

        qr = qrcode.QRCode(border=1)
        qr.add_data(uri)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    except ImportError:
        console.print("[dim](install `qrcode` to show this as a scannable QR; the code and address above work as they are)[/dim]")

    if info.get("bind_host") in _LOOPBACK:
        console.print(
            "\n[yellow]This server only listens on this machine, so a phone cannot reach it.[/yellow] "
            "Stop it and start it with: [bold]veda server --lan[/bold]"
        )
    return 0


def cmd_devices(client: VedaClient, action: str, device_id: str | None) -> int:
    console = Console()
    if action == "revoke":
        if not device_id:
            console.print("[red]usage: veda devices revoke <id>[/red]")
            return 2
        if client.revoke_device(device_id):
            console.print(f"revoked {device_id}")
            return 0
        console.print(f"[red]no paired device {device_id!r}[/red]")
        return 1
    if action != "list":
        console.print("[red]usage: veda devices [list | revoke <id>][/red]")
        return 2
    devices = client.list_devices()
    if not devices:
        console.print("[dim]no paired devices - `veda pair` to add one[/dim]")
        return 0
    table = Table("id", "name", "permissions", "paired", "last seen")
    for d in devices:
        table.add_row(d["id"], d["name"], ", ".join(d["scopes"]), d["created_at"], d["last_seen"] or "never")
    console.print(table)
    return 0
